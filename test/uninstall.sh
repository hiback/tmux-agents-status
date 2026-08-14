#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-uninstall-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-uninstall-$$
mkdir "$tmp"

cleanup() {
	tmux -L "$socket" kill-server >/dev/null 2>&1 || :
	[ ! -e "$tmp/core-configuration" ] || mv "$tmp/core-configuration" "$root/scripts/core-configuration"
	if [ -e "$tmp/refresh-clients" ]; then
		rm -f "$root/scripts/refresh-clients"
		mv "$tmp/refresh-clients" "$root/scripts/refresh-clients"
	fi
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

assert_absent_server() {
	assert_absent_option -s "$1" "$2"
}

tmux_test -f /dev/null new-session -d -s uninstall
tmux_test set-option -g status-right 'user status #{E:@tmux-agents-status-other-sessions}'
tmux_test set-option -g window-status-format 'user window #{E:@tmux-agents-status-window}'
cat >"$tmp/tmux.conf" <<'EOF'
set -g @plugin 'hiback/tmux-agents-status'
run-shell ~/.tmux/plugins/tmux-agents-status/tmux-agents-status.tmux
set -g status-right '#{E:@tmux-agents-status-other-sessions}#S'
set -g window-status-format '#I:#W#{E:@tmux-agents-status-window}'
EOF
config_before=$(cksum "$tmp/tmux.conf")

mv "$root/scripts/refresh-clients" "$tmp/refresh-clients"
cat >"$root/scripts/refresh-clients" <<'EOF'
#!/bin/sh
[ -n "${FAKE_REFRESH_LOG-}" ] || exit 0
printf '%s\n' "${1-}" >>"$FAKE_REFRESH_LOG"
EOF
chmod +x "$root/scripts/refresh-clients"
: >"$tmp/refresh-log"

tmux_test run-shell "$root/tmux-agents-status.tmux"
set -- $(tmux_test display-message -p '#{pane_id}')
pane=$1
stale=%999991
tmux_test set-option -s "@tmux-agents-status-state-$pane" 'v2|owner:live|-|-|running|-|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" 'g:11111111111111111111111111111111'
tmux_test set-option -s "@tmux-agents-status-state-$stale" 'v2|owner:stale|-|-|failed|g:22222222222222222222222222222222|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$stale" 'g:22222222222222222222222222222222'

FAKE_REFRESH_LOG="$tmp/refresh-log" \
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
assert_equal 'uninstall' "$(cat "$tmp/refresh-log")" 'public uninstall refreshes after combined configuration and lifecycle changes'

assert_equal 'user status #{E:@tmux-agents-status-other-sessions}' "$(global_option status-right)" 'user status format is unchanged'
assert_equal 'user window #{E:@tmux-agents-status-window}' "$(global_option window-status-format)" 'user window format is unchanged'
for option in \
	"@tmux-agents-status-state-$pane" \
	"@tmux-agents-status-ack-$pane" \
	"@tmux-agents-status-state-$stale" \
	"@tmux-agents-status-ack-$stale"; do
	assert_absent_server "$option" "uninstall removes lifecycle option $option"
done

FAKE_REFRESH_LOG="$tmp/refresh-log" \
TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" \
	"$root/scripts/uninstall" >"$tmp/second-output" 2>"$tmp/second-error"
[ ! -s "$tmp/second-error" ] || fail 'repeated uninstall remains silent on stderr'
assert_equal 1 "$(wc -l <"$tmp/refresh-log" | tr -d ' ')" 'a no-change repeated uninstall does not refresh'
assert_equal "$expected_output" "$(cat "$tmp/second-output")" 'repeated uninstall is idempotent and keeps manual instructions stable'
assert_equal 'user status #{E:@tmux-agents-status-other-sessions}' "$(global_option status-right)" 'repeated uninstall preserves the user status format'

rm -rf "$tmp/public-query-failure-bin"
mkdir "$tmp/public-query-failure-bin"
cat >"$tmp/public-query-failure-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
show-option:-sv:@tmux-agents-status-default-running-style) exit 1 ;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/public-query-failure-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s uninstall-query-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
pane=$(tmux_test display-message -p '#{pane_id}')
tmux_test set-option -s "@tmux-agents-status-state-$pane" 'v2|owner:stale|-|-|failed|g:33333333333333333333333333333333|-|-'
if REAL_TMUX="$(command -v tmux)" PATH="$tmp/public-query-failure-bin:$PATH" \
	TMUX="$server_tmux" "$root/scripts/uninstall" >"$tmp/query-output" 2>"$tmp/query-error"; then
	fail 'public uninstall returns failure after a configuration query failure'
fi
assert_equal 'tmux-agents-status: uninstall: query failed' "$(cat "$tmp/query-error")" 'public uninstall maps a configuration query fact to one bounded diagnostic'
assert_equal "$expected_output" "$(cat "$tmp/query-output")" 'public uninstall keeps manual guidance after a configuration query failure'
assert_absent_server "@tmux-agents-status-state-$pane" 'public uninstall continues lifecycle cleanup after a configuration query failure'

rm -rf "$tmp/public-write-failure-bin"
mkdir "$tmp/public-write-failure-bin"
cat >"$tmp/public-write-failure-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
set-option:-su:@tmux-agents-status-default-running-style)
	printf '%s\n' "$1 $2 $3" >>"$FAKE_PUBLIC_WRITE_LOG"
	exit 1
	;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/public-write-failure-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s uninstall-write-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
: >"$tmp/public-write-failure-log"
if REAL_TMUX="$(command -v tmux)" FAKE_PUBLIC_WRITE_LOG="$tmp/public-write-failure-log" PATH="$tmp/public-write-failure-bin:$PATH" \
	TMUX="$server_tmux" "$root/scripts/uninstall" >"$tmp/write-output" 2>"$tmp/write-error"; then
	fail 'public uninstall returns failure after a configuration write failure'
fi
assert_equal 'tmux-agents-status: uninstall: write failed' "$(cat "$tmp/write-error")" 'public uninstall maps a configuration write fact to one bounded diagnostic'
assert_equal "$expected_output" "$(cat "$tmp/write-output")" 'public uninstall keeps manual guidance after a configuration write failure'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s uninstall-missing-module
set -- $(tmux_test display-message -p '#{socket_path} #{pane_id}')
server_tmux=$1,$$,0
pane=$2
tmux_test set-option -s "@tmux-agents-status-state-$pane" 'v2|owner:stale|-|-|failed|g:11111111111111111111111111111111|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" 'g:11111111111111111111111111111111'
tmux_test set-option -g @tmux-agents-status-running-glyph 'preserve-without-module'
tmux_test set-option -s @tmux-agents-status-default-running-glyph 1
tmux_test set-hook -g window-pane-changed 'display-message preserve-without-module'
: >"$tmp/refresh-log"
mv "$root/scripts/core-configuration" "$tmp/core-configuration"
if FAKE_REFRESH_LOG="$tmp/refresh-log" TMUX="$server_tmux" "$root/scripts/uninstall" >"$tmp/missing-output" 2>"$tmp/missing-error"; then
	fail 'uninstall fails when the configuration ownership module is unavailable'
fi
mv "$tmp/core-configuration" "$root/scripts/core-configuration"
assert_equal 'tmux-agents-status: uninstall: load failed' "$(cat "$tmp/missing-error")" 'uninstall reports one bounded module load failure'
assert_equal "$expected_output" "$(cat "$tmp/missing-output")" 'uninstall keeps manual guidance when the module is unavailable'
assert_absent_server "@tmux-agents-status-state-$pane" 'uninstall continues lifecycle cleanup when the module is unavailable'
assert_absent_server "@tmux-agents-status-ack-$pane" 'uninstall removes acknowledgement with module load failure'
assert_equal preserve-without-module "$(global_option @tmux-agents-status-running-glyph)" 'module load failure skips configuration removal'
assert_equal 1 "$(server_option @tmux-agents-status-default-running-glyph)" 'module load failure preserves ownership evidence'
assert_equal 'window-pane-changed[0] display-message preserve-without-module' "$(tmux_test show-hooks -g window-pane-changed)" 'module load failure preserves managed hooks'
assert_equal 'uninstall' "$(cat "$tmp/refresh-log")" 'public uninstall refreshes after lifecycle cleanup when the ownership module is missing'

rm -f "$root/scripts/refresh-clients"
mv "$tmp/refresh-clients" "$root/scripts/refresh-clients"

printf 'ok - core uninstall removes only plugin-owned runtime state\n'
