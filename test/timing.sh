#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-timing-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-timing-$$
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

tmux_test() {
	tmux -L "$socket" "$@"
}

now_ms() {
	node -p 'Date.now()'
}

status_matches() {
	tmux_test capture-pane -p -e -t "$observer_pane" >"$tmp/status"
	grep -F "$1" "$tmp/status" >/dev/null
}

wait_for_status() {
	expected=$1
	started=$2
	label=$3
	while :; do
		if status_matches "$expected"; then
			elapsed=$(($(now_ms) - started))
			[ "$elapsed" -le "$bound_ms" ] || fail "$label took ${elapsed}ms (bound ${bound_ms}ms)"
			[ "$elapsed" -le "$max_elapsed" ] || max_elapsed=$elapsed
			return 0
		fi
		elapsed=$(($(now_ms) - started))
		[ "$elapsed" -le "$bound_ms" ] || fail "$label took ${elapsed}ms (bound ${bound_ms}ms)"
		sleep .025
	done
}

tmux_test -f /dev/null new-session -d -s timing
pane=$(tmux_test display-message -p '#{pane_id}')
away_pane=$(tmux_test split-window -d -P -F '#{pane_id}')
tmux_test set-option -g status-interval 0
tmux_test run-shell "$root/tmux-agents-status.tmux"
tmux_test set-option -g @tmux-agents-status-running-glyph R
tmux_test set-option -g @tmux-agents-status-running-style ''
tmux_test set-option -g @tmux-agents-status-waiting-glyph W
tmux_test set-option -g @tmux-agents-status-waiting-style ''
tmux_test set-option -g @tmux-agents-status-unread-style reverse
tmux_test set-option -g 'status-format[0]' 'TAS[#{E:@tmux-agents-status-window}]SAT'

# A nested tmux client supplies a real portable PTY on every supported tmux.
# Capturing its screen observes the installed fragment through tmux's #() cache.
incarnation=11111111-1111-4111-8111-111111111111
generation=22222222-2222-4222-8222-222222222222
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v1|$$|$incarnation|running|-"
observer_pane=$(tmux_test new-session -d -s timing-observer -x 80 -y 24 -P -F '#{pane_id}' \
	"TMUX= TERM=xterm tmux -L '$socket' attach-session -t timing")
bound_ms=1500
max_elapsed=0
started=$(now_ms)
while :; do
	status_client=$(tmux_test list-clients -t timing -F '#{client_name}')
	[ -z "$status_client" ] || break
	elapsed=$(($(now_ms) - started))
	[ "$elapsed" -le "$bound_ms" ] || fail 'an attached status client appears within 1500ms'
	sleep .025
done
wait_for_status 'TAS[ R]SAT' "$started" 'initial format-cache prime'
tmux_test set-option -su "@tmux-agents-status-state-$pane"
tmux_test refresh-client -S -t "$status_client"
wait_for_status 'TAS[]SAT' "$(now_ms)" 'empty format-cache prime'
tmux_test select-pane -t "$away_pane"
max_elapsed=0

started=$(now_ms)
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v1|$$|$incarnation|running|-"
tmux_test refresh-client -S -t "$status_client"
wait_for_status 'TAS[ R]SAT' "$started" 'event-driven running state'

# Alert while away, then visit it: the installed hook persists acknowledgement
# and requests another status-only refresh without interval polling.
reverse_w=$(printf '\033[7mW')
started=$(now_ms)
tmux_test set-option -s "@tmux-agents-status-state-$pane" "v1|$$|$incarnation|waiting|$generation"
tmux_test refresh-client -S -t "$status_client"
wait_for_status "TAS[ $reverse_w" "$started" 'event-driven unread state'
started=$(now_ms)
tmux_test select-pane -t "$pane"
wait_for_status 'TAS[ W]SAT' "$started" 'event-driven acknowledgement'

[ "$(tmux_test show-option -gqv status-interval)" = 0 ] || fail 'status-interval remains zero'
[ "$(tmux_test show-option -sqv "@tmux-agents-status-ack-$pane")" = "$generation" ] || fail 'visit persists the observed generation'
printf 'ok - status-interval 0 updates the real status within %sms (observed max %sms)\n' "$bound_ms" "$max_elapsed"
