#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-state-core-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-state-core-$$
mkdir "$tmp"

cleanup() {
	tmux -L "$socket" kill-server >/dev/null 2>&1 || :
	rm -rf "$tmp"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

assert_equal() {
	[ "$1" = "$2" ] || fail "$3 (expected '$1', got '$2')"
}

tmux_test() {
	tmux -L "$socket" "$@"
}

tmux_test -f /dev/null new-session -d -s state-core
set -- $(tmux_test display-message -p '#{session_id} #{window_id} #{pane_id} #{socket_path}')
session=$1
window=$2
pane=$3
socket_path=$4
server_tmux=$socket_path,$$,0
option() {
	tmux_test show-option -sqv "$1"
}
core() {
	TMUX="$server_tmux" TMUX_PANE="$pane" "$root/scripts/state-core" "$@"
}

for option_value in \
	running-glyph:R running-style: \
	waiting-glyph:W waiting-style: \
	completed-glyph:C completed-style: \
	failed-glyph:F failed-style: \
	unread-style:reverse; do
	name=${option_value%%:*}
	value=${option_value#*:}
	tmux_test set-option -g "@tmux-agents-status-$name" "$value"
done

owner=pi:11111111-1111-4111-8111-111111111111
turn=t:22222222-2222-4222-8222-222222222222
state_option=@tmux-agents-status-state-$pane
ack_option=@tmux-agents-status-ack-$pane

core 1 claim "$owner" "pid:$$"
assert_equal '' "$(option "$state_option")" 'an incompatible protocol major is a no-op'

core 2 claim "$owner" "pid:$$"
assert_equal "v2|$owner|pid:$$|-|none|-|-|-" "$(option "$state_option")" 'claim establishes ownership without visible state'
assert_equal '' "$(option "$ack_option")" 'claim clears prior acknowledgement'

core 2 start "$owner" "$turn"
running="v2|$owner|pid:$$|$turn|running|-|-|-"
assert_equal "$running" "$(option "$state_option")" 'start publishes strict v2 running state'
assert_equal '#[default] R' "$(TMUX="$server_tmux" "$root/scripts/render-window" "$session" "$window" "$pane")" 'the renderer exposes core-published running state'
core 2 start "$owner" "$turn"
assert_equal "$running" "$(option "$state_option")" 'a replayed start is idempotent'
core 2 claim "$owner" "pid:$$"
assert_equal "$running" "$(option "$state_option")" 'a replayed ownership claim preserves current state'

core 2 wait-open "$owner" "$turn" request-b
waiting_b=$(option "$state_option")
waiting_generation=$(printf '%s\n' "$waiting_b" | awk -F '|' '{ print $6 }')
case $waiting_generation in g:[0-9a-f][0-9a-f]*) ;; *) fail 'waiting receives a core-generated alert generation' ;; esac
assert_equal "v2|$owner|pid:$$|$turn|waiting|$waiting_generation|running|request-b" "$waiting_b" 'the first request opens a waiting episode'
tmux_test set-option -s "$ack_option" "$waiting_generation"
core 2 wait-open "$owner" "$turn" request-a
assert_equal "v2|$owner|pid:$$|$turn|waiting|$waiting_generation|running|request-a,request-b" "$(option "$state_option")" 'pending requests are sorted under one generation'
assert_equal "$waiting_generation" "$(option "$ack_option")" 'additional requests preserve acknowledgement for the waiting episode'
core 2 wait-open "$owner" "$turn" request-a
assert_equal "v2|$owner|pid:$$|$turn|waiting|$waiting_generation|running|request-a,request-b" "$(option "$state_option")" 'a replayed request is idempotent'
core 2 wait-close "$owner" "$turn" request-a
assert_equal "v2|$owner|pid:$$|$turn|waiting|$waiting_generation|running|request-b" "$(option "$state_option")" 'closing one request retains waiting'
assert_equal "$waiting_generation" "$(option "$ack_option")" 'partial request closure preserves acknowledgement for the waiting episode'
core 2 wait-close "$owner" "$turn" request-b
assert_equal "$running" "$(option "$state_option")" 'closing the last request resumes running'

core 2 wait-open "$owner" "$turn" request-c
waiting_again=$(option "$state_option")
waiting_generation_again=$(printf '%s\n' "$waiting_again" | awk -F '|' '{ print $6 }')
[ "$waiting_generation_again" != "$waiting_generation" ] || fail 'leaving and re-entering waiting creates a fresh generation'
core 2 finish "$owner" "$turn" completed
completed=$(option "$state_option")
completed_generation=$(printf '%s\n' "$completed" | awk -F '|' '{ print $6 }')
assert_equal "v2|$owner|pid:$$|$turn|completed|$completed_generation|-|-" "$completed" 'finish clears requests and publishes a terminal outcome'
[ "$completed_generation" != "$waiting_generation_again" ] || fail 'terminal outcome after waiting creates a fresh generation'
assert_equal '' "$(option "$ack_option")" 'an unseen terminal outcome remains unread'
core 2 finish "$owner" "$turn" completed
assert_equal "$completed" "$(option "$state_option")" 'a replayed finish does not re-arm the outcome'
core 2 start "$owner" "$turn"
assert_equal "$completed" "$(option "$state_option")" 'an exact terminal turn cannot be reopened directly'
core 2 dismiss-terminal "$owner"
assert_equal "v2|$owner|pid:$$|$turn|none|-|-|-" "$(option "$state_option")" 'approved repair can dismiss an obsolete terminal state'
core 2 start "$owner" "$turn"
assert_equal "$running" "$(option "$state_option")" 'dismissal allows approved same-turn activity to resume running'

old_turn=t:33333333-3333-4333-8333-333333333333
core 2 start "$owner" "$old_turn"
new_running=$(option "$state_option")
core 2 finish "$owner" "$turn" failed
assert_equal "$new_running" "$(option "$state_option")" 'a stale turn cannot finish the current turn'
core 2 release "$owner" interrupted
interrupted=$(option "$state_option")
interrupted_generation=$(printf '%s\n' "$interrupted" | awk -F '|' '{ print $6 }')
assert_equal "v2|-|-|$old_turn|failed|$interrupted_generation|-|-" "$interrupted" 'interrupted release fails active work and removes ownership'
core 2 start "$owner" "$old_turn"
assert_equal "$interrupted" "$(option "$state_option")" 'events from a released owner are ignored'

replacement=pi:44444444-4444-4444-8444-444444444444
replacement_turn=t:55555555-5555-4555-8555-555555555555
tmux_test set-option -s "$ack_option" "$interrupted_generation"
core 2 claim "$replacement" -
assert_equal "v2|$replacement|-|-|none|-|-|-" "$(option "$state_option")" 'a claim atomically replaces previous ownership and state'
assert_equal '' "$(option "$ack_option")" 'replacement clears previous acknowledgement'
core 2 finish "$replacement" "$replacement_turn" completed
terminal_without_start=$(option "$state_option")
terminal_without_start_generation=$(printf '%s\n' "$terminal_without_start" | awk -F '|' '{ print $6 }')
assert_equal "v2|$replacement|-|$replacement_turn|completed|$terminal_without_start_generation|-|-" "$terminal_without_start" 'a terminal outcome may be reported without a preceding start'
core 2 release "$replacement" interrupted
assert_equal "v2|-|-|$replacement_turn|completed|$terminal_without_start_generation|-|-" "$(option "$state_option")" 'release preserves a terminal outcome while removing ownership'

core 2 claim "$replacement" -
core 2 release "$replacement" clear
assert_equal '' "$(option "$state_option")" 'clear release compare-and-clears an owned no-report record'
assert_equal '' "$(option "$ack_option")" 'clear release removes acknowledgement'

tmux_test set-option -s "$state_option" 'v1|99|legacy-owner|running|-'
tmux_test set-option -s "$ack_option" 'legacy-ack'
core 2 claim "$owner" "pid:$$"
assert_equal "v2|$owner|pid:$$|-|none|-|-|-" "$(option "$state_option")" 'a valid claim repairs malformed or legacy ownership'
assert_equal '' "$(option "$ack_option")" 'repairing ownership removes malformed acknowledgement'
legacy_repaired=$(option "$state_option")
core 2 start 'owner with spaces' "$turn"
core 9 start "$owner" "$turn"
assert_equal "$legacy_repaired" "$(option "$state_option")" 'malformed input and future protocols cannot mutate state'

mkdir "$tmp/failing-bin"
cat >"$tmp/failing-bin/tmux" <<'EOF'
#!/bin/sh
printf 'raw-secret command output\n' >&2
exit 1
EOF
chmod +x "$tmp/failing-bin/tmux"
if PATH="$tmp/failing-bin:$PATH" TMUX=missing TMUX_PANE=%1 \
	"$root/scripts/state-core" 2 claim "$owner" - >"$tmp/core-out" 2>"$tmp/core-error"; then
	fail 'core persistence failures return a bounded failure result to adapters'
fi
assert_equal '' "$(cat "$tmp/core-out")" 'core failures expose no stdout'
assert_equal 'tmux-agents-status: state-core: claim failed' "$(cat "$tmp/core-error")" 'core failures expose only a bounded operation diagnostic'
PATH="$tmp/failing-bin:$PATH" TMUX=missing TMUX_PANE=%1 \
	"$root/scripts/state-core" 2 'raw-secret-operation' >"$tmp/core-out" 2>"$tmp/core-error"
assert_equal '' "$(cat "$tmp/core-error")" 'unknown operations cannot enter diagnostics'

printf 'ok - shared v2 core enforces lifecycle, ownership, and correlation\n'
