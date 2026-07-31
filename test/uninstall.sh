#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-uninstall-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-uninstall-$$
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

global_option() {
	tmux_test show-option -gqv "$1"
}

server_option() {
	tmux_test show-option -sqv "$1"
}

# A present option always echoes its own name, so empty output distinguishes
# absence from an option set to an empty value.
assert_absent_option() {
	if value=$(tmux_test show-options "$1" "$2" 2>/dev/null) && [ -n "$value" ]; then
		fail "$3"
	fi
}

assert_absent_global() {
	assert_absent_option -g "$1" "$2"
}

assert_absent_server() {
	assert_absent_option -s "$1" "$2"
}

tmux_test -f /dev/null new-session -d -s uninstall
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-hook -g pane-exited 'display-message user-pane-before'
tmux_test set-option -g status-right 'user status #{E:@tmux-agents-status-other-sessions}'
tmux_test set-option -g window-status-format 'user window #{E:@tmux-agents-status-window}'
tmux_test set-option -g @tmux-agents-status-waiting-glyph '?'
cat >"$tmp/tmux.conf" <<'EOF'
set -g @plugin 'hiback/tmux-agents-status'
run-shell ~/.tmux/plugins/tmux-agents-status/tmux-agents-status.tmux
set -g status-right '#{E:@tmux-agents-status-other-sessions}#S'
set -g window-status-format '#I:#W#{E:@tmux-agents-status-window}'
EOF
config_before=$(cksum "$tmp/tmux.conf")

tmux_test run-shell "$root/tmux-agents-status.tmux"
assert_equal '1' "$(server_option @tmux-agents-status-default-running-glyph)" 'loading marks a newly installed default as plugin-owned'
assert_absent_server @tmux-agents-status-default-waiting-glyph 'loading does not claim a pre-existing option even when it equals the default'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'loading records the selector of its own appended hook'
tmux_test set-option -s @tmux-agents-status-hook-client-attached 1
tmux_test run-shell "$root/tmux-agents-status.tmux"
assert_equal 'client-attached[0]' "$(server_option @tmux-agents-status-hook-client-attached)" 'reload migrates a legacy ownership marker to its matching hook selector'
hook_command='run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
tmux_test set-hook -ag window-pane-changed "$hook_command"
tmux_test set-hook -ag window-pane-changed 'display-message user-after'
tmux_test set-hook -ag session-window-changed "$hook_command"
tmux_test set-option -s @tmux-agents-status-hook-session-window-changed 1
tmux_test set-hook -ag pane-exited 'display-message user-pane-after'
set -- $(tmux_test display-message -p '#{pane_id}')
pane=$1
stale=%999991
tmux_test set-option -s "@tmux-agents-status-state-$pane" 'v2|owner:live|-|-|running|-|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" 'g:11111111111111111111111111111111'
tmux_test set-option -s "@tmux-agents-status-state-$stale" 'v2|owner:stale|-|-|failed|g:22222222222222222222222222222222|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$stale" 'g:22222222222222222222222222222222'
tmux_test set-option -s @tmux-agents-status-user-data keep-server
tmux_test set-option -g @tmux-agents-status-user-global keep-global
# A value changed after loading is user-owned live configuration and must survive.
tmux_test set-option -g @tmux-agents-status-failed-glyph 'USER-FAILED'

TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" \
	"$root/scripts/uninstall" >"$tmp/first-output" 2>"$tmp/first-error"
[ ! -s "$tmp/first-error" ] || fail 'successful uninstall writes no diagnostic'
expected_output="tmux-agents-status: remove these exact strings from tmux configuration:
set -g @plugin 'hiback/tmux-agents-status'
run-shell ~/.tmux/plugins/tmux-agents-status/tmux-agents-status.tmux
#{E:@tmux-agents-status-window}
#{E:@tmux-agents-status-other-sessions}"
assert_equal "$expected_output" "$(cat "$tmp/first-output")" 'uninstall prints exact declarations and fragments for manual removal'
assert_equal "$config_before" "$(cksum "$tmp/tmux.conf")" 'uninstall never edits user tmux configuration'

assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[2] $hook_command
window-pane-changed[3] display-message user-after" "$(tmux_test show-hooks -g window-pane-changed)" 'uninstall removes only the pane-selection hook named by its ownership marker'
assert_equal "pane-exited[0] display-message user-pane-before
pane-exited[2] display-message user-pane-after" "$(tmux_test show-hooks -g pane-exited)" 'uninstall removes only its pane-exit hook'
assert_equal "session-window-changed[0] $hook_command" "$(tmux_test show-hooks -g session-window-changed)" 'a legacy ownership marker removes exactly one owned hook occurrence and preserves an identical user occurrence'

for option in \
	@tmux-agents-status-root \
	@tmux-agents-status-protocol \
	@tmux-agents-status-window \
	@tmux-agents-status-other-sessions \
	@tmux-agents-status-running-glyph \
	@tmux-agents-status-running-style \
	@tmux-agents-status-waiting-style \
	@tmux-agents-status-completed-glyph \
	@tmux-agents-status-completed-style \
	@tmux-agents-status-failed-style \
	@tmux-agents-status-unread-style; do
	assert_absent_global "$option" "uninstall removes plugin-owned default $option"
done
assert_equal '?' "$(global_option @tmux-agents-status-waiting-glyph)" 'a pre-existing option equal to a default is not claimed or removed'
assert_equal 'USER-FAILED' "$(global_option @tmux-agents-status-failed-glyph)" 'a changed plugin default is retained as user-owned live configuration'
assert_equal 'keep-global' "$(global_option @tmux-agents-status-user-global)" 'unknown global options are not removed by prefix'
assert_equal 'keep-server' "$(server_option @tmux-agents-status-user-data)" 'unknown server options are not removed by prefix'
assert_equal 'user status #{E:@tmux-agents-status-other-sessions}' "$(global_option status-right)" 'user status format is unchanged'
assert_equal 'user window #{E:@tmux-agents-status-window}' "$(global_option window-status-format)" 'user window format is unchanged'

for option in \
	"@tmux-agents-status-state-$pane" \
	"@tmux-agents-status-ack-$pane" \
	"@tmux-agents-status-state-$stale" \
	"@tmux-agents-status-ack-$stale" \
	@tmux-agents-status-hook-window-pane-changed \
	@tmux-agents-status-hook-session-window-changed \
	@tmux-agents-status-hook-client-session-changed \
	@tmux-agents-status-hook-client-attached \
	@tmux-agents-status-hook-pane-exited; do
	assert_absent_server "$option" "uninstall removes plugin-owned server option $option"
done
if tmux_test show-options -s | grep -Eq '^@tmux-agents-status-default-'; then
	fail 'uninstall removes all default ownership markers'
fi

TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" \
	"$root/scripts/uninstall" >"$tmp/second-output" 2>"$tmp/second-error"
[ ! -s "$tmp/second-error" ] || fail 'repeated uninstall remains silent on stderr'
assert_equal "$expected_output" "$(cat "$tmp/second-output")" 'repeated uninstall is idempotent and keeps manual instructions stable'
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[2] $hook_command
window-pane-changed[3] display-message user-after" "$(tmux_test show-hooks -g window-pane-changed)" 'repeated uninstall leaves user hooks unchanged'
assert_equal 'USER-FAILED' "$(global_option @tmux-agents-status-failed-glyph)" 'repeated uninstall preserves retained user options'

printf 'ok - core uninstall removes only plugin-owned runtime state\n'
