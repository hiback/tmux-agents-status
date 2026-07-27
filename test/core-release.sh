#!/bin/sh
# Core release gate. Installs the candidate checkout the way a released core is
# distributed -- tracked files only, at a plugin path, under an isolated HOME --
# then verifies the root entrypoint, reload idempotence, runtime cleanup, and
# manual removal. TPM itself is not exercised: it clones a checkout and runs
# this same entrypoint.
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-core-release-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-core-release-$$
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

# Stage only tracked files, so a release that forgets to commit a runtime file
# fails here instead of in a user's checkout.
home=$tmp/home
plugin=$home/.tmux/plugins/tmux-agents-status
mkdir -p "$plugin"
(cd "$root" && git ls-files -z | tar -cf - --null -T -) | tar -xf - -C "$plugin"

[ -x "$plugin/tmux-agents-status.tmux" ] || fail 'the released entrypoint is executable'
for script in state-core acknowledge cleanup-pane cleanup-stale refresh-clients \
	render-window render-other-sessions uninstall; do
	[ -x "$plugin/scripts/$script" ] || fail "the released scripts/$script is executable"
done

# The canonical declaration form, so the manual-removal guidance can be checked
# against configuration a user would actually have.
config=$home/.tmux.conf
cat >"$config" <<'EOF'
set -g @plugin 'hiback/tmux-agents-status'
set -g status-right '#{E:@tmux-agents-status-other-sessions}#S'
set -g window-status-format '#I:#W#{E:@tmux-agents-status-window}'
set -g window-status-current-format '#I:#W#{E:@tmux-agents-status-window}'
run-shell ~/.tmux/plugins/tmux-agents-status/tmux-agents-status.tmux
EOF
config_before=$(cksum "$config")

HOME=$home tmux_test -f "$config" new-session -d -s core-release
assert_equal "$plugin" "$(global_option @tmux-agents-status-root)" 'the entrypoint publishes its own root'
assert_equal '2' "$(global_option @tmux-agents-status-protocol)" 'the entrypoint publishes the core protocol major'
assert_equal '•' "$(global_option @tmux-agents-status-running-glyph)" 'the entrypoint installs rendering defaults'

ack_command='run-shell "#{q:@tmux-agents-status-root}/scripts/acknowledge #{q:pane_id}"'
cleanup_command='run-shell "#{q:@tmux-agents-status-root}/scripts/cleanup-pane #{q:hook_pane}"'
hooks_after_load() {
	for hook in window-pane-changed session-window-changed client-session-changed \
		client-attached pane-exited; do
		# tmux lists an empty hook as a bare name with no command.
		tmux_test show-hooks -g "$hook" | awk 'NF > 1'
	done
}
installed_hooks=$(hooks_after_load)
assert_equal "window-pane-changed[0] $ack_command
session-window-changed[0] $ack_command
client-session-changed[0] $ack_command
client-attached[0] $ack_command
pane-exited[0] $cleanup_command" "$installed_hooks" 'the entrypoint installs exactly its own hooks'

HOME=$home tmux_test source-file "$config"
HOME=$home tmux_test source-file "$config"
assert_equal "$installed_hooks" "$(hooks_after_load)" 'reloading the entrypoint never duplicates its hooks'
assert_equal "$plugin" "$(global_option @tmux-agents-status-root)" 'reloading keeps the published root'
assert_equal "$config_before" "$(cksum "$config")" 'loading never edits user tmux configuration'

# Runtime cleanup must remove live plugin-owned state and nothing else.
pane=$(tmux_test display-message -p '#{pane_id}')
TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" TMUX_PANE="$pane" \
	"$plugin/scripts/state-core" 2 claim release:owner "pid:$$"
TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" TMUX_PANE="$pane" \
	"$plugin/scripts/state-core" 2 start release:owner release:turn
assert_equal "v2|release:owner|pid:$$|release:turn|running|-|-|-" "$(server_option "@tmux-agents-status-state-$pane")" 'the released core records lifecycle state'

HOME=$home TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" \
	"$plugin/scripts/uninstall" >"$tmp/uninstall-output" 2>"$tmp/uninstall-error"
[ ! -s "$tmp/uninstall-error" ] || fail 'runtime cleanup writes no diagnostic'
assert_equal "tmux-agents-status: remove these exact strings from tmux configuration:
set -g @plugin 'hiback/tmux-agents-status'
run-shell ~/.tmux/plugins/tmux-agents-status/tmux-agents-status.tmux
#{E:@tmux-agents-status-window}
#{E:@tmux-agents-status-other-sessions}" "$(cat "$tmp/uninstall-output")" 'runtime cleanup prints the exact strings to remove manually'
assert_equal "$config_before" "$(cksum "$config")" 'runtime cleanup never edits user tmux configuration'

tail -n +2 "$tmp/uninstall-output" | while IFS= read -r removal; do
	grep -Fq "$removal" "$config" ||
		fail 'every string printed for manual removal is present in the configuration'
done

assert_equal '' "$(server_option "@tmux-agents-status-state-$pane")" 'runtime cleanup removes pane records'
assert_equal '' "$(global_option @tmux-agents-status-root)" 'runtime cleanup removes root metadata'
assert_equal '' "$(global_option @tmux-agents-status-protocol)" 'runtime cleanup removes protocol metadata'
assert_equal '' "$(global_option @tmux-agents-status-running-glyph)" 'runtime cleanup removes plugin-owned defaults'
assert_equal '' "$(hooks_after_load)" 'runtime cleanup removes every hook the entrypoint installed'
assert_equal '#{E:@tmux-agents-status-other-sessions}#S' "$(global_option status-right)" 'runtime cleanup leaves user status formats for manual removal'

# Manual removal: delete the checkout and the printed strings, then reload.
rm -rf "$plugin"
cat >"$config" <<'EOF'
set -g status-right '#S'
set -g window-status-format '#I:#W'
set -g window-status-current-format '#I:#W'
EOF
HOME=$home tmux_test source-file "$config"
assert_equal '#S' "$(global_option status-right)" 'manual removal restores a plugin-free status line'
if tmux_test show-options -g 2>/dev/null | grep -q '^@tmux-agents-status-'; then
	fail 'manual removal leaves no plugin global options'
fi
if tmux_test show-options -s 2>/dev/null | grep -q '^@tmux-agents-status-'; then
	fail 'manual removal leaves no plugin server options'
fi
assert_equal 'still-serving' "$(tmux_test display-message -p 'still-serving')" 'the tmux server is healthy after manual removal'

printf 'ok - the released core installs, reloads, cleans up, and removes cleanly\n'
