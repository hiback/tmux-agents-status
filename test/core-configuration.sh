#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
socket_prefix=tmux-agents-status-core-configuration-$$
socket="$socket_prefix-0"
sockets=$socket
socket_index=0
tmp=${TMPDIR:-/tmp}/tmux-agents-status-core-configuration-$$
mkdir "$tmp"
no_refresh_client_pid=

cleanup() {
	if [ -n "$no_refresh_client_pid" ]; then
		kill "$no_refresh_client_pid" >/dev/null 2>&1 || :
		wait "$no_refresh_client_pid" 2>/dev/null || :
	fi
	for cleanup_socket in $sockets; do
		tmux -L "$cleanup_socket" kill-server >/dev/null 2>&1 || :
	done
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

# A pane-exited run-shell can outlive kill-server. Never reuse its socket for
# the next scenario, so the old callback cannot reach a newly created server.
tmux_test() {
	if [ "${1-}" = kill-server ]; then
		tmux -L "$socket" "$@"
		socket_index=$((socket_index + 1))
		socket="$socket_prefix-$socket_index"
		sockets="$sockets $socket"
		return 0
	fi
	tmux -L "$socket" "$@"
}

global_option() {
	tmux_test show-option -gqv "$1"
}

server_option() {
	tmux_test show-option -sqv "$1"
}

assert_absent_global() {
	options=$(tmux_test show-options -g 2>/dev/null) || fail "$2 (cannot inspect global options)"
	if printf '%s\n' "$options" | awk -v option="$1" '$1 == option { found = 1 } END { exit !found }'; then
		fail "$2"
	fi
}

assert_absent_server() {
	options=$(tmux_test show-options -s 2>/dev/null) || fail "$2 (cannot inspect server options)"
	if printf '%s\n' "$options" | awk -v option="$1" '$1 == option { found = 1 } END { exit !found }'; then
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

# Direct intents preserve their public mutation phase boundaries.
rm -rf "$tmp/phase-order-bin"
mkdir "$tmp/phase-order-bin"
cat >"$tmp/phase-order-bin/tmux" <<'EOF'
#!/bin/sh
stage=
case "$1:$2:$3" in
set-option:-g:@tmux-agents-status-root|set-option:-g:@tmux-agents-status-protocol|set-option:-gu:@tmux-agents-status-root|set-option:-gu:@tmux-agents-status-protocol)
	stage=discovery
	;;
set-hook:-ag:*|set-hook:-gu:*|set-option:-s:@tmux-agents-status-hook-*|set-option:-su:@tmux-agents-status-hook-*)
	stage=hooks
	;;
set-option:-go:@tmux-agents-status-*|set-option:-gu:@tmux-agents-status-*|set-option:-s:@tmux-agents-status-default-*|set-option:-su:@tmux-agents-status-default-*)
	stage=defaults
	;;
set-option:*|set-hook:*)
	stage=unexpected
	;;
esac
[ -z "$stage" ] || printf '%s %s %s %s %s\n' "${ORDER_MODE-}" "$stage" "$1" "$2" "$3" >>"$ORDER_TRACE"
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/phase-order-bin/tmux"
assert_phase_order() {
	phase_trace=$1
	phase_mode=$2
	phase_first=$3
	phase_second=$4
	phase_third=$5
	phase_label=$6
	if ! awk -v mode="$phase_mode" -v first="$phase_first" -v second="$phase_second" -v third="$phase_third" '
		BEGIN {
			rank[first] = 1
			rank[second] = 2
			rank[third] = 3
			last = 0
		}
		$1 == mode {
			if (!($2 in rank) || rank[$2] < last) {
				bad = 1
			} else {
				last = rank[$2]
			}
			seen[$2] = 1
		}
		END {
			if (bad || !seen[first] || !seen[second] || !seen[third]) exit 1
		}
	' "$phase_trace"; then
		fail "$phase_label"
	fi
}
real_tmux=$(command -v tmux)
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s direct-phase-order
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
: >"$tmp/phase-order-trace"
if ! REAL_TMUX="$real_tmux" ORDER_MODE=install ORDER_TRACE="$tmp/phase-order-trace" PATH="$tmp/phase-order-bin:$PATH" \
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"; then
	fail 'direct installation phase-order scenario completes cleanly'
fi
assert_phase_order "$tmp/phase-order-trace" install discovery hooks defaults 'direct installation mutates discovery metadata before hooks before defaults'
if ! REAL_TMUX="$real_tmux" ORDER_MODE=remove ORDER_TRACE="$tmp/phase-order-trace" PATH="$tmp/phase-order-bin:$PATH" \
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_remove_core_configuration' sh "$root"; then
	fail 'direct removal phase-order scenario completes cleanly'
fi
assert_phase_order "$tmp/phase-order-trace" remove hooks defaults discovery 'direct removal mutates hooks before defaults before discovery metadata'

# Direct removal owns configuration only; a real tmux wrapper must observe no refresh.
rm -rf "$tmp/no-refresh-bin"
mkdir "$tmp/no-refresh-bin"
cat >"$tmp/no-refresh-bin/tmux" <<'EOF'
#!/bin/sh
case " $* " in
*" refresh-client "*)
	printf '%s\n' refresh-client >>"$NO_REFRESH_TRACE"
	;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/no-refresh-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s direct-no-refresh
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0

# An actual attached control-mode client makes both direct refresh-client calls
# and production refresh-helper calls observable through the delegating wrapper.
tmux_test set-hook -ag client-attached 'wait-for -S tas-core-configuration-client-attached'
no_refresh_fifo=$tmp/no-refresh-input
mkfifo "$no_refresh_fifo"
tmux -L "$socket" -C attach-session -t direct-no-refresh \
	<"$no_refresh_fifo" >"$tmp/no-refresh-output" 2>"$tmp/no-refresh-error" &
no_refresh_client_pid=$!
exec 8>"$no_refresh_fifo"
tmux_test wait-for tas-core-configuration-client-attached
[ -n "$(tmux_test list-clients -F '#{client_name}')" ] || fail 'direct removal refresh guard has an attached client'

: >"$tmp/no-refresh-trace"
if ! REAL_TMUX="$real_tmux" NO_REFRESH_TRACE="$tmp/no-refresh-trace" PATH="$tmp/no-refresh-bin:$PATH" \
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1" && tas_remove_core_configuration' sh "$root"; then
	fail 'direct removal without a refresh completes cleanly'
fi
[ ! -s "$tmp/no-refresh-trace" ] || fail 'direct removal never invokes refresh directly or through the production helper'
exec 8>&-
wait "$no_refresh_client_pid" 2>/dev/null || :
no_refresh_client_pid=

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

# A missing marker must not authorize removal when tmux returns a successful
# empty named read for an unknown option (tmux 3.1b behavior).
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-unmarked-values
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-option -g @tmux-agents-status-running-style 'fg=cyan'
tmux_test set-option -g @tmux-agents-status-waiting-style 'user-style'
tmux_test set-option -g @tmux-agents-status-failed-style ''
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration' sh "$root"
assert_equal 'fg=cyan' "$(global_option @tmux-agents-status-running-style)" 'an unmarked equal default remains user-owned during removal'
assert_equal 'user-style' "$(global_option @tmux-agents-status-waiting-style)" 'an unmarked custom value remains user-owned during removal'
assert_equal '' "$(global_option @tmux-agents-status-failed-style)" 'an unmarked empty value remains user-owned during removal'

# An explicitly present empty marker remains distinct from a missing marker.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-empty-marker
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-option -g @tmux-agents-status-running-style 'fg=cyan'
tmux_test set-option -s @tmux-agents-status-default-running-style ''
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration' sh "$root"
assert_absent_global @tmux-agents-status-running-style 'an explicitly present empty marker authorizes removal of its unchanged default'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s reload
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
tmux_test set-option -g @tmux-agents-status-running-glyph user-change
tmux_test set-option -g @tmux-agents-status-root /stale/root
tmux_test set-option -g @tmux-agents-status-protocol 99
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "$root" "$(global_option @tmux-agents-status-root)" 'reload refreshes the canonical checkout root'
assert_equal '2' "$(global_option @tmux-agents-status-protocol)" 'reload refreshes the normalized protocol major'
assert_equal user-change "$(global_option @tmux-agents-status-running-glyph)" 'reload preserves a user change to a Core default'
assert_equal 'window-pane-changed[0] '"$hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'reload does not duplicate a valid owned hook'

# Repairing one missing owned hook leaves completed hook arrays and evidence unchanged.
window_pane_hooks_before=$(tmux_test show-hooks -g window-pane-changed)
window_pane_marker_before=$(server_option @tmux-agents-status-hook-window-pane-changed)
client_session_hooks_before=$(tmux_test show-hooks -g client-session-changed)
client_session_marker_before=$(server_option @tmux-agents-status-hook-client-session-changed)
client_attached_hooks_before=$(tmux_test show-hooks -g client-attached)
client_attached_marker_before=$(server_option @tmux-agents-status-hook-client-attached)
pane_exited_hooks_before=$(tmux_test show-hooks -g pane-exited)
pane_exited_marker_before=$(server_option @tmux-agents-status-hook-pane-exited)
tmux_test set-hook -gu session-window-changed
tmux_test set-option -su @tmux-agents-status-hook-session-window-changed
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal 'session-window-changed[0] '"$hook_command" "$(tmux_test show-hooks -g session-window-changed)" 'a missing owned hook is repaired during direct installation'
assert_equal 'session-window-changed[0]' "$(server_option @tmux-agents-status-hook-session-window-changed)" 'repair records the new owned hook selector'
assert_equal "$window_pane_hooks_before" "$(tmux_test show-hooks -g window-pane-changed)" 'repair leaves a completed pane-selection hook array unchanged'
assert_equal "$window_pane_marker_before" "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'repair leaves completed pane-selection ownership evidence unchanged'
assert_equal "$client_session_hooks_before" "$(tmux_test show-hooks -g client-session-changed)" 'repair leaves a completed session hook array unchanged'
assert_equal "$client_session_marker_before" "$(server_option @tmux-agents-status-hook-client-session-changed)" 'repair leaves completed session ownership evidence unchanged'
assert_equal "$client_attached_hooks_before" "$(tmux_test show-hooks -g client-attached)" 'repair leaves a completed attachment hook array unchanged'
assert_equal "$client_attached_marker_before" "$(server_option @tmux-agents-status-hook-client-attached)" 'repair leaves completed attachment ownership evidence unchanged'
assert_equal "$pane_exited_hooks_before" "$(tmux_test show-hooks -g pane-exited)" 'repair leaves a completed pane-exit hook array unchanged'
assert_equal "$pane_exited_marker_before" "$(server_option @tmux-agents-status-hook-pane-exited)" 'repair leaves completed pane-exit ownership evidence unchanged'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-append
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'installation appends after a user hook'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'Core configuration ownership records the appended selector after a user hook'

# Selector rediscovery may fail after a real append; the legacy fallback must be
# recoverable by a later public intent without duplicating or losing the hook.
tmux_test kill-server
rm -rf "$tmp/rediscovery-bin"
mkdir "$tmp/rediscovery-bin"
cat >"$tmp/rediscovery-bin/tmux" <<'EOF'
#!/bin/sh
if [ "$1:$2:$3" = 'show-hooks:-g:window-pane-changed' ] && [ ! -e "$FAIL_REDISCOVERY_ONCE" ]; then
	: >"$FAIL_REDISCOVERY_ONCE"
	exit 1
fi
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/rediscovery-bin/tmux"
tmux_test -f /dev/null new-session -d -s hook-rediscovery-fallback
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
if ! REAL_TMUX="$real_tmux" FAIL_REDISCOVERY_ONCE="$tmp/rediscovery-once" PATH="$tmp/rediscovery-bin:$PATH" \
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"; then
	fail 'a selector rediscovery failure remains recoverable after a successful hook append'
fi
assert_equal "window-pane-changed[0] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'selector rediscovery fallback preserves the real appended hook'
assert_equal 1 "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'selector rediscovery fallback records legacy ownership evidence'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a later load reconciles fallback evidence without duplicating the hook'
assert_equal 'window-pane-changed[0]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a later load migrates fallback evidence to the exact selector'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'removal coordinates with reconciled selector evidence'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'removal clears reconciled fallback evidence'
if [ -n "$(tmux_test show-hooks -g window-pane-changed 2>/dev/null | awk 'NF > 1')" ]; then
	fail 'removal clears the fallback-owned hook after reconciliation'
fi

# An operational selector parser failure remains a bounded direct-intent result.
rm -rf "$tmp/awk-failure-bin"
mkdir "$tmp/awk-failure-bin"
real_awk=$(command -v awk)
cat >"$tmp/awk-failure-bin/awk" <<'EOF'
#!/bin/sh
case "$*" in
*maximum*)
	printf '%s\n' 'injected awk operational failure' >&2
	exit 2
	;;
*)
	exec "$REAL_AWK" "$@"
	;;
esac
EOF
chmod +x "$tmp/awk-failure-bin/awk"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-awk-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed "$hook_command"
tmux_test set-hook -ag window-pane-changed "$hook_command"
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 1
if awk_failure_facts=$(REAL_AWK="$real_awk" PATH="$tmp/awk-failure-bin:$PATH" TMUX="$server_tmux" sh -c '
. "$1/scripts/core-configuration" || exit 1
tas_remove_core_configuration >"$2" 2>"$3"
status=$?
printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"
exit "$status"
' sh "$root" "$tmp/awk-failure-output" "$tmp/awk-failure-error"); then
	fail 'a selector parser failure returns operational failure after best-effort traversal'
fi
assert_equal '1 true true false' "$awk_failure_facts" 'selector parser failure exposes only content-free removal facts'
[ ! -s "$tmp/awk-failure-output" ] || fail 'selector parser failure writes no direct-intent stdout'
[ ! -s "$tmp/awk-failure-error" ] || fail 'selector parser failure writes no direct-intent diagnostics'
assert_equal "window-pane-changed[0] $hook_command
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'selector parser failure preserves uncertain identical hook occurrences'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'selector parser failure still removes its ownership marker'

# A parser that publishes a selector before failing must not authorize hook removal.
rm -rf "$tmp/awk-partial-bin"
mkdir "$tmp/awk-partial-bin"
real_awk=$(command -v awk)
cat >"$tmp/awk-partial-bin/awk" <<'EOF'
#!/bin/sh
case ${5-} in
*maximum*)
	"$REAL_AWK" "$@"
	printf '%s\n' 'raw partial selector parser failure' >&2
	exit 2
	;;
esac
exec "$REAL_AWK" "$@"
EOF
chmod +x "$tmp/awk-partial-bin/awk"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-awk-partial
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed "$hook_command"
tmux_test set-hook -ag window-pane-changed "$hook_command"
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 1
if partial_facts=$(REAL_TMUX="$real_tmux" REAL_AWK="$real_awk" PATH="$tmp/awk-partial-bin:$PATH" TMUX="$server_tmux" sh -c '
. "$1/scripts/core-configuration" || exit 1
tas_remove_core_configuration >"$2" 2>"$3"
status=$?
printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"
exit "$status"
' sh "$root" "$tmp/awk-partial-output" "$tmp/awk-partial-error"); then
	fail 'a partial selector parser result returns operational failure after best-effort traversal'
fi
assert_equal '1 true true false' "$partial_facts" 'partial selector parser output exposes only content-free removal facts'
[ ! -s "$tmp/awk-partial-output" ] || fail 'partial selector parser output does not leak direct-intent stdout'
[ ! -s "$tmp/awk-partial-error" ] || fail 'partial selector parser output does not leak direct-intent diagnostics'
assert_equal "window-pane-changed[0] $hook_command
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'partial selector parser output preserves every uncertain hook occurrence'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'partial selector parser output still removes only its ownership marker'

# An append failure leaves user hooks and ownership evidence recoverable.
rm -rf "$tmp/append-failure-bin"
mkdir "$tmp/append-failure-bin"
cat >"$tmp/append-failure-bin/tmux" <<'EOF'
#!/bin/sh
if [ "$1:$2:$3" = 'set-hook:-ag:window-pane-changed' ] && [ ! -e "$FAIL_APPEND_ONCE" ]; then
	: >"$FAIL_APPEND_ONCE"
	exit 1
fi
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/append-failure-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s hook-append-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
if REAL_TMUX="$real_tmux" FAIL_APPEND_ONCE="$tmp/append-failure-once" PATH="$tmp/append-failure-bin:$PATH" \
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"; then
	fail 'a failed hook append aborts direct installation'
fi
assert_equal 'window-pane-changed[0] display-message user-before' "$(tmux_test show-hooks -g window-pane-changed)" 'a failed hook append preserves the user hook'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'a failed hook append does not claim exact ownership'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[1] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'a later install recovers a failed hook append'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a recovered append records exact ownership evidence'

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

# Expected ownership non-matches must not make the public fail-fast loader abort.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s loader-stale
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[0]'
TMUX="$server_tmux" "$root/tmux-agents-status.tmux" ||
	fail 'the public loader tolerates expected ownership non-matches under fail-fast shell options'
assert_equal "$root" "$(global_option @tmux-agents-status-root)" 'the public loader still completes discovery after ownership repair'

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

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-clean
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
remove_facts=$(TMUX="$server_tmux" sh -c '
. "$1/scripts/core-configuration" || exit 1
tas_install_core_configuration "$1" || exit 1
tas_remove_core_configuration
status=$?
printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"
exit "$status"
' sh "$root") || fail 'the remove intent completes cleanly after installation'
assert_equal '0 true false false' "$remove_facts" 'the remove intent reports clean completion and changed configuration'
assert_absent_global @tmux-agents-status-root 'removal removes discovery root metadata'
assert_absent_global @tmux-agents-status-protocol 'removal removes discovery protocol metadata'
assert_absent_global @tmux-agents-status-window 'removal removes the managed window default'
assert_absent_server @tmux-agents-status-default-window 'removal removes the window ownership marker'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'removal removes hook ownership evidence'
if [ -n "$(tmux_test show-hooks -g window-pane-changed 2>/dev/null | awk 'NF > 1')" ]; then
	fail 'removal removes the managed window-pane hook'
fi

# A second remove with the ownership marker already gone must preserve a known user hook.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-repeated-user-hook
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
user_hook='window-pane-changed[0] display-message user-before'
tmux_test set-hook -g window-pane-changed 'display-message user-before'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
first_remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$first_remove_facts" 'the first remove clears owned configuration around a user hook'
assert_equal "$user_hook" "$(tmux_test show-hooks -g window-pane-changed)" 'the first remove preserves the known user hook'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'the first remove clears the hook ownership marker'
second_remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 false false false' "$second_remove_facts" 'a repeated remove with no marker completes without mutation'
assert_equal "$user_hook" "$(tmux_test show-hooks -g window-pane-changed)" 'a repeated remove with no marker leaves the known user hook unchanged'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-selective
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-option -g @tmux-agents-status-waiting-glyph '?'
tmux_test set-option -g @tmux-agents-status-waiting-style ''
tmux_test set-option -g @tmux-agents-status-unknown-global keep-global
tmux_test set-option -s @tmux-agents-status-unknown-server keep-server
tmux_test set-option -s @tmux-agents-status-unknown-marker keep-marker
tmux_test set-hook -g window-pane-changed 'display-message user-before'
tmux_test set-hook -g @tmux-agents-status-unknown-hook 'display-message unknown-hook'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
tmux_test set-option -g @tmux-agents-status-running-glyph user-running
tmux_test set-hook -ag window-pane-changed 'display-message user-after'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'removal completes after processing selective ownership'
assert_equal user-running "$(global_option @tmux-agents-status-running-glyph)" 'a changed owned default remains user-owned'
assert_absent_server @tmux-agents-status-default-running-glyph 'a changed owned default loses its ownership marker'
assert_equal '?' "$(global_option @tmux-agents-status-waiting-glyph)" 'an equal user-owned default remains after removal'
assert_equal '' "$(global_option @tmux-agents-status-waiting-style)" 'an empty user-owned default remains after removal'
assert_absent_global @tmux-agents-status-running-style 'an unchanged owned default is removed'
assert_equal keep-global "$(global_option @tmux-agents-status-unknown-global)" 'an unknown prefixed global option survives removal'
assert_equal keep-server "$(server_option @tmux-agents-status-unknown-server)" 'an unknown prefixed server option survives removal'
assert_equal keep-marker "$(server_option @tmux-agents-status-unknown-marker)" 'an unknown prefixed marker survives removal'
assert_equal "window-pane-changed[0] display-message user-before
window-pane-changed[2] display-message user-after" "$(tmux_test show-hooks -g window-pane-changed)" 'removal preserves hooks before and after Core ownership'
assert_equal '@tmux-agents-status-unknown-hook "display-message unknown-hook"' "$(tmux_test show-hooks -g @tmux-agents-status-unknown-hook)" 'removal preserves an unknown prefixed hook'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-interface
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
invalid_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"; tas_remove_core_configuration unexpected >"$2" 2>"$3"; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"' sh "$root" "$tmp/remove-invalid-output" "$tmp/remove-invalid-error")
assert_equal '64 false false false' "$invalid_facts" 'invalid removal use is rejected before mutation with reset facts'
[ ! -s "$tmp/remove-invalid-output" ] || fail 'invalid removal use writes no stdout'
[ ! -s "$tmp/remove-invalid-error" ] || fail 'invalid removal use writes no diagnostics'
assert_equal "$root" "$(global_option @tmux-agents-status-root)" 'invalid removal use leaves managed configuration untouched'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'a valid removal reports changed configuration after invalid use'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 false false false' "$remove_facts" 'a repeated removal resets changed and failure facts'

# Discovery metadata is independently removable and counts as a mutation.
tmux_test set-option -g @tmux-agents-status-root "$root"
tmux_test set-option -g @tmux-agents-status-protocol 2
discovery_only_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$discovery_only_facts" 'discovery-only removal reports a clean mutation'
assert_absent_global @tmux-agents-status-root 'discovery-only removal removes the root metadata'
assert_absent_global @tmux-agents-status-protocol 'discovery-only removal removes the protocol metadata'

rm -rf "$tmp/reset-bin"
mkdir "$tmp/reset-bin"
cat >"$tmp/reset-bin/tmux" <<'EOF'
#!/bin/sh
if [ ! -e "$RESET_MODE" ]; then
	case "$1:$2:$3" in
	show-option:-sv:@tmux-agents-status-default-running-style)
		exit 1
		;;
	set-option:-su:@tmux-agents-status-default-running-glyph)
		"$REAL_TMUX" "$@"
		exit 1
		;;
	esac
fi
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/reset-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-result-reset
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
reset_facts=$(REAL_TMUX="$real_tmux" RESET_MODE="$tmp/reset-mode" PATH="$tmp/reset-bin:$PATH" TMUX="$server_tmux" sh -c '
. "$1/scripts/core-configuration" || exit 1
tas_install_core_configuration "$1" || exit 1
tas_remove_core_configuration
first_status=$?
printf "first %s %s %s %s\\n" "$first_status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"
"$REAL_TMUX" set-option -su @tmux-agents-status-default-running-style || exit 1
: >"$2"
tas_remove_core_configuration
second_status=$?
printf "second %s %s %s %s\\n" "$second_status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"
exit "$second_status"
' sh "$root" "$tmp/reset-mode") || fail 'same-shell removal result reset completes after an operational failure'
assert_equal 'first 1 true true true
second 0 false false false' "$reset_facts" 'a second removal in the same shell resets every stale result fact'

rm -rf "$tmp/query-failure-bin"
mkdir "$tmp/query-failure-bin"
cat >"$tmp/query-failure-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
show-option:-sv:@tmux-agents-status-default-running-style) exit 1 ;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/query-failure-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-query-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
if remove_facts=$(REAL_TMUX="$real_tmux" PATH="$tmp/query-failure-bin:$PATH" TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root"); then
	fail 'a reportable query failure returns operational failure after traversal'
fi
assert_equal '1 true true false' "$remove_facts" 'query failure facts remain content-free while traversal continues'
assert_equal '' "$(global_option @tmux-agents-status-waiting-glyph)" 'a later default is removed after a query failure'
assert_absent_global @tmux-agents-status-root 'discovery metadata is removed after a query failure'
assert_equal '1' "$(server_option @tmux-agents-status-default-running-style)" 'the queried default marker remains for a later retry'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'a later removal retries a failed query item cleanly'

rm -rf "$tmp/write-failure-bin"
mkdir "$tmp/write-failure-bin"
cat >"$tmp/write-failure-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
set-option:-su:@tmux-agents-status-default-running-style)
	printf '%s\n' "$1 $2 $3" >>"$FAKE_WRITE_LOG"
	exit 1
	;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/write-failure-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-write-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
: >"$tmp/write-failure-log"
if remove_facts=$(REAL_TMUX="$real_tmux" FAKE_WRITE_LOG="$tmp/write-failure-log" PATH="$tmp/write-failure-bin:$PATH" TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root"); then
	fail 'a reportable write failure returns operational failure after traversal'
fi
assert_equal '1 true false true' "$remove_facts" 'write failure facts remain content-free while traversal continues'
assert_equal 1 "$(wc -l <"$tmp/write-failure-log" | tr -d ' ')" 'a failed marker receives one removal attempt in one invocation'
assert_equal '' "$(global_option @tmux-agents-status-waiting-glyph)" 'a later default is removed after a write failure'
assert_absent_global @tmux-agents-status-root 'discovery metadata is removed after a write failure'
assert_equal '1' "$(server_option @tmux-agents-status-default-running-style)" 'a failed marker remains available for repeated uninstall'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'a repeated removal retries a failed write cleanly'

# A failed hook-marker write is attempted once, while later catalog entries
# still traverse; a later invocation is the retry path.
rm -rf "$tmp/hook-write-failure-bin"
mkdir "$tmp/hook-write-failure-bin"
cat >"$tmp/hook-write-failure-bin/tmux" <<'EOF'
#!/bin/sh
case "$1:$2:$3" in
set-option:-su:@tmux-agents-status-hook-window-pane-changed)
	printf '%s\n' "$1 $2 $3" >>"$FAKE_HOOK_WRITE_LOG"
	exit 1
	;;
esac
exec "$REAL_TMUX" "$@"
EOF
chmod +x "$tmp/hook-write-failure-bin/tmux"
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-hook-write-failure
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
: >"$tmp/hook-write-failure-log"
if remove_facts=$(REAL_TMUX="$real_tmux" FAKE_HOOK_WRITE_LOG="$tmp/hook-write-failure-log" PATH="$tmp/hook-write-failure-bin:$PATH" \
	TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root"); then
	fail 'a failed hook-marker write returns operational failure after traversal'
fi
assert_equal '1 true false true' "$remove_facts" 'hook-marker write failure remains a bounded result fact'
assert_equal 1 "$(wc -l <"$tmp/hook-write-failure-log" | tr -d ' ')" 'a failed hook marker receives one removal attempt in one invocation'
assert_equal 'window-pane-changed[0]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'a failed hook-marker write preserves evidence for a later retry'
if [ -n "$(tmux_test show-hooks -g window-pane-changed 2>/dev/null | awk 'NF > 1')" ]; then
	fail 'hook traversal removes the owned hook despite a marker write failure'
fi
assert_equal '' "$(global_option @tmux-agents-status-waiting-glyph)" 'hook-marker failure does not stop later default removal'
assert_absent_global @tmux-agents-status-root 'hook-marker failure does not stop discovery removal'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'a later remove retries the failed hook-marker write'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'a later remove clears the retried hook marker'

# Exact ownership removes only its recorded selector beside identical user commands.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-exact-identical-hook
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed "$hook_command"
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
tmux_test set-hook -ag window-pane-changed "$hook_command"
assert_equal "window-pane-changed[0] $hook_command
window-pane-changed[1] $hook_command
window-pane-changed[2] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'exact setup records the middle identical occurrence'
assert_equal 'window-pane-changed[1]' "$(server_option @tmux-agents-status-hook-window-pane-changed)" 'exact setup records the Core-owned selector'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'exact removal completes beside identical user commands'
assert_equal "window-pane-changed[0] $hook_command
window-pane-changed[2] $hook_command" "$(tmux_test show-hooks -g window-pane-changed)" 'exact removal preserves identical user occurrences'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'exact removal clears only its ownership evidence'

# Exact ownership leaves user hooks on both sides untouched.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-exact-hook
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-before'
TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration" && tas_install_core_configuration "$1"' sh "$root"
tmux_test set-hook -ag window-pane-changed 'display-message user-after'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'exact ownership removes only the recorded hook occurrence'
assert_equal 'window-pane-changed[0] display-message user-before
window-pane-changed[2] display-message user-after' "$(tmux_test show-hooks -g window-pane-changed)" 'exact hook removal preserves surrounding user hooks'

# Legacy ownership removes one maximum numeric exact occurrence.
tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-legacy-hook
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
for selector_number in 0 1 2 3 4 5 6 7 8 9 10; do
	case $selector_number in
	2 | 10) hook_entry=$hook_command ;;
	*) hook_entry="display-message user-$selector_number" ;;
	esac
	tmux_test set-hook -ag window-pane-changed "$hook_entry"
done
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 1
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'legacy ownership removes one exact hook after best-effort selection'
assert_equal "window-pane-changed[0] display-message user-0
window-pane-changed[1] display-message user-1
window-pane-changed[2] $hook_command
window-pane-changed[3] display-message user-3
window-pane-changed[4] display-message user-4
window-pane-changed[5] display-message user-5
window-pane-changed[6] display-message user-6
window-pane-changed[7] display-message user-7
window-pane-changed[8] display-message user-8
window-pane-changed[9] display-message user-9" "$(tmux_test show-hooks -g window-pane-changed)" 'legacy removal chooses the numeric maximum and preserves identical siblings'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'legacy hook evidence is removed once'

for marker_value in 'window-pane-changed[99]' 'window-pane-changed[not-numeric]'; do
	tmux_test kill-server
	tmux_test -f /dev/null new-session -d -s remove-stale-hook
	server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
	tmux_test set-hook -g window-pane-changed 'display-message user-only'
	tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed "$marker_value"
	remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
	assert_equal '0 true false false' "$remove_facts" 'stale or malformed hook evidence is removed without operational failure'
	assert_equal 'window-pane-changed[0] display-message user-only' "$(tmux_test show-hooks -g window-pane-changed)" 'stale or malformed evidence preserves the uncertain hook'
	assert_absent_server @tmux-agents-status-hook-window-pane-changed 'stale or malformed evidence receives one marker removal'
done

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-mismatched-hook
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-hook -g window-pane-changed 'display-message user-only'
tmux_test set-option -s @tmux-agents-status-hook-window-pane-changed 'window-pane-changed[0]'
remove_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root")
assert_equal '0 true false false' "$remove_facts" 'mismatched hook evidence completes without removing a user hook'
assert_equal 'window-pane-changed[0] display-message user-only' "$(tmux_test show-hooks -g window-pane-changed)" 'mismatched evidence preserves the user command'
assert_absent_server @tmux-agents-status-hook-window-pane-changed 'mismatched evidence removes only its marker'

tmux_test kill-server
tmux_test -f /dev/null new-session -d -s remove-marker-only
server_tmux=$(tmux_test display-message -p '#{socket_path}'),$$,0
tmux_test set-option -s @tmux-agents-status-default-running-glyph 1
tmux_test set-option -g @tmux-agents-status-failed-glyph user-failed
marker_facts=$(TMUX="$server_tmux" sh -c '. "$1/scripts/core-configuration"; tas_remove_core_configuration >"$2" 2>"$3"; status=$?; printf "%s %s %s %s\\n" "$status" "$tas_core_configuration_changed" "$tas_core_configuration_query_failed" "$tas_core_configuration_write_failed"; exit "$status"' sh "$root" "$tmp/remove-marker-output" "$tmp/remove-marker-error")
assert_equal '0 true false false' "$marker_facts" 'ownership-marker-only cleanup counts as configuration change'
[ ! -s "$tmp/remove-marker-output" ] || fail 'remove writes no stdout through the public intent'
[ ! -s "$tmp/remove-marker-error" ] || fail 'remove emits no diagnostics through the public intent'
assert_absent_server @tmux-agents-status-default-running-glyph 'marker-only cleanup removes its evidence'
assert_equal user-failed "$(global_option @tmux-agents-status-failed-glyph)" 'a live default without ownership evidence remains user-owned'

printf 'ok - core configuration installation publishes discovery metadata and removes it safely\n'
