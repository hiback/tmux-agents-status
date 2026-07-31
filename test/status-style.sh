#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-style-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-style-$$
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

wait_for_style() {
	expected_text=$1
	expected_styles=$2
	label=$3
	tries=0
	while [ "$tries" -lt 80 ]; do
		tmux_test capture-pane -p -e -t "$observer_pane" >"$tmp/status"
		if node "$root/test/assert-status-style.mjs" "$tmp/status" "$expected_text" "$expected_styles" >/dev/null 2>&1; then
			return 0
		fi
		tries=$((tries + 1))
		sleep .025
	done
	node "$root/test/assert-status-style.mjs" "$tmp/status" "$expected_text" "$expected_styles" || :
	fail "$label"
}

tmux_test -f /dev/null new-session -d -s style-current -x 80 -y 24
set -- $(tmux_test display-message -p -t style-current: '#{session_id} #{window_id} #{pane_id}')
session=$1
window=$2
tmux_test split-window -d -t "$session:$window"
tmux_test split-window -d -t "$session:$window"
set -- $(tmux_test list-panes -t "$session:$window" -F '#{pane_id}')
running_pane=$1
waiting_pane=$2
completed_pane=$3

tmux_test run-shell "$root/tmux-agents-status.tmux"
tmux_test set-option -g status-interval 0
tmux_test set-option -g status-style 'fg=black,bg=white'
tmux_test set-option -g @tmux-agents-status-running-glyph R
tmux_test set-option -g @tmux-agents-status-running-style 'fg=green'
tmux_test set-option -g @tmux-agents-status-waiting-glyph W
tmux_test set-option -g @tmux-agents-status-waiting-style 'fg=green'
tmux_test set-option -g @tmux-agents-status-completed-glyph C
tmux_test set-option -g @tmux-agents-status-completed-style ''
tmux_test set-option -g @tmux-agents-status-failed-glyph ''
tmux_test set-option -g @tmux-agents-status-unread-style 'fg=yellow,nobold,reverse'

incarnation=11111111-1111-4111-8111-111111111111
waiting_generation=g:22222222222222222222222222222222
completed_generation=g:33333333333333333333333333333333
tmux_test set-option -s "@tmux-agents-status-state-$running_pane" "v2|$incarnation|pid:$$|-|running|-|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$waiting_pane" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request"
tmux_test set-option -s "@tmux-agents-status-state-$completed_pane" "v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$completed_pane" "$completed_generation"

tmux_test set-option -g 'status-format[0]' '#[fg=red,bg=blue,bold]a#{E:@tmux-agents-status-window}z'
observer_pane=$(tmux_test new-session -d -s style-observer -x 80 -y 24 -P -F '#{pane_id}' \
	"TMUX= TERM=xterm-256color tmux -L '$socket' attach-session -t style-current")
tries=0
while [ "$tries" -lt 80 ]; do
	status_client=$(tmux_test list-clients -t style-current -F '#{client_name}')
	[ -z "$status_client" ] || break
	tries=$((tries + 1))
	sleep .025
done
[ -n "${status_client-}" ] || fail 'an attached status client is available'
tmux_test refresh-client -S -t "$status_client"

window_styles='[
 {"offset":0,"fg":1,"bg":4,"bold":true,"reverse":false},
 {"offset":1,"fg":1,"bg":4,"bold":true,"reverse":false},
 {"offset":2,"fg":2,"bg":4,"bold":true,"reverse":false},
 {"offset":3,"fg":3,"bg":4,"bold":false,"reverse":true},
 {"offset":4,"fg":1,"bg":4,"bold":true,"reverse":false},
 {"offset":5,"fg":1,"bg":4,"bold":true,"reverse":false}
]'
wait_for_style 'a RWCz' "$window_styles" 'window status composition inherits overlays and restores the entry style'

# Other-session text stays on the entry baseline while lifecycle glyphs add overlays.
tmux_test new-session -d -s away
tmux_test split-window -d -t away:
set -- $(tmux_test list-panes -t away: -F '#{pane_id}')
other_running_pane=$1
other_waiting_pane=$2
tmux_test set-option -s "@tmux-agents-status-state-$other_running_pane" "v2|$incarnation|pid:$$|-|running|-|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$other_waiting_pane" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request"
tmux_test set-option -su "@tmux-agents-status-ack-$other_waiting_pane" 2>/dev/null || :
tmux_test set-option -g @tmux-agents-status-running-style 'fg=yellow'
tmux_test set-option -g @tmux-agents-status-waiting-style 'bg=white'
tmux_test set-option -g @tmux-agents-status-unread-style 'fg=red,nounderscore,reverse'
tmux_test set-option -g 'status-format[0]' '#[fg=cyan,bg=magenta,underscore]b#{E:@tmux-agents-status-other-sessions}y'
tmux_test refresh-client -S -t "$status_client"
other_styles='[
 {"offset":0,"fg":6,"bg":5,"underscore":true,"reverse":false},
 {"offset":1,"fg":3,"bg":5,"underscore":true,"reverse":false},
 {"offset":2,"fg":6,"bg":5,"underscore":true,"reverse":false},
 {"offset":3,"fg":6,"bg":5,"underscore":true,"reverse":false},
 {"offset":4,"fg":6,"bg":5,"underscore":true,"reverse":false},
 {"offset":8,"fg":6,"bg":5,"underscore":true,"reverse":false},
 {"offset":9,"fg":1,"bg":7,"underscore":false,"reverse":true},
 {"offset":10,"fg":6,"bg":5,"underscore":true,"reverse":false},
 {"offset":11,"fg":6,"bg":5,"underscore":true,"reverse":false}
]'
wait_for_style 'bR1 away:W y' "$other_styles" 'other-session status composition inherits overlays and restores the entry style'

# Mixed public styles keep visual terms without taking layout or default ownership.
tmux_test set-option -su "@tmux-agents-status-state-$waiting_pane"
tmux_test set-option -su "@tmux-agents-status-state-$completed_pane"
tmux_test set-option -g @tmux-agents-status-running-style 'fg=green,push-default,bg=yellow,align=right,bold,unknown'
tmux_test set-option -g 'status-format[0]' '#[fg=red,bg=blue,reverse]c#{E:@tmux-agents-status-window}v'
tmux_test refresh-client -S -t "$status_client"
mixed_styles='[
 {"offset":0,"fg":1,"bg":4,"bold":false,"reverse":true},
 {"offset":1,"fg":1,"bg":4,"bold":false,"reverse":true},
 {"offset":2,"fg":2,"bg":3,"bold":true,"reverse":true},
 {"offset":3,"fg":1,"bg":4,"bold":false,"reverse":true}
]'
wait_for_style 'c Rv' "$mixed_styles" 'mixed visual styles cannot affect enclosing layout or restoration'

# An explicit caller default selects the old isolated baseline without a plugin option.
tmux_test set-option -g @tmux-agents-status-running-style ''
tmux_test set-option -g 'status-format[0]' '#[fg=red,bg=blue]d#[default]#{E:@tmux-agents-status-window}x'
tmux_test refresh-client -S -t "$status_client"
isolated_styles='[
 {"offset":0,"fg":1,"bg":4},
 {"offset":1,"fg":0,"bg":7},
 {"offset":2,"fg":0,"bg":7},
 {"offset":3,"fg":0,"bg":7}
]'
wait_for_style 'd Rx' "$isolated_styles" 'caller default selects the tmux baseline for a fragment'

# Empty and failing renderers emit no scope, so they cannot replace a caller push.
tmux_test set-option -su "@tmux-agents-status-state-$running_pane"
tmux_test set-option -g 'status-format[0]' '#[push-default]#[fg=red,bg=blue]e#{E:@tmux-agents-status-window}#[default]f#[pop-default]'
tmux_test refresh-client -S -t "$status_client"
empty_styles='[
 {"offset":0,"fg":1,"bg":4},
 {"offset":1,"fg":0,"bg":7}
]'
wait_for_style 'ef' "$empty_styles" 'an empty window fragment is a complete style no-op'

tmux_test set-option -s "@tmux-agents-status-state-$running_pane" "v2|$incarnation|pid:$$|-|running|-|-|-"
tmux_test set-option -g @tmux-agents-status-running-style 'fg=red
invalid'
tmux_test set-option -g 'status-format[0]' '#[push-default]#[fg=cyan,bg=magenta]g#{E:@tmux-agents-status-window}#[default]h#[pop-default]'
tmux_test refresh-client -S -t "$status_client"
failure_styles='[
 {"offset":0,"fg":6,"bg":5},
 {"offset":1,"fg":0,"bg":7}
]'
wait_for_style 'gh' "$failure_styles" 'a failed window renderer is a complete style no-op'

printf 'ok - status fragments compose with the effective enclosing style\n'
