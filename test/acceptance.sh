#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-acceptance-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-acceptance-$$
mkdir "$tmp"

cleanup() {
	tmux -L "$socket" kill-server >/dev/null 2>&1 || :
	[ -z "${control_pid-}" ] || kill "$control_pid" >/dev/null 2>&1 || :
	[ -z "${control_pid-}" ] || wait "$control_pid" 2>/dev/null || :
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

option() {
	tmux_test show-option -gqv "$1"
}

server_option() {
	tmux_test show-option -sqv "$1"
}

node "$root/test/pi-adapter.mjs"
node "$root/test/lifecycle.mjs"
node "$root/test/opencode-adapter.mjs"
node "$root/test/opencode-lifecycle.mjs"
"$root/test/state-core.sh"
"$root/test/acknowledge.sh"
"$root/test/client-attachment.sh"
"$root/test/death-cleanup.sh"
"$root/test/degradation.sh"
"$root/test/timing.sh"
"$root/test/uninstall.sh"

tmux_test -f /dev/null new-session -d -s acceptance
tmux_test set-hook -g window-pane-changed 'display-message user-hook'
tmux_test run-shell "$root/tmux-agents-status.tmux"

assert_equal "$root" "$(option @tmux-agents-status-root)" 'plugin root is installed'
assert_equal '2' "$(option @tmux-agents-status-protocol)" 'core protocol major is published'
assert_equal '#(#{q:@tmux-agents-status-root}/scripts/render-window #{q:session_id} #{q:window_id} #{q:pane_id})' "$(option @tmux-agents-status-window)" 'window fragment is installed'
assert_equal '#(#{q:@tmux-agents-status-root}/scripts/render-other-sessions #{q:session_id})' "$(option @tmux-agents-status-other-sessions)" 'other-sessions fragment is installed'
assert_equal '•' "$(option @tmux-agents-status-running-glyph)" 'running glyph default is installed'
assert_equal 'fg=cyan' "$(option @tmux-agents-status-running-style)" 'running style default is installed'
assert_equal '?' "$(option @tmux-agents-status-waiting-glyph)" 'waiting glyph default is installed'
assert_equal 'fg=yellow' "$(option @tmux-agents-status-waiting-style)" 'waiting style default is installed'
assert_equal '✓' "$(option @tmux-agents-status-completed-glyph)" 'completed glyph default is installed'
assert_equal 'fg=green' "$(option @tmux-agents-status-completed-style)" 'completed style default is installed'
assert_equal '!' "$(option @tmux-agents-status-failed-glyph)" 'failed glyph default is installed'
assert_equal 'fg=red' "$(option @tmux-agents-status-failed-style)" 'failed style default is installed'
assert_equal 'reverse,bold' "$(option @tmux-agents-status-unread-style)" 'unread style default is installed'

hook_command='run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'window-pane hook ownership selector is installed'
assert_equal 'session-window-changed[0]' "$(server_option @tmux-agents-status-hook-session-window-changed)" 'session-window hook ownership selector is installed'
assert_equal 'client-session-changed[0]' "$(server_option @tmux-agents-status-hook-client-session-changed)" 'client-session hook ownership selector is installed'
assert_equal 'client-attached[0]' "$(server_option @tmux-agents-status-hook-client-attached)" 'client-attached hook ownership selector is installed'
assert_equal "window-pane-changed[0] display-message user-hook
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'the pane-selection hook appends after a user handler'
assert_equal "session-window-changed[0] $hook_command" "$(tmux_test show-hooks -g session-window-changed)" 'the window-selection hook is installed'
assert_equal "client-session-changed[0] $hook_command" "$(tmux_test show-hooks -g client-session-changed)" 'the session-selection hook is installed'
assert_equal "client-attached[0] $hook_command" "$(tmux_test show-hooks -g client-attached)" 'the client-attachment hook is installed'

# Loading after user customization must preserve theme-owned formats and plugin overrides.
tmux_test set-option -g window-status-format 'custom window'
tmux_test set-option -g window-status-current-format 'custom current window'
tmux_test set-option -g status-right 'custom right'
tmux_test set-option -g @tmux-agents-status-window 'custom window fragment'
tmux_test set-option -g @tmux-agents-status-other-sessions 'custom other-sessions fragment'
tmux_test set-option -g @tmux-agents-status-running-glyph 'R'
tmux_test set-option -g @tmux-agents-status-running-style 'fg=white'
tmux_test set-option -g @tmux-agents-status-waiting-glyph 'W'
tmux_test set-option -g @tmux-agents-status-waiting-style 'fg=black'
tmux_test set-option -g @tmux-agents-status-completed-glyph 'C'
tmux_test set-option -g @tmux-agents-status-completed-style 'fg=blue'
tmux_test set-option -g @tmux-agents-status-failed-glyph ''
tmux_test set-option -g @tmux-agents-status-failed-style 'fg=magenta'
tmux_test set-option -g @tmux-agents-status-unread-style 'underscore'
tmux_test set-option -g @tmux-agents-status-root '/stale/root'

tmux_test run-shell "$root/tmux-agents-status.tmux"
tmux_test set-option -g @tmux-agents-status-root '/stale/root-again'
tmux_test run-shell "$root/tmux-agents-status.tmux"

assert_equal 'custom window' "$(option window-status-format)" 'window status format is unchanged'
assert_equal 'custom current window' "$(option window-status-current-format)" 'current window status format is unchanged'
assert_equal 'custom right' "$(option status-right)" 'right status format is unchanged'
assert_equal 'custom window fragment' "$(option @tmux-agents-status-window)" 'window fragment override is preserved'
assert_equal 'custom other-sessions fragment' "$(option @tmux-agents-status-other-sessions)" 'other-sessions fragment override is preserved'
assert_equal 'R' "$(option @tmux-agents-status-running-glyph)" 'running glyph override is preserved'
assert_equal 'fg=white' "$(option @tmux-agents-status-running-style)" 'running style override is preserved'
assert_equal 'W' "$(option @tmux-agents-status-waiting-glyph)" 'waiting glyph override is preserved'
assert_equal 'fg=black' "$(option @tmux-agents-status-waiting-style)" 'waiting style override is preserved'
assert_equal 'C' "$(option @tmux-agents-status-completed-glyph)" 'completed glyph override is preserved'
assert_equal 'fg=blue' "$(option @tmux-agents-status-completed-style)" 'completed style override is preserved'
assert_equal '' "$(option @tmux-agents-status-failed-glyph)" 'empty failed glyph override is preserved'
assert_equal 'fg=magenta' "$(option @tmux-agents-status-failed-style)" 'failed style override is preserved'
assert_equal 'underscore' "$(option @tmux-agents-status-unread-style)" 'unread style override is preserved'
assert_equal "$root" "$(option @tmux-agents-status-root)" 'plugin root is refreshed on every load'
assert_equal "window-pane-changed[0] display-message user-hook
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'repeated loads do not duplicate the appended pane hook'
assert_equal "session-window-changed[0] $hook_command" "$(tmux_test show-hooks -g session-window-changed)" 'repeated loads do not duplicate the appended window hook'
assert_equal "client-session-changed[0] $hook_command" "$(tmux_test show-hooks -g client-session-changed)" 'repeated loads do not duplicate the appended session hook'

# Missing registration resumes independently without disturbing completed hooks.
tmux_test set-hook -gu session-window-changed
tmux_test set-option -su @tmux-agents-status-hook-session-window-changed
tmux_test run-shell "$root/tmux-agents-status.tmux"
assert_equal "session-window-changed[0] $hook_command" "$(tmux_test show-hooks -g session-window-changed)" 'a missing hook registration resumes on reload'
assert_equal "window-pane-changed[0] display-message user-hook
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'resuming one hook leaves completed hook arrays unchanged'

# Hook commands resolve the current root when the event fires, including spaces.
relocated_root="$tmp/relocated root"
mkdir -p "$relocated_root/scripts"
cat >"$relocated_root/scripts/acknowledge" <<'EOF'
#!/bin/sh
tmux set-option -s @tmux-agents-status-hook-observed "$1"
tmux wait-for -S tmux-agents-status-hook-observed
EOF
chmod +x "$relocated_root/scripts/acknowledge"
tmux_test set-option -g @tmux-agents-status-root "$relocated_root"
hook_window=$(tmux_test new-window -d -P -F '#{window_id}')
hook_pane=$(tmux_test split-window -d -t "$hook_window" -P -F '#{pane_id}')
tmux_test select-pane -t "$hook_pane" \; wait-for tmux-agents-status-hook-observed
assert_equal "$hook_pane" "$(server_option @tmux-agents-status-hook-observed)" 'selection hooks invoke the acknowledgement command from the current root'
tmux_test kill-window -t "$hook_window"
tmux_test run-shell "$root/tmux-agents-status.tmux"

# Exercise each plugin hook through tmux with a real attached control-mode client.
control_fifo=$tmp/control-input
mkfifo "$control_fifo"
tmux -L "$socket" -C attach-session -t acceptance <"$control_fifo" >"$tmp/control-output" 2>"$tmp/control-error" &
control_pid=$!
exec 9>"$control_fifo"
control_client=
tries=0
while [ "$tries" -lt 5 ]; do
	control_client=$(tmux_test list-clients -F '#{client_name}')
	[ -n "$control_client" ] && break
	tries=$((tries + 1))
	sleep 1
done
[ -n "$control_client" ] || fail 'an actual attached client is available for selection-hook acceptance'

set -- $(tmux_test new-session -d -s acknowledgement-hooks -P -F '#{session_id} #{window_id} #{pane_id}')
visit_session=$1
visit_window=$2
away_pane=$3
visit_pane=$(tmux_test split-window -d -t "$visit_session:$visit_window" -P -F '#{pane_id}')
tmux_test switch-client -c "$control_client" -t "$visit_session"
incarnation=11111111-1111-4111-8111-111111111111
waiting_generation=g:22222222222222222222222222222222
completed_generation=g:33333333333333333333333333333333
failed_generation=g:44444444444444444444444444444444
rapid_generation=g:55555555555555555555555555555555
tmux_test set-option -g @tmux-agents-status-failed-glyph 'F'
server_tmux="$(tmux_test display-message -p '#{socket_path}'),$$,0"
render_window() {
	TMUX="$server_tmux" "$root/scripts/render-window" "$@"
}

# A core-created alert in the pane currently active for an attached client is
# acknowledged in the same ordered mutation.
tmux_test select-pane -t "$visit_pane"
active_owner=pi:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
active_turn=turn:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
TMUX="$server_tmux" TMUX_PANE="$visit_pane" "$root/scripts/state-core" 2 claim "$active_owner" "pid:$$"
TMUX="$server_tmux" TMUX_PANE="$visit_pane" "$root/scripts/state-core" 2 start "$active_owner" "$active_turn"
TMUX="$server_tmux" TMUX_PANE="$visit_pane" "$root/scripts/state-core" 2 finish "$active_owner" "$active_turn" completed
active_generation=$(server_option "@tmux-agents-status-state-$visit_pane")
active_generation=$(printf '%s\n' "$active_generation" | awk -F '|' '{ print $6 }')
assert_equal "$active_generation" "$(server_option "@tmux-agents-status-ack-$visit_pane")" 'an alert created in an already-active pane begins acknowledged'
tmux_test select-pane -t "$away_pane"

visit_state="v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request"
tmux_test set-option -s "@tmux-agents-status-state-$visit_pane" "$visit_state"
assert_equal '#[default] #[fg=black,underscore]W#[default]' "$(render_window "$visit_session" "$visit_window" "$visit_pane")" 'the pane-hook destination starts unread from the fragment baseline'
tmux_test set-hook -ag window-pane-changed 'wait-for -S tas-window-pane-acknowledged'
tmux_test select-pane -t "$visit_pane" \; wait-for tas-window-pane-acknowledged
assert_equal "$waiting_generation" "$(server_option "@tmux-agents-status-ack-$visit_pane")" 'window-pane-changed acknowledges the generation visible to an attached client'
assert_equal "$visit_state" "$(server_option "@tmux-agents-status-state-$visit_pane")" 'window-pane-changed leaves actual state intact'
assert_equal '#[default] #[fg=black]W#[default]' "$(render_window "$visit_session" "$visit_window" "$visit_pane")" 'window-pane-changed removes only unread emphasis'
tmux_test set-hook -gu 'window-pane-changed[2]'

tmux_test select-pane -t "$away_pane"
sleep 60 &
abrupt_owner=$!
virtual_state="v2|$incarnation|pid:$abrupt_owner|-|running|-|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$visit_pane" "$virtual_state"
tmux_test set-option -su "@tmux-agents-status-ack-$visit_pane"
kill "$abrupt_owner"
wait "$abrupt_owner" 2>/dev/null || :
assert_equal '#[default] #[fg=magenta,underscore]F#[default]' "$(render_window "$visit_session" "$visit_window" "$visit_pane")" 'abrupt owner death derives a visible virtual failure'
tmux_test set-hook -ag window-pane-changed 'wait-for -S tas-virtual-failure-acknowledged'
tmux_test select-pane -t "$visit_pane" \; wait-for tas-virtual-failure-acknowledged
assert_equal "d:$incarnation" "$(server_option "@tmux-agents-status-ack-$visit_pane")" 'visiting a virtual failure acknowledges its deterministic effective generation'
assert_equal "$virtual_state" "$(server_option "@tmux-agents-status-state-$visit_pane")" 'acknowledging a virtual failure leaves stored state intact'
assert_equal '#[default] #[fg=magenta]F#[default]' "$(render_window "$visit_session" "$visit_window" "$visit_pane")" 'acknowledged dead-owner state remains visible without unread emphasis'
tmux_test set-hook -gu 'window-pane-changed[2]'

rapid_state="v2|$incarnation|pid:$$|-|waiting|$rapid_generation|running|request"
tmux_test select-pane -t "$away_pane"
tmux_test set-option -s "@tmux-agents-status-state-$visit_pane" "$rapid_state"
tmux_test set-option -su "@tmux-agents-status-ack-$visit_pane"
tmux_test set-hook -ag window-pane-changed 'wait-for -S tas-rapid-pane-checked'
tmux_test select-pane -t "$visit_pane" \; select-pane -t "$away_pane" \; wait-for tas-rapid-pane-checked
assert_equal "$away_pane" "$(tmux_test display-message -p -c "$control_client" '#{pane_id}')" 'programmatic select-away leaves the alert invisible at acknowledgement time'
assert_equal '' "$(server_option "@tmux-agents-status-ack-$visit_pane")" 'rapid invisible selection is not acknowledged'
assert_equal "$rapid_state" "$(server_option "@tmux-agents-status-state-$visit_pane")" 'rapid selection leaves actual state intact'
assert_equal '#[default] #[fg=black,underscore]W#[default]' "$(render_window "$visit_session" "$visit_window" "$visit_pane")" 'rapid invisible selection remains unread'
tmux_test set-hook -gu 'window-pane-changed[2]'

set -- $(tmux_test new-window -d -t "$visit_session:" -P -F '#{window_id} #{pane_id}')
visit_other_window=$1
visit_other_pane=$2
window_state="v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$visit_other_pane" "$window_state"
assert_equal '#[default] #[fg=blue,underscore]C#[default]' "$(render_window "$visit_session" "$visit_other_window" "$visit_other_pane")" 'the window-hook destination starts unread'
tmux_test set-hook -ag session-window-changed 'wait-for -S tas-session-window-acknowledged'
tmux_test select-window -t "$visit_session:$visit_other_window" \; wait-for tas-session-window-acknowledged
assert_equal "$completed_generation" "$(server_option "@tmux-agents-status-ack-$visit_other_pane")" 'session-window-changed acknowledges the generation visible to an attached client'
assert_equal "$window_state" "$(server_option "@tmux-agents-status-state-$visit_other_pane")" 'session-window-changed leaves actual state intact'
assert_equal '#[default] #[fg=blue]C#[default]' "$(render_window "$visit_session" "$visit_other_window" "$visit_other_pane")" 'session-window-changed removes only unread emphasis'
tmux_test set-hook -gu 'session-window-changed[1]'

set -- $(tmux_test new-session -d -s acknowledgement-destination -P -F '#{session_id} #{window_id} #{pane_id}')
visit_other_session=$1
visit_session_window=$2
visit_session_pane=$3
session_state="v2|$incarnation|pid:$$|-|failed|$failed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$visit_session_pane" "$session_state"
assert_equal '#[default] #[fg=magenta,underscore]F#[default]' "$(render_window "$visit_other_session" "$visit_session_window" "$visit_session_pane")" 'the client-hook destination starts unread'
tmux_test set-hook -ag client-session-changed 'wait-for -S tas-client-session-acknowledged'
tmux_test switch-client -c "$control_client" -t "$visit_other_session" \; wait-for tas-client-session-acknowledged
assert_equal "$failed_generation" "$(server_option "@tmux-agents-status-ack-$visit_session_pane")" 'client-session-changed acknowledges the generation visible to an attached client'
assert_equal "$session_state" "$(server_option "@tmux-agents-status-state-$visit_session_pane")" 'client-session-changed leaves actual state intact'
assert_equal '#[default] #[fg=magenta]F#[default]' "$(render_window "$visit_other_session" "$visit_session_window" "$visit_session_pane")" 'client-session-changed removes only unread emphasis'
tmux_test set-hook -gu 'client-session-changed[1]'

tmux_test switch-client -c "$control_client" -t acceptance
tmux_test kill-session -t acknowledgement-hooks
tmux_test kill-session -t acknowledgement-destination

# Current-window rendering reads only valid live running records in the supplied window.
set -- $(tmux_test display-message -p -t acceptance: '#{session_id} #{window_id} #{pane_id}')
session=$1
window=$2
active_pane=$3
second_pane=$(tmux_test split-window -d -t "$session:$window" -P -F '#{pane_id}')
third_pane=$(tmux_test split-window -d -t "$session:$window" -P -F '#{pane_id}')
set -- $(tmux_test new-window -d -t "$session:" -P -F '#{window_id} #{pane_id}')
other_window=$1
other_pane=$2
incarnation=11111111-1111-4111-8111-111111111111

for pane in "$active_pane" "$third_pane" "$other_pane"; do
	tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|running|-|-|-"
done
tmux_test set-option -s "@tmux-agents-status-state-$second_pane" 'v1|99|legacy-owner|running|-'

server_tmux="$(tmux_test display-message -p '#{socket_path}'),$$,0"
render_window() {
	TMUX="$server_tmux" "$root/scripts/render-window" "$@"
}

assert_equal '#[default] #[fg=white]R#[default]#[fg=white]R#[default]' "$(render_window "$session" "$window" "$active_pane")" 'running panes start from tmux default and render once in their current window'
assert_equal '#[default] #[fg=white]R#[default]' "$(render_window "$session" "$other_window" "$other_pane")" 'a running pane renders in its own window only'

tmux_test set-option -g @tmux-agents-status-running-glyph '#R'
assert_equal '#[default] #[fg=white]##R#[default]#[fg=white]##R#[default]' "$(render_window "$session" "$window" "$active_pane")" 'configured glyph format metacharacters are escaped'
tmux_test set-option -g @tmux-agents-status-running-style ''
assert_equal '#[default] ##R##R' "$(render_window "$session" "$window" "$active_pane")" 'unstyled running glyphs remain on the fragment baseline'
tmux_test set-option -g @tmux-agents-status-running-glyph ''
assert_equal '' "$(render_window "$session" "$window" "$active_pane")" 'an empty running glyph hides running state'

tmux_test set-option -g @tmux-agents-status-running-glyph 'R'
tmux_test set-option -g @tmux-agents-status-running-style 'fg=white'
tmux_test set-option -su "@tmux-agents-status-state-$active_pane"
tmux_test set-option -su "@tmux-agents-status-state-$third_pane"
assert_equal '' "$(render_window "$session" "$window" "$active_pane")" 'a window without valid records emits an empty fragment'

# Live alerts render their actual state; acknowledgement changes only unread emphasis.
waiting_generation=g:22222222222222222222222222222222
completed_generation=g:33333333333333333333333333333333
failed_generation=g:44444444444444444444444444444444
tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request"
tmux_test set-option -s "@tmux-agents-status-state-$second_pane" "v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$second_pane" "$completed_generation"
tmux_test set-option -s "@tmux-agents-status-state-$third_pane" "v2|$incarnation|pid:$$|-|failed|$failed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-ack-$third_pane" "$completed_generation"
tmux_test set-option -g @tmux-agents-status-failed-glyph '!!#'

assert_equal '#[default] #[fg=black,underscore]W#[default]#[fg=magenta,underscore]!!###[default]#[fg=blue]C#[default]' "$(render_window "$session" "$window" "$active_pane")" 'live outcomes render configured state and generation-based unread styles'

tmux_test set-option -s "@tmux-agents-status-ack-$active_pane" "$waiting_generation"
assert_equal '#[default] #[fg=black]W#[default]#[fg=magenta,underscore]!!###[default]#[fg=blue]C#[default]' "$(render_window "$session" "$window" "$active_pane")" 'acknowledgement preserves live state and removes only unread emphasis'

tmux_test set-option -g @tmux-agents-status-waiting-glyph ''
tmux_test set-option -g @tmux-agents-status-completed-style ''
tmux_test set-option -g @tmux-agents-status-failed-style ''
assert_equal '#[default] #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'empty glyphs hide one state and empty styles remain on the fragment baseline'

tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v2|$incarnation|pid:$$|-|waiting|-|running|request"
assert_equal '#[default] #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'state-inconsistent generations are omitted without hiding valid siblings'

tmux_test set-option -g @tmux-agents-status-waiting-glyph 'W'
tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request
malformed"
assert_equal '#[default] #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'a valid-prefix multiline record is omitted without hiding valid siblings'

tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request
"
assert_equal '#[default] #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'an otherwise-valid record ending in a newline is omitted without hiding valid siblings'

# The other-session renderer excludes panes linked into the current session,
# attributes other linked panes once, and keeps stable topology ordering.
set -- $(tmux_test new-session -d -s 'current-linked#name' -P -F '#{session_id} #{window_id} #{pane_id}')
current_linked_session=$1
current_linked_window=$2
current_linked_pane=$3
tmux_test link-window -s "$current_linked_session:$current_linked_window" -t "$session:"

set -- $(tmux_test new-session -d -s 'first#name' -P -F '#{session_id} #{window_id} #{pane_id}')
first_session=$1
first_window=$2
first_running=$3
first_waiting=$(tmux_test split-window -d -t "$first_session:$first_window" -P -F '#{pane_id}')
first_malformed=$(tmux_test split-window -d -t "$first_session:$first_window" -P -F '#{pane_id}')

set -- $(tmux_test new-session -d -s 'low#|name' -P -F '#{session_id} #{window_id} #{pane_id}')
low_session=$1
low_window=$2
low_completed=$3
low_failed=$(tmux_test split-window -d -t "$low_session:$low_window" -P -F '#{pane_id}')

set -- $(tmux_test new-session -d -s 'higher#name' -P -F '#{session_id} #{window_id} #{pane_id}')
higher_session=$1
higher_running=$3
tmux_test link-window -s "$low_session:$low_window" -t "$higher_session:"

for pane in "$current_linked_pane" "$first_running" "$higher_running"; do
	tmux_test set-option -s "@tmux-agents-status-state-$pane" "v2|$incarnation|pid:$$|-|running|-|-|-"
done
tmux_test set-option -s "@tmux-agents-status-state-$first_waiting" "v2|$incarnation|pid:$$|-|waiting|$waiting_generation|running|request"
tmux_test set-option -s "@tmux-agents-status-state-$first_malformed" 'v1|99|legacy-owner|running|-'
tmux_test set-option -s "@tmux-agents-status-state-$low_completed" "v2|$incarnation|pid:$$|-|completed|$completed_generation|-|-"
tmux_test set-option -s "@tmux-agents-status-state-$low_failed" "v2|$incarnation|pid:$$|-|failed|$failed_generation|-|-"
tmux_test set-option -su "@tmux-agents-status-ack-$first_waiting"
tmux_test set-option -su "@tmux-agents-status-ack-$low_completed"
tmux_test set-option -su "@tmux-agents-status-ack-$low_failed"
tmux_test set-option -g @tmux-agents-status-running-glyph '#R'
tmux_test set-option -g @tmux-agents-status-running-style 'fg=white'
tmux_test set-option -g @tmux-agents-status-waiting-glyph 'W#'
tmux_test set-option -g @tmux-agents-status-waiting-style 'fg=yellow'
tmux_test set-option -g @tmux-agents-status-completed-glyph 'CC'
tmux_test set-option -g @tmux-agents-status-completed-style 'fg=blue'
tmux_test set-option -g @tmux-agents-status-failed-glyph 'F#'
tmux_test set-option -g @tmux-agents-status-failed-style 'fg=red'
tmux_test set-option -g @tmux-agents-status-unread-style 'underscore'

server_tmux="$(tmux_test display-message -p '#{socket_path}'),$$,0"
render_other() {
	TMUX="$server_tmux" "$root/scripts/render-other-sessions" "$@"
}
assert_other() {
	render_other "$session" >"$tmp/other-output"
	assert_equal '1' "$(wc -l <"$tmp/other-output" | tr -d ' ')" "$2 prints exactly one output line"
	IFS= read -r actual <"$tmp/other-output" || :
	assert_equal "$1" "${actual-}" "$2"
}

assert_other '#[default]#[fg=white]##R#[default]2 first##name:#[fg=yellow,underscore]W###[default] low##|name:#[fg=blue,underscore]CC#[default]#[fg=red,underscore]F###[default] ' 'other sessions start from tmux default and summarize running work and ordered unread alerts'

assert_empty_renderer() {
	"$@" >"$tmp/renderer-output"
	assert_equal '1' "$(wc -l <"$tmp/renderer-output" | tr -d ' ')" "$1 rejects multiline configuration with exactly one output line"
	IFS= read -r actual <"$tmp/renderer-output" || :
	assert_equal '' "${actual-}" "$1 rejects multiline configuration without sibling or output injection"
}

tmux_test set-option -g @tmux-agents-status-waiting-glyph 'W
injected'
assert_empty_renderer render_window "$session" "$window" "$active_pane"
assert_empty_renderer render_other "$session"
tmux_test set-option -g @tmux-agents-status-waiting-glyph 'W#'
tmux_test set-option -g @tmux-agents-status-failed-style 'fg=red
'
assert_empty_renderer render_window "$session" "$window" "$active_pane"
assert_empty_renderer render_other "$session"
tmux_test set-option -g @tmux-agents-status-failed-style 'fg=red'

for pane_generation in \
	"$first_waiting:$waiting_generation" \
	"$low_completed:$completed_generation" \
	"$low_failed:$failed_generation"; do
	pane=${pane_generation%%:*}
	generation=${pane_generation#*:}
	tmux_test set-option -s "@tmux-agents-status-ack-$pane" "$generation"
done
assert_other '#[default]#[fg=white]##R#[default]2 ' 'acknowledged groups collapse while background running remains'

tmux_test set-option -g @tmux-agents-status-running-glyph ''
assert_other '' 'an empty running glyph hides its total and leaves an empty summary'

# Depending on version, tmux preserves, visibly escapes, or rejects newlines.
embedded_name='embedded
name'
trailing_name='trailing
'
if embedded_session=$(tmux_test new-session -d -s "$embedded_name" -P -F '#{session_id}' 2>/dev/null); then
	trailing_session=$(tmux_test new-session -d -s "$trailing_name" -P -F '#{session_id}') || fail 'tmux handles embedded and trailing newlines consistently'
	embedded_actual=$(tmux_test display-message -p -t "$embedded_session" '#{session_name}')
	trailing_actual=$(tmux_test display-message -p -t "$trailing_session" '#{session_name}')
	[ "$embedded_actual" = 'embedded\nname' ] || [ "$embedded_actual" = "$embedded_name" ] || fail 'tmux preserves or visibly escapes an embedded newline in a session name'
	[ "$trailing_actual" = 'trailing\n' ] || [ "$trailing_actual" = trailing ] || fail 'tmux preserves or visibly escapes a trailing newline in a session name'
elif tmux_test new-session -d -s "$trailing_name" >/dev/null 2>&1; then
	fail 'tmux handles embedded and trailing newlines consistently'
fi

# Fake only tmux's executable boundary to exercise raw malformed query output and
# pane-ID ordering that real topology cannot make tie on all earlier keys.
mkdir "$tmp/fake-render"
cat >"$tmp/fake-render/tmux" <<'EOF'
#!/bin/sh
case "$1:$2" in
show-option:-gqv)
	[ "${FAKE_FAIL-}" = option ] && exit 1
	case $3 in
	*@tmux-agents-status-running-glyph) printf 'R\n' ;;
	*@tmux-agents-status-waiting-glyph) printf 'W\n' ;;
	*@tmux-agents-status-completed-glyph) printf 'C\n' ;;
	*@tmux-agents-status-failed-glyph) printf 'F\n' ;;
	*) printf '\n' ;;
	esac
	;;
show-option:-sqv)
	case $3 in
	*@tmux-agents-status-state-%9) printf 'v2|11111111-1111-4111-8111-111111111111|pid:%s|-|failed|g:44444444444444444444444444444444|-|-\n' "$FAKE_OWNER" ;;
	*@tmux-agents-status-state-%10) printf 'v2|11111111-1111-4111-8111-111111111111|pid:%s|-|completed|g:33333333333333333333333333333333|-|-\n' "$FAKE_OWNER" ;;
	*@tmux-agents-status-ack-*) : ;;
	*) exit 1 ;;
	esac
	;;
list-panes:*)
	[ "${FAKE_FAIL-}" = topology ] && exit 1
	printf '$1|0|0|%%10\n$1|0|0|%%9\n'
	;;
display-message:-p)
	[ "${FAKE_FAIL-}" = name ] && exit 1
	case ${FAKE_NAME_KIND-good} in
	good) printf '$1|ordered\n' ;;
	embedded) printf '$1|bad\ninjected\n' ;;
	trailing) printf '$1|bad\n\n' ;;
	esac
	;;
*) exit 1 ;;
esac
EOF
chmod +x "$tmp/fake-render/tmux"

assert_fake_other() {
	PATH="$tmp/fake-render:$PATH" FAKE_OWNER=$$ FAKE_NAME_KIND=$1 FAKE_FAIL=$2 \
		"$root/scripts/render-other-sessions" '$0' >"$tmp/fake-render-output"
	assert_equal '1' "$(wc -l <"$tmp/fake-render-output" | tr -d ' ')" "$4 prints exactly one output line"
	IFS= read -r actual <"$tmp/fake-render-output" || :
	assert_equal "$3" "${actual-}" "$4"
}

assert_fake_other good '' '#[default]ordered:FC ' 'numeric pane-ID tie-breaking orders alerts'
assert_fake_other embedded '' '' 'an embedded newline from the session-name query fails closed'
assert_fake_other trailing '' '' 'a trailing newline from the session-name query fails closed'
assert_fake_other good name '' 'a required session-name query failure fails closed'
assert_fake_other good option '' 'a required global-option query failure fails closed'
assert_fake_other good topology '' 'a required topology query failure fails closed'

cat >"$tmp/tmux" <<'EOF'
#!/bin/sh
if [ "$1" = 'display-message' ]; then
    printf '2.9\n'
    exit 0
fi
printf '%s\n' "$*" >>"$FAKE_TMUX_LOG"
EOF
chmod +x "$tmp/tmux"
: >"$tmp/calls"

if PATH="$tmp:$PATH" FAKE_TMUX_LOG="$tmp/calls" "$root/tmux-agents-status.tmux" >"$tmp/stdout" 2>"$tmp/stderr"; then
	fail 'tmux 2.9 is rejected with a nonzero result'
fi
IFS= read -r diagnostic <"$tmp/stderr" || :
assert_equal 'tmux-agents-status: tmux 3.0 or newer is required (found 2.9)' "${diagnostic-}" 'unsupported-version diagnostic is clear'
assert_equal '1' "$(wc -l <"$tmp/stderr" | tr -d ' ')" 'unsupported-version diagnostic is one line'
[ ! -s "$tmp/stdout" ] || fail 'unsupported-version rejection writes no stdout'
[ ! -s "$tmp/calls" ] || fail 'unsupported-version rejection mutates no tmux options or hooks'

printf 'ok - plugin loading is isolated, composable, idempotent, and version-safe\n'
