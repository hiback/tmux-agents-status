#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-death-cleanup-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-death-cleanup-$$
mkdir "$tmp"

cleanup() {
	tmux -L "$socket" kill-server >/dev/null 2>&1 || :
	[ -z "${owner-}" ] || kill "$owner" >/dev/null 2>&1 || :
	[ -z "${owner-}" ] || wait "$owner" 2>/dev/null || :
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

tmux_test -f /dev/null new-session -d -s death-cleanup
set -- $(tmux_test display-message -p '#{session_id} #{window_id} #{pane_id} #{socket_path}')
session=$1
window=$2
pane=$3
socket_path=$4
for option in \
	running-glyph:R running-style: \
	waiting-glyph:W waiting-style: \
	completed-glyph:C completed-style: \
	failed-glyph:F failed-style: \
	unread-style:reverse; do
	name=${option%%:*}
	value=${option#*:}
	tmux_test set-option -g "@tmux-agents-status-$name" "$value"
done
server_tmux=$socket_path,$$,0
render() {
	TMUX="$server_tmux" "$root/scripts/render-window" "$session" "$window" "$pane"
}
server_option() {
	tmux_test show-option -sqv "$1"
}

incarnation=11111111-1111-4111-8111-111111111111
completed_generation=g:22222222222222222222222222222222
failed_generation=g:33333333333333333333333333333333
sleep 60 &
owner=$!
running="v2|$incarnation|pid:$owner|-|running|-|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$pane" "$running"
kill "$owner"
wait "$owner" 2>/dev/null || :
owner=
assert_equal '#[default] #[reverse]F#[default]' "$(render)" 'dead running derives an unread virtual failure'
assert_equal "$running" "$(server_option "@tmux-agents-status-state-$pane")" 'virtual failure rendering leaves stored state unchanged'
other_dead_pane=$(tmux_test new-session -d -s dead-other -P -F '#{pane_id}')
tmux_test set-option -s "@tmux-agents-status-state-$other_dead_pane" "$running"
assert_equal '#[default]dead-other:#[reverse]F#[default] ' "$(TMUX="$server_tmux" "$root/scripts/render-other-sessions" "$session")" 'other-session rendering exposes the same virtual failure'
tmux_test set-option -s "@tmux-agents-status-ack-$other_dead_pane" "d:$incarnation"
assert_equal '' "$(TMUX="$server_tmux" "$root/scripts/render-other-sessions" "$session")" 'other-session rendering hides an acknowledged virtual failure'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" "d:$incarnation"
assert_equal '#[default] F' "$(render)" 'acknowledged virtual failure remains visible without unread emphasis'

waiting="v2|$incarnation|pid:99999999|-|waiting|$completed_generation|running|request"
tmux_test set-option -s "@tmux-agents-status-state-$pane" "$waiting"
tmux_test set-option -su "@tmux-agents-status-ack-$pane"
assert_equal '#[default] #[reverse]F#[default]' "$(render)" 'dead waiting derives the same deterministic virtual failure'

completed="v2|$incarnation|pid:99999999|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$pane" "$completed"
assert_equal '#[default] #[reverse]C#[default]' "$(render)" 'dead completed preserves its recorded terminal state and generation'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$completed_generation"
assert_equal '#[default] C' "$(render)" 'acknowledged dead completed remains visible without unread emphasis'

failed="v2|$incarnation|pid:99999999|-|failed|$failed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$pane" "$failed"
tmux_test set-option -su "@tmux-agents-status-ack-$pane"
assert_equal '#[default] #[reverse]F#[default]' "$(render)" 'dead failed preserves its recorded terminal state and generation'

tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$completed_generation"
assert_equal '#[default] C' "$(render)" 'acknowledgement preserves a live terminal state'

cleanup_pane=$(tmux_test split-window -d -P -F '#{pane_id}')
tmux_test set-option -s "@tmux-agents-status-state-$cleanup_pane" "v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$cleanup_pane" "$completed_generation"
TMUX="$server_tmux" "$root/scripts/cleanup-pane" "$cleanup_pane"
assert_equal '' "$(server_option "@tmux-agents-status-state-$cleanup_pane")" 'pane cleanup removes state'
assert_equal '' "$(server_option "@tmux-agents-status-ack-$cleanup_pane")" 'pane cleanup removes acknowledgement after state'

live_state="v2|$incarnation|pid:$$|-|running|-|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$pane" "$live_state"
tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$failed_generation"
malformed_pane=$(tmux_test split-window -d -P -F '#{pane_id}')
tmux_test set-option -s "@tmux-agents-status-state-$malformed_pane" 'v1|malformed'
tmux_test set-option -s "@tmux-agents-status-ack-$malformed_pane" 'malformed-ack'
dead_pane=$(tmux_test split-window -d -P -F '#{pane_id}')
tmux_test set-option -s "@tmux-agents-status-state-$dead_pane" "$failed"
tmux_test set-option -su "@tmux-agents-status-ack-$dead_pane"
for stale in %999991 %999992; do
	tmux_test set-option -s "@tmux-agents-status-state-$stale" "$failed"
	tmux_test set-option -s "@tmux-agents-status-ack-$stale" "$failed_generation"
done
TMUX="$server_tmux" "$root/scripts/cleanup-stale"
for stale in %999991 %999992; do
	assert_equal '' "$(server_option "@tmux-agents-status-state-$stale")" 'startup cleanup removes stale state'
	assert_equal '' "$(server_option "@tmux-agents-status-ack-$stale")" 'startup cleanup removes stale acknowledgement'
done
assert_equal "$live_state" "$(server_option "@tmux-agents-status-state-$pane")" 'startup cleanup never changes live-owner state'
assert_equal "$failed_generation" "$(server_option "@tmux-agents-status-ack-$pane")" 'startup cleanup leaves live-owner acknowledgement unchanged'
assert_equal 'v1|malformed' "$(server_option "@tmux-agents-status-state-$malformed_pane")" 'startup cleanup preserves malformed records in existing panes'
assert_equal 'malformed-ack' "$(server_option "@tmux-agents-status-ack-$malformed_pane")" 'startup cleanup preserves acknowledgement in existing panes'
assert_equal "$failed" "$(server_option "@tmux-agents-status-state-$dead_pane")" 'startup cleanup preserves unacknowledged dead terminal state in an existing pane'

tmux_test set-hook -g pane-exited 'display-message user-pane-hook'
tmux_test set-option -s @tmux-agents-status-state-%999993 "$failed"
tmux_test set-option -s @tmux-agents-status-ack-%999993 "$failed_generation"
TMUX="$server_tmux" "$root/tmux-agents-status.tmux"
assert_equal '' "$(server_option @tmux-agents-status-state-%999993)" 'plugin startup invokes stale cleanup'
assert_equal 'pane-exited[1]' "$(server_option @tmux-agents-status-hook-pane-exited)" 'pane-exit hook ownership selector is installed'
cleanup_command='run-shell "#{q:@tmux-agents-status-root}/scripts/cleanup-pane #{q:hook_pane}"'
assert_equal "pane-exited[0] display-message user-pane-hook
pane-exited[1] $cleanup_command" "$(tmux_test show-hooks -g pane-exited)" 'pane-exit cleanup appends after a user hook'
TMUX="$server_tmux" "$root/tmux-agents-status.tmux"
assert_equal "pane-exited[0] display-message user-pane-hook
pane-exited[1] $cleanup_command" "$(tmux_test show-hooks -g pane-exited)" 'plugin reload does not duplicate pane-exit cleanup'

hook_pane=$(tmux_test split-window -d -P -F '#{pane_id}' 'sleep 60')
tmux_test set-option -s "@tmux-agents-status-state-$hook_pane" "$failed"
tmux_test set-option -s "@tmux-agents-status-ack-$hook_pane" "$failed_generation"
tmux_test send-keys -t "$hook_pane" C-c
tries=0
while [ "$tries" -lt 20 ] && { [ -n "$(server_option "@tmux-agents-status-state-$hook_pane")" ] || [ -n "$(server_option "@tmux-agents-status-ack-$hook_pane")" ]; }; do
	sleep .05
	tries=$((tries + 1))
done
assert_equal '' "$(server_option "@tmux-agents-status-state-$hook_pane")" 'pane exit removes state through the installed hook'
assert_equal '' "$(server_option "@tmux-agents-status-ack-$hook_pane")" 'pane exit removes acknowledgement through the installed hook'

relocated_root="$tmp/relocated root"
mkdir -p "$relocated_root/scripts"
cat >"$relocated_root/scripts/cleanup-pane" <<'EOF'
#!/bin/sh
tmux set-option -s @tmux-agents-status-cleanup-observed "$1"
EOF
chmod +x "$relocated_root/scripts/cleanup-pane"
tmux_test set-option -g @tmux-agents-status-root "$relocated_root"
relocated_pane=$(tmux_test split-window -d -P -F '#{pane_id}' 'sleep 60')
tmux_test send-keys -t "$relocated_pane" C-c
tries=0
while [ "$tries" -lt 20 ] && [ -z "$(server_option @tmux-agents-status-cleanup-observed)" ]; do
	sleep .05
	tries=$((tries + 1))
done
assert_equal "$relocated_pane" "$(server_option @tmux-agents-status-cleanup-observed)" 'pane-exit hook resolves the current root when invoked'

# tmux 3.0 reports a missing server option as success with empty output.
mkdir "$tmp/fake-tmux-3.0"
cat >"$tmp/fake-tmux-3.0/tmux" <<'EOF'
#!/bin/sh
case "$1:$2" in
display-message:-p) printf '3.0\n' ;;
show-option:-s|show-option:-sqv) : ;;
*) printf '%s\n' "$*" >>"$FAKE_TMUX_LOG" ;;
esac
EOF
chmod +x "$tmp/fake-tmux-3.0/tmux"
: >"$tmp/tmux-3.0-calls"
PATH="$tmp/fake-tmux-3.0:$PATH" FAKE_TMUX_LOG="$tmp/tmux-3.0-calls" "$root/tmux-agents-status.tmux"
ack_command='run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
for hook in window-pane-changed session-window-changed client-session-changed client-attached; do
	grep -Fq "set-hook -ag $hook $ack_command" "$tmp/tmux-3.0-calls" ||
		fail "tmux 3.0 missing-option semantics install the $hook acknowledgement hook"
done
grep -Fq 'set-hook -ag pane-exited run-shell "#{q:@tmux-agents-status-root}/scripts/cleanup-pane #{q:hook_pane}"' "$tmp/tmux-3.0-calls" ||
	fail 'tmux 3.0 missing-option semantics install the pane-exited cleanup hook'

printf 'ok - owner death derives failure and event cleanup removes stale records\n'
