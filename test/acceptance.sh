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
