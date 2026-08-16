#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket=tmux-agents-status-uninstall-$$
tmp=${TMPDIR:-/tmp}/tmux-agents-status-uninstall-$$
mkdir "$tmp"

cleanup() {
	[ -z "${ordering_output_pid-}" ] || {
		kill "$ordering_output_pid" >/dev/null 2>&1 || :
		wait "$ordering_output_pid" 2>/dev/null || :
	}
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

# Discovery metadata alone is a successful public mutation and must refresh.
tmux_test set-option -g @tmux-agents-status-root "$root"
tmux_test set-option -g @tmux-agents-status-protocol 2
: >"$tmp/refresh-log"
FAKE_REFRESH_LOG="$tmp/refresh-log" \
TMUX="$(tmux_test display-message -p '#{socket_path}'),$$,0" \
	"$root/scripts/uninstall" >"$tmp/discovery-only-output" 2>"$tmp/discovery-only-error"
[ ! -s "$tmp/discovery-only-error" ] || fail 'discovery-only uninstall writes no diagnostic'
assert_equal 'uninstall' "$(cat "$tmp/refresh-log")" 'discovery-only uninstall refreshes after removing metadata'
assert_equal "$expected_output" "$(cat "$tmp/discovery-only-output")" 'discovery-only uninstall keeps manual guidance stable'
assert_absent_option -g @tmux-agents-status-root 'discovery-only uninstall removes root metadata'
assert_absent_option -g @tmux-agents-status-protocol 'discovery-only uninstall removes protocol metadata'

# The public uninstall seam must quiesce Core configuration before lifecycle
# deletion, then refresh once before emitting manual guidance.
rm -rf "$tmp/ordering-bin"
mkdir "$tmp/ordering-bin"
cat >"$tmp/ordering-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
refresh-client:*)
	printf '%s\n' refresh >>"$ORDER_TRACE"
	;;
set-hook:-gu:*)
	printf '%s\n' config-hook >>"$ORDER_TRACE"
	;;
set-option:-gu:*)
	printf '%s\n' config-option >>"$ORDER_TRACE"
	;;
set-option:-su:@tmux-agents-status-default-*|set-option:-su:@tmux-agents-status-hook-*)
	printf '%s\n' config-marker >>"$ORDER_TRACE"
	;;
set-option:-su:@tmux-agents-status-state-*|set-option:-su:@tmux-agents-status-ack-*)
	printf '%s\n' lifecycle-record >>"$ORDER_TRACE"
	;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/ordering-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s uninstall-ordering
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
pane=$(tmux_test display-message -p '#{pane_id}')
tmux_test set-option -s "@tmux-agents-status-state-$pane" 'v2|owner:ordering|-|-|failed|g:77777777777777777777777777777777|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" 'g:77777777777777777777777777777777'
# Replace only this scenario's refresh helper with a real tmux invocation so the
# delegating wrapper can observe the combined refresh event.
mv "$root/scripts/refresh-clients" "$tmp/ordering-refresh-clients"
cat >"$root/scripts/refresh-clients" <<'EOF'
#!/bin/sh
tmux refresh-client -S >/dev/null 2>&1 || :
EOF
chmod +x "$root/scripts/refresh-clients"
cat >"$tmp/record-guidance" <<'EOF'
#!/bin/sh
guidance_seen=false
while IFS= read -r line; do
	if [ "$guidance_seen" = false ]; then
		printf '%s\n' guidance >>"$ORDER_TRACE"
		guidance_seen=true
	fi
	printf '%s\n' "$line"
done
EOF
chmod +x "$tmp/record-guidance"
mkfifo "$tmp/ordering-output-pipe"
: >"$tmp/ordering-trace"
ORDER_TRACE="$tmp/ordering-trace" "$tmp/record-guidance" <"$tmp/ordering-output-pipe" >"$tmp/ordering-output" &
ordering_output_pid=$!
ordering_status=0
if REAL_TMUX="$(command -v tmux)" ORDER_TRACE="$tmp/ordering-trace" PATH="$tmp/ordering-bin:$PATH" \
	TMUX="$server_tmux" "$root/scripts/uninstall" >"$tmp/ordering-output-pipe" 2>"$tmp/ordering-error"; then
	ordering_status=0
else
	ordering_status=$?
fi
wait "$ordering_output_pid"
ordering_output_pid=
rm -f "$root/scripts/refresh-clients"
mv "$tmp/ordering-refresh-clients" "$root/scripts/refresh-clients"
[ "$ordering_status" -eq 0 ] || fail 'public uninstall ordering scenario completes cleanly'
[ ! -s "$tmp/ordering-error" ] || fail 'public uninstall ordering scenario writes no diagnostic'
last_config_line=$(grep -n '^config-' "$tmp/ordering-trace" | tail -n 1 | cut -d: -f1)
first_lifecycle_line=$(grep -n '^lifecycle-record$' "$tmp/ordering-trace" | head -n 1 | cut -d: -f1)
refresh_line=$(grep -n '^refresh$' "$tmp/ordering-trace" | tail -n 1 | cut -d: -f1)
guidance_line=$(grep -n '^guidance$' "$tmp/ordering-trace" | head -n 1 | cut -d: -f1)
[ -n "$last_config_line" ] && [ -n "$first_lifecycle_line" ] && [ "$last_config_line" -lt "$first_lifecycle_line" ] ||
	fail 'public uninstall quiesces configuration before deleting lifecycle records'
[ -n "$refresh_line" ] && [ "$first_lifecycle_line" -lt "$refresh_line" ] ||
	fail 'public uninstall refreshes after lifecycle deletion'
[ -n "$guidance_line" ] && [ "$refresh_line" -lt "$guidance_line" ] ||
	fail 'public uninstall refreshes before emitting manual guidance'
assert_equal "$expected_output" "$(cat "$tmp/ordering-output")" 'public uninstall keeps guidance after ordered cleanup'
assert_absent_server "@tmux-agents-status-state-$pane" 'ordered uninstall removes lifecycle state after configuration'
assert_absent_server "@tmux-agents-status-ack-$pane" 'ordered uninstall removes lifecycle acknowledgement after configuration'

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

# A readable but syntactically invalid source module must take the same bounded
# degradation path as a missing module instead of terminating before cleanup.
tmux_test set-option -s "@tmux-agents-status-state-$pane" 'v2|owner:syntax|-|-|failed|g:55555555555555555555555555555555|-|-'
tmux_test set-option -s "@tmux-agents-status-ack-$pane" 'g:55555555555555555555555555555555'
tmux_test set-option -g @tmux-agents-status-running-glyph preserve-with-syntax-error
tmux_test set-option -s @tmux-agents-status-default-running-glyph 1
tmux_test set-hook -g window-pane-changed 'display-message preserve-with-syntax-error'
: >"$tmp/refresh-log"
mv "$root/scripts/core-configuration" "$tmp/core-configuration"
printf '%s\n' 'if (' >"$root/scripts/core-configuration"
if FAKE_REFRESH_LOG="$tmp/refresh-log" TMUX="$server_tmux" "$root/scripts/uninstall" >"$tmp/syntax-output" 2>"$tmp/syntax-error"; then
	fail 'uninstall fails when the configuration ownership module is unloadable'
fi
rm -f "$root/scripts/core-configuration"
mv "$tmp/core-configuration" "$root/scripts/core-configuration"
assert_equal 'tmux-agents-status: uninstall: load failed' "$(cat "$tmp/syntax-error")" 'uninstall reports one bounded unloadability failure'
assert_equal "$expected_output" "$(cat "$tmp/syntax-output")" 'uninstall keeps manual guidance after an unloadability failure'
assert_absent_server "@tmux-agents-status-state-$pane" 'uninstall continues lifecycle cleanup after an unloadability failure'
assert_absent_server "@tmux-agents-status-ack-$pane" 'uninstall removes acknowledgement after an unloadability failure'
assert_equal preserve-with-syntax-error "$(global_option @tmux-agents-status-running-glyph)" 'unloadability failure skips configuration removal'
assert_equal 1 "$(server_option @tmux-agents-status-default-running-glyph)" 'unloadability failure preserves ownership evidence'
assert_equal 'window-pane-changed[0] display-message preserve-with-syntax-error' "$(tmux_test show-hooks -g window-pane-changed)" 'unloadability failure preserves managed hooks'
assert_equal uninstall "$(cat "$tmp/refresh-log")" 'uninstall refreshes after lifecycle cleanup when the module is unloadable failure'

rm -f "$root/scripts/refresh-clients"
mv "$tmp/refresh-clients" "$root/scripts/refresh-clients"

printf 'ok - core uninstall removes only plugin-owned runtime state\n'
