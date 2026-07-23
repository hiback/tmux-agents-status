#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-acceptance-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-acceptance-$$
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

option() {
	tmux_test show-option -gqv "$1"
}

node "$root/test/extension-running.mjs"

tmux_test -f /dev/null new-session -d -s acceptance
tmux_test run-shell "$root/tmux-agents-status.tmux"

assert_equal "$root" "$(option @tmux-agents-status-root)" 'plugin root is installed'
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
	tmux_test set-option -s "@tmux-agents-status-state-$pane" "v1|$$|$incarnation|running|-"
done
tmux_test set-option -s "@tmux-agents-status-state-$second_pane" 'v1|0|not-an-incarnation|running|-'

server_tmux="$(tmux_test display-message -p '#{socket_path}'),$$,0"
render_window() {
	TMUX="$server_tmux" "$root/scripts/render-window" "$@"
}

assert_equal ' #[fg=white]R#[default]#[fg=white]R#[default]' "$(render_window "$session" "$window" "$active_pane")" 'running panes render once in their current window'
assert_equal ' #[fg=white]R#[default]' "$(render_window "$session" "$other_window" "$other_pane")" 'a running pane renders in its own window only'

tmux_test set-option -g @tmux-agents-status-running-glyph '#R'
assert_equal ' #[fg=white]##R#[default]#[fg=white]##R#[default]' "$(render_window "$session" "$window" "$active_pane")" 'configured glyph format metacharacters are escaped'
tmux_test set-option -g @tmux-agents-status-running-style ''
assert_equal ' ##R##R' "$(render_window "$session" "$window" "$active_pane")" 'unstyled running glyphs do not emit style resets'
tmux_test set-option -g @tmux-agents-status-running-glyph ''
assert_equal '' "$(render_window "$session" "$window" "$active_pane")" 'an empty running glyph hides running state'

tmux_test set-option -g @tmux-agents-status-running-glyph 'R'
tmux_test set-option -g @tmux-agents-status-running-style 'fg=white'
tmux_test set-option -su "@tmux-agents-status-state-$active_pane"
tmux_test set-option -su "@tmux-agents-status-state-$third_pane"
assert_equal '' "$(render_window "$session" "$window" "$active_pane")" 'a window without valid records emits an empty fragment'

# Live alerts render their actual state; acknowledgement changes only unread emphasis.
waiting_generation=22222222-2222-4222-8222-222222222222
completed_generation=33333333-3333-4333-8333-333333333333
failed_generation=44444444-4444-4444-8444-444444444444
tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v1|$$|$incarnation|waiting|$waiting_generation"
tmux_test set-option -s "@tmux-agents-status-state-$second_pane" "v1|$$|$incarnation|completed|$completed_generation"
tmux_test set-option -s "@tmux-agents-status-ack-$second_pane" "$completed_generation"
tmux_test set-option -s "@tmux-agents-status-state-$third_pane" "v1|$$|$incarnation|failed|$failed_generation"
tmux_test set-option -s "@tmux-agents-status-ack-$third_pane" "$completed_generation"
tmux_test set-option -g @tmux-agents-status-failed-glyph '!!#'

assert_equal ' #[fg=black,underscore]W#[default]#[fg=magenta,underscore]!!###[default]#[fg=blue]C#[default]' "$(render_window "$session" "$window" "$active_pane")" 'live outcomes render configured state and generation-based unread styles'

tmux_test set-option -s "@tmux-agents-status-ack-$active_pane" "$waiting_generation"
assert_equal ' #[fg=black]W#[default]#[fg=magenta,underscore]!!###[default]#[fg=blue]C#[default]' "$(render_window "$session" "$window" "$active_pane")" 'acknowledgement preserves live state and removes only unread emphasis'

tmux_test set-option -g @tmux-agents-status-waiting-glyph ''
tmux_test set-option -g @tmux-agents-status-completed-style ''
tmux_test set-option -g @tmux-agents-status-failed-style ''
assert_equal ' #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'empty glyphs hide one state and empty styles emit only necessary markup'

tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v1|$$|$incarnation|waiting|-"
assert_equal ' #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'state-inconsistent generations are omitted without hiding valid siblings'

tmux_test set-option -g @tmux-agents-status-waiting-glyph 'W'
tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v1|$$|$incarnation|waiting|$waiting_generation
malformed"
assert_equal ' #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'a valid-prefix multiline record is omitted without hiding valid siblings'

tmux_test set-option -s "@tmux-agents-status-state-$active_pane" "v1|$$|$incarnation|waiting|$waiting_generation
"
assert_equal ' #[underscore]!!###[default]C' "$(render_window "$session" "$window" "$active_pane")" 'an otherwise-valid record ending in a newline is omitted without hiding valid siblings'

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
