#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-core-configuration-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-core-configuration-$$
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

assert_absent_server() {
	if tmux_test show-options -s "$1" >/dev/null 2>&1; then
		fail "$2"
	fi
}

tmux_test -f /dev/null new-session -d -s core-configuration
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0

TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"

assert_equal "$root" "$(global_option @tmux-agents-status-root)" 'installation publishes the canonical checkout root'
assert_equal '2' "$(global_option @tmux-agents-status-protocol)" 'installation publishes the normalized protocol major'
assert_equal '#(#{q:@tmux-agents-status-root}/scripts/render-window #{q:session_id} #{q:window_id} #{q:pane_id})' "$(global_option @tmux-agents-status-window)" 'installation installs the window rendering default'
assert_equal '1' "$(server_option @tmux-agents-status-default-window)" 'Core configuration ownership records a created default'
hook_command='run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
assert_equal 'window-pane-changed[0] '"$hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'installation appends the acknowledgement hook'
assert_equal 'window-pane-changed[0]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'Core configuration ownership records the appended hook selector'
assert_equal '#(#{q:@tmux-agents-status-root}/scripts/render-other-sessions #{q:session_id})' "$(global_option @tmux-agents-status-other-sessions)" 'installation installs the other-sessions rendering default'
assert_equal '•' "$(global_option @tmux-agents-status-running-glyph)" 'installation installs the running glyph default'
assert_equal 'fg=cyan' "$(global_option @tmux-agents-status-running-style)" 'installation installs the running style default'
assert_equal '?' "$(global_option @tmux-agents-status-waiting-glyph)" 'installation installs the waiting glyph default'
assert_equal 'fg=yellow' "$(global_option @tmux-agents-status-waiting-style)" 'installation installs the waiting style default'
assert_equal '✓' "$(global_option @tmux-agents-status-completed-glyph)" 'installation installs the completed glyph default'
assert_equal 'fg=green' "$(global_option @tmux-agents-status-completed-style)" 'installation installs the completed style default'
assert_equal '!' "$(global_option @tmux-agents-status-failed-glyph)" 'installation installs the failed glyph default'
assert_equal 'fg=red' "$(global_option @tmux-agents-status-failed-style)" 'installation installs the failed style default'
assert_equal 'reverse,bold' "$(global_option @tmux-agents-status-unread-style)" 'installation installs the unread style default'
for option in window other-sessions running-glyph running-style waiting-glyph waiting-style completed-glyph completed-style failed-glyph failed-style unread-style; do
	assert_equal '1' "$(server_option @tmux-agents-status-default-$option)" "Core configuration ownership records the $option default"
done
for hook in session-window-changed client-session-changed client-attached; do
	assert_equal "$hook[0]" "$(server_option @tmux-agents-status-hook-$hook)" "Core configuration ownership records the $hook selector"
	assert_equal "$hook[0] $hook_command" "$(tmux_test show-hooks -g "$hook")" "installation installs the $hook acknowledgement hook"
done
cleanup_command='run-shell "#{q:@tmux-agents-status-root}/scripts/cleanup-pane #{q:hook_pane}"'
assert_equal 'pane-exited[0] '"$cleanup_command" "$(tmux_test show-hooks -g pane-exited)" 'installation installs the pane-exit cleanup hook'
assert_equal 'pane-exited[0]' "$(server_option @tmux-agents-status-hook-pane-exited)" 'Core configuration ownership records the pane-exit hook selector'

# Simulate a user winning the set-if-absent race after tmux rejects Core's set.
tmux_test kill-server
rm -rf "$tmp/race-bin"
mkdir "$tmp/race-bin"
real_tmux=$(command -v tmux)
cat >"$tmp/race-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
set-option:-go:@tmux-agents-status-running-glyph)
    "$REAL_TMUX" set-option -g "$3" user-won
    exit 1
    ;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/race-bin/tmux"
tmux_test -f /dev/null new-session -d -s core-configuration-race
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
REAL_TMUX="$real_tmux" TMUX="$server_tmux" PATH="$tmp/race-bin:$PATH" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal 'user-won' "$(global_option @tmux-agents-status-running-glyph)" 'a raced user value is preserved after set-if-absent refuses creation'
assert_absent_server @tmux-agents-status-default-running-glyph 'a raced user value receives no Core ownership marker'

run_preexisting_case() {
	case_name=$1
	case_value=$2
	tmux_test kill-server
	tmux_test -f /dev/null new-session -d -s "preexisting-$case_name"
	server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
	tmux_test set-option -g @tmux-agents-status-running-style "$case_value"
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
	assert_equal "$case_value" "$(global_option @tmux-agents-status-running-style)" "a $case_name default value is preserved"
	assert_absent_server @tmux-agents-status-default-running-style "a $case_name default value remains user-owned"
}
run_preexisting_case equal 'fg=cyan'
run_preexisting_case custom 'user-style'
run_preexisting_case empty ''

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s reload
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
tmux_test set-option -g @tmux-agents-status-running-glyph user-change
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal user-change "$(global_option @tmux-agents-status-running-glyph)" 'reload preserves a user change to a Core default'
assert_equal 'window-pane-changed[0] '"$hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'reload does not duplicate a valid owned hook'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-append
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'installation appends after a user hook'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'Core configuration ownership records the appended selector after a user hook'

# A stale exact selector is evidence about neither the user hook nor a new one.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-stale
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[0]'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a stale selector preserves the uncertain hook and appends Core'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a stale selector is repaired with new ownership evidence'

# A matching selector with a different command is not ownership evidence.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-mismatch
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[0]'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a selector with a mismatched command preserves the user hook and appends Core'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a mismatched command is repaired with new ownership evidence'

# A malformed selector is not ownership evidence.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-malformed
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[not-numeric]'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a malformed selector preserves the user hook and appends Core'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a malformed selector is repaired with new ownership evidence'

# Expected non-matches remain recoverable through the public loader's -e shell.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s loader-stale
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[0]'
TMUX="$server_tmux" "$root/tmux-agents-status.tmux"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'the public loader repairs stale hook evidence under fail-fast shell options'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'the public loader records repaired hook evidence'

# A missing marker does not claim an existing matching occurrence.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-missing-marker
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed "$hook_command"
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] $hook_command
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a missing marker preserves the matching hook and appends another owned occurrence'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a missing marker records the newly appended occurrence'

# Valid ownership evidence selects one exact occurrence even when an identical
# user command appears elsewhere in the hook array.
tmux_test set-hook -ag window-pane-changed "$hook_command"
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] $hook_command
window-pane-changed[1] $hook_command
window-pane-changed[2] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'valid exact evidence does not duplicate a hook beside an identical user occurrence'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'valid exact evidence remains tied to its original selector'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-legacy-no-match
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 1
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a legacy marker without a matching occurrence recovers by appending Core'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a legacy marker without a match records recoverable ownership evidence'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-legacy
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
for selector_number in 0 1 2 3 4 5 6 7 8 9 10; do
	case $selector_number in
	2 | 10) hook_entry=$hook_command ;;
	*) hook_entry="display-message user-$selector_number" ;;
	esac
	tmux_test set-hook -ag window-pane-changed "$hook_entry"
done
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 1
before_hooks=$(tmux_test show-hooks -g window-pane-changed)
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "$before_hooks" "$(tmux_test show-hooks -g window-pane-changed)" 'legacy migration does not add or delete a hook'
assert_equal 'window-pane-changed[10]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'legacy migration selects the maximum numeric matching selector'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-exact
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed "$hook_command"
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[0]'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'an exact selector and command make a reload idempotent'
assert_equal 'window-pane-changed[0]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'exact ownership evidence remains unchanged'

# Installation is fail-fast without rollback, and a later load repairs its prefix.
tmux_test kill-server
rm -rf "$tmp/fail-bin"
mkdir "$tmp/fail-bin"
cat >"$tmp/fail-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
set-option:-go:@tmux-agents-status-running-style) exit 1 ;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/fail-bin/tmux"
tmux_test -f /dev/null new-session -d -s install-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-option -s @tmux-agents-status-state-%999 keep-state
if REAL_TMUX="$real_tmux" TMUX="$server_tmux" PATH="$tmp/fail-bin:$PATH" "$root/tmux-agents-status.tmux"; then
	fail 'a failed required default aborts the public load'
fi
assert_equal keep-state "$(server_option @tmux-agents-status-state-%999)" 'a failed load skips startup stale-record cleanup'
if REAL_TMUX="$real_tmux" TMUX="$server_tmux" PATH="$tmp/fail-bin:$PATH" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"; then
	fail 'a failed required default aborts installation'
fi
assert_equal '•' "$(global_option @tmux-agents-status-running-glyph)" 'a partial installation keeps earlier successful defaults'
assert_absent_server @tmux-agents-status-default-running-style 'a failed default does not claim ownership'
assert_absent_server @tmux-agents-status-waiting-glyph 'a failed default prevents later defaults from installing'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal '?' "$(global_option @tmux-agents-status-waiting-glyph)" 'a later load repairs partial installation'

printf 'ok - core configuration installation publishes discovery metadata\n'
