#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-client-attachment-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-client-attachment-$$
mkdir "$tmp"

cleanup() {
	[ -z "${client_pid-}" ] || kill "$client_pid" >/dev/null 2>&1 || :
	[ -z "${client_pid-}" ] || wait "$client_pid" 2>/dev/null || :
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

server_option() {
	tmux_test show-option -sqv "$1"
}

tmux_test -f /dev/null new-session -d -s attachment
away_pane=$(tmux_test display-message -p '#{pane_id}')
alert_pane=$(tmux_test split-window -d -P -F '#{pane_id}')
generation=g:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
tmux_test set-option -s "@tmux-agents-status-state-$alert_pane" "v2|owner:attachment|pid:$$|-|waiting|$generation|running|request"
tmux_test run-shell "$root/tmux-agents-status.tmux"
tmux_test select-pane -t "$away_pane"
tmux_test set-hook -ag client-attached 'wait-for -S tas-client-attached-observed'

fifo=$tmp/client-input
mkfifo "$fifo"
tmux -L "$socket" -C attach-session -t attachment <"$fifo" >"$tmp/client-output" 2>"$tmp/client-error" &
client_pid=$!
exec 9>"$fifo"
tmux_test wait-for tas-client-attached-observed
assert_equal '' "$(server_option "@tmux-agents-status-ack-$alert_pane")" 'attaching while an alert is only visible as an inactive split does not acknowledge it'

client=$(tmux_test list-clients -F '#{client_name}')
tmux_test set-hook -ag window-pane-changed 'wait-for -S tas-attached-pane-selected'
tmux_test select-pane -t "$alert_pane" \; wait-for tas-attached-pane-selected
assert_equal "$alert_pane" "$(tmux_test display-message -p -c "$client" '#{pane_id}')" 'the attached client makes the selected alert pane active'
assert_equal "$generation" "$(server_option "@tmux-agents-status-ack-$alert_pane")" 'the alert is acknowledged after it becomes active for an attached client'

printf 'ok - client attachment acknowledges only the active pane\n'
