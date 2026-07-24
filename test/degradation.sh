#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
tmp=${TMPDIR:-/tmp}/tmux-agents-status-degradation-$$
mkdir -p "$tmp/bin"
trap 'rm -rf "$tmp"' 0
trap 'exit 1' 1 2 3 15

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

assert_equal() {
	[ "$1" = "$2" ] || fail "$3 (expected '$1', got '$2')"
}

cat >"$tmp/bin/tmux" <<'EOF'
#!/bin/sh
printf 'raw-secret tmux stderr\n' >&2
case $1:$2 in
show-option:-gqv)
	[ "${FAKE_FAIL-}" != option ] || exit 1
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
	*@tmux-agents-status-state-%1)
		[ "${FAKE_FAIL-}" != state ] || exit 1
		printf 'v1|%s|11111111-1111-4111-8111-111111111111|failed|22222222-2222-4222-8222-222222222222\n' "$FAKE_OWNER"
		;;
	*@tmux-agents-status-state-%2)
		if [ "${FAKE_BAD_RECORD+x}" = x ]; then
			printf '%s\n' "$FAKE_BAD_RECORD"
		else
			printf 'v9|%s|raw-secret\ninjected-secret\n' "$FAKE_OWNER"
		fi
		;;
	*@tmux-agents-status-ack-%1)
		[ "${FAKE_FAIL-}" != ack ] || exit 1
		;;
	*@tmux-agents-status-ack-*) : ;;
	*) exit 1 ;;
	esac
	;;
list-panes:-t)
	[ "${FAKE_FAIL-}" != topology ] || exit 1
	if [ "${FAKE_MALFORMED-}" = window ]; then
		printf '0|%%1\nnot-topology-secret\n'
	else
		printf '0|%%1\n1|%%2\n'
	fi
	;;
list-panes:-a)
	[ "${FAKE_FAIL-}" != topology ] || exit 1
	if [ "${FAKE_MALFORMED-}" = other ]; then
		printf '$1|0|0|%%1\nnot-topology-secret\n'
	else
		printf '$1|0|0|%%1\n$1|0|1|%%2\n'
	fi
	;;
display-message:-p)
	[ "${FAKE_FAIL-}" != name ] || exit 1
	printf '$1|other\n'
	;;
*) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/tmux"

cat >"$tmp/bin/sed" <<'EOF'
#!/bin/sh
[ "${FAKE_FAIL-}" != present ] || {
	printf 'raw-secret sed stderr\n' >&2
	exit 1
}
exec /usr/bin/sed "$@"
EOF
chmod +x "$tmp/bin/sed"

cat >"$tmp/bin/awk" <<'EOF'
#!/bin/sh
[ "${FAKE_FAIL-}" != awk ] || {
	printf 'raw-secret awk stderr\n' >&2
	exit 1
}
exec /usr/bin/awk "$@"
EOF
chmod +x "$tmp/bin/awk"

cat >"$tmp/bin/sort" <<'EOF'
#!/bin/sh
[ "${FAKE_FAIL-}" != sort ] || {
	printf 'raw-secret sort stderr\n' >&2
	exit 1
}
exec /usr/bin/sort "$@"
EOF
chmod +x "$tmp/bin/sort"

cat >"$tmp/bin/grep" <<'EOF'
#!/bin/sh
printf 'raw-secret grep stderr\n' >&2
exec /usr/bin/grep "$@"
EOF
chmod +x "$tmp/bin/grep"

assert_renderer() {
	expected_output=$1
	expected_error=$2
	label=$3
	shift 3
	if ! PATH="$tmp/bin:$PATH" FAKE_OWNER=$$ "$@" >"$tmp/stdout" 2>"$tmp/stderr"; then
		fail "$label exits success"
	fi
	assert_equal 1 "$(wc -l <"$tmp/stdout" | tr -d ' ')" "$label prints exactly one stdout line"
	IFS= read -r actual_output <"$tmp/stdout" || :
	assert_equal "$expected_output" "${actual_output-}" "$label stdout"
	actual_error=$(cat "$tmp/stderr")
	assert_equal "$expected_error" "$actual_error" "$label stderr"
}

assert_renderer ' F' '' 'window renderer isolates malformed and unknown sibling state' \
	"$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer 'other:F ' '' 'other renderer isolates malformed and unknown sibling state' \
	"$root/scripts/render-other-sessions" "\$0"
generation=22222222-2222-4222-8222-222222222222
incarnation=11111111-1111-4111-8111-111111111111
for invalid_record in \
	"v2|$$|$incarnation|failed|$generation" \
	"v1|$$|$incarnation|failed|$generation|extra" \
	"v1|0|$incarnation|running|-" \
	"v1|01|$incarnation|running|-" \
	"v1|pid|$incarnation|running|-" \
	"v1|$$|short|running|-" \
	"v1|$$|$incarnation|unknown|$generation" \
	"v1|$$|$incarnation|running|$generation" \
	"v1|$$|$incarnation|failed|-" \
	"v1|$$|$incarnation|failed|dead-$incarnation"; do
	assert_renderer ' F' '' 'strict records omit one invalid sibling' \
		env FAKE_BAD_RECORD="$invalid_record" "$root/scripts/render-window" "\$0" '@1' '%1'
done
assert_renderer '' 'tmux-agents-status: render-window: required query failed' 'window required option failure degrades safely' \
	env FAKE_FAIL=option "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-window: required query failed' 'window topology failure degrades safely' \
	env FAKE_FAIL=topology "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-window: required query failed' 'window malformed topology fails closed' \
	env FAKE_MALFORMED=window "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-window: required query failed' 'window state query failure aborts safely' \
	env FAKE_FAIL=state "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-window: required query failed' 'window acknowledgement query failure aborts safely' \
	env FAKE_FAIL=ack "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-window: render failed' 'window internal command failure degrades safely' \
	env FAKE_FAIL=present "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-window: render failed' 'window sort failure degrades without raw stderr' \
	env FAKE_FAIL=sort "$root/scripts/render-window" "\$0" '@1' '%1'
assert_renderer '' 'tmux-agents-status: render-other-sessions: required query failed' 'other topology failure degrades safely' \
	env FAKE_FAIL=topology "$root/scripts/render-other-sessions" "\$0"
assert_renderer '' 'tmux-agents-status: render-other-sessions: required query failed' 'other malformed topology fails closed' \
	env FAKE_MALFORMED=other "$root/scripts/render-other-sessions" "\$0"
assert_renderer '' 'tmux-agents-status: render-other-sessions: required query failed' 'other topology parser failure degrades without raw stderr' \
	env FAKE_FAIL=awk "$root/scripts/render-other-sessions" "\$0"
assert_renderer '' 'tmux-agents-status: render-other-sessions: required query failed' 'other name failure degrades safely' \
	env FAKE_FAIL=name "$root/scripts/render-other-sessions" "\$0"
assert_renderer '' 'tmux-agents-status: render-other-sessions: render failed' 'other internal command failure degrades safely' \
	env FAKE_FAIL=present "$root/scripts/render-other-sessions" "\$0"

if grep -q 'raw-secret\|injected-secret' "$tmp/stdout" "$tmp/stderr"; then
	fail 'renderer output and diagnostics never disclose raw state'
fi

cat >"$tmp/bin/tmux" <<'EOF'
#!/bin/sh
if [ "${FAKE_MODE-}" != plugin-cleanup-query ] || [ "$1:$2" = list-panes:-a ]; then
	printf 'raw-secret tmux stderr\n' >&2
fi
{
	for argument do printf '<%s>' "$argument"; done
	printf '\n'
} >>"$FAKE_TMUX_LOG"
case $1:$2 in
display-message:-p)
	printf '3.6\n'
	;;
list-clients:-F)
	case $3 in
	'#{pane_id}')
		[ "${FAKE_MODE-}" != acknowledge-query ] || exit 1
		printf '%%42\n'
		;;
	'#{client_name}')
		case ${FAKE_MODE-} in
		acknowledge-clients | cleanup-pane-clients | cleanup-stale-clients) exit 1 ;;
		esac
		printf 'client-one\n'
		;;
	esac
	;;
show-option:-sqv)
	case $3 in
	@tmux-agents-status-state-%42)
		case ${FAKE_MODE-} in
		acknowledge-state-query) exit 1 ;;
		acknowledge-absent) : ;;
		acknowledge-invalid) printf 'v1|raw-secret\ninjected-secret\n' ;;
		*) printf 'v1|%s|11111111-1111-4111-8111-111111111111|failed|22222222-2222-4222-8222-222222222222\n' "$FAKE_OWNER" ;;
		esac
		;;
	@tmux-agents-status-ack-%42)
		[ "${FAKE_MODE-}" != acknowledge-ack-query ] || exit 1
		;;
	*) exit 1 ;;
	esac
	;;
list-panes:-a)
	case ${FAKE_MODE-} in
	cleanup-stale-query | plugin-cleanup-query) exit 1 ;;
	cleanup-stale-malformed-panes) printf '%%42\nnot-a-pane-secret\n'; exit 0 ;;
	cleanup-stale-empty-panes) exit 0 ;;
	esac
	printf '%%42\n'
	;;
show-options:-s)
	[ "${FAKE_MODE-}" != cleanup-stale-options ] || exit 1
	case ${FAKE_MODE-} in
	cleanup-stale-none | cleanup-stale-empty-panes) : ;;
	cleanup-stale-malformed-options) printf '@tmux-agents-status-state-%%99\n' ;;
	cleanup-stale-state-only) printf '@tmux-agents-status-state-%%99 value\n' ;;
	cleanup-stale-ack-only) printf '@tmux-agents-status-ack-%%100 value\n' ;;
	*) printf '@tmux-agents-status-state-%%99 value\n@tmux-agents-status-ack-%%99 value\n' ;;
	esac
	;;
set-option:-s)
	case ${FAKE_MODE-} in
	acknowledge-write | cleanup-pane-write | cleanup-stale-write | cleanup-stale-partial) exit 1 ;;
	esac
	;;
set-option:-su)
	case ${FAKE_MODE-} in
	cleanup-pane-partial)
		rm -f "$FAKE_STATE_FILE"
		exit 1
		;;
	cleanup-pane-write | cleanup-stale-write | cleanup-stale-partial) exit 1 ;;
	esac
	;;
refresh-client:-S)
	case ${FAKE_MODE-} in
	acknowledge-refresh | cleanup-pane-refresh | cleanup-stale-refresh) exit 1 ;;
	esac
	;;
esac
exit 0
EOF
chmod +x "$tmp/bin/tmux"

run_boundary() {
	expected_error=$1
	label=$2
	shift 2
	: >"$tmp/calls"
	if ! PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=$$ "$@" >"$tmp/stdout" 2>"$tmp/stderr"; then
		fail "$label exits success"
	fi
	[ ! -s "$tmp/stdout" ] || fail "$label writes no stdout"
	actual_error=$(cat "$tmp/stderr")
	assert_equal "$expected_error" "$actual_error" "$label stderr"
	if grep -q 'raw-secret\|injected-secret' "$tmp/stdout" "$tmp/stderr"; then
		fail "$label diagnostic does not disclose raw state"
	fi
}

run_boundary 'tmux-agents-status: acknowledge: query failed' 'acknowledgement visibility query failure is diagnosed' \
	env FAKE_MODE=acknowledge-query "$root/scripts/acknowledge" '%42'
run_boundary 'tmux-agents-status: acknowledge: query failed' 'acknowledgement state query failure is diagnosed' \
	env FAKE_MODE=acknowledge-state-query "$root/scripts/acknowledge" '%42'
run_boundary 'tmux-agents-status: acknowledge: query failed' 'acknowledgement ack query failure is diagnosed without rewriting unread state' \
	env FAKE_MODE=acknowledge-ack-query "$root/scripts/acknowledge" '%42'
if grep -q '<set-option>' "$tmp/calls"; then fail 'acknowledgement query failure performs no write'; fi
run_boundary 'tmux-agents-status: acknowledge: write failed' 'acknowledgement write failure is diagnosed' \
	env FAKE_MODE=acknowledge-write "$root/scripts/acknowledge" '%42'
if grep -q '<refresh-client>' "$tmp/calls"; then fail 'acknowledgement does not refresh after failed persistence'; fi
run_boundary 'tmux-agents-status: acknowledge: query failed' 'post-write client query failure is diagnosed' \
	env FAKE_MODE=acknowledge-clients "$root/scripts/acknowledge" '%42'
grep -q '<set-option><-s><@tmux-agents-status-ack-%42>' "$tmp/calls" || fail 'acknowledgement remains persisted after client query failure'
run_boundary 'tmux-agents-status: acknowledge: refresh failed' 'acknowledgement refresh failure is diagnosed' \
	env FAKE_MODE=acknowledge-refresh "$root/scripts/acknowledge" '%42'
run_boundary '' 'absent acknowledgement state remains silent' \
	env FAKE_MODE=acknowledge-absent "$root/scripts/acknowledge" '%42'
run_boundary '' 'malformed acknowledgement state remains silent' \
	env FAKE_MODE=acknowledge-invalid "$root/scripts/acknowledge" '%42'
run_boundary '' 'invalid acknowledgement pane remains silent' \
	"$root/scripts/acknowledge" '%bad'

run_boundary '' 'invalid cleanup pane remains silent' \
	"$root/scripts/cleanup-pane" '%bad'
run_boundary 'tmux-agents-status: cleanup-pane: write failed' 'pane cleanup write failure is diagnosed' \
	env FAKE_MODE=cleanup-pane-write "$root/scripts/cleanup-pane" '%42'
if grep -q '<refresh-client>' "$tmp/calls"; then fail 'pane cleanup does not refresh after failed persistence'; fi
: >"$tmp/persisted-state"
: >"$tmp/persisted-ack"
run_boundary 'tmux-agents-status: cleanup-pane: write failed' 'pane cleanup preserves partial state removal without rollback' \
	env FAKE_MODE=cleanup-pane-partial FAKE_STATE_FILE="$tmp/persisted-state" "$root/scripts/cleanup-pane" '%42'
[ ! -e "$tmp/persisted-state" ] || fail 'pane cleanup state removal persists before acknowledgement failure'
[ -e "$tmp/persisted-ack" ] || fail 'pane cleanup does not roll back or rewrite acknowledgement after partial failure'
assert_equal 1 "$(grep -c '<set-option><-su><@tmux-agents-status-state-%42><;><set-option><-su><@tmux-agents-status-ack-%42>' "$tmp/calls")" 'pane cleanup attempts ordered mutation once'
if grep -q '<refresh-client>' "$tmp/calls"; then fail 'partial pane cleanup does not refresh'; fi
run_boundary 'tmux-agents-status: cleanup-pane: query failed' 'pane cleanup client query failure is diagnosed' \
	env FAKE_MODE=cleanup-pane-clients "$root/scripts/cleanup-pane" '%42'
run_boundary 'tmux-agents-status: cleanup-pane: refresh failed' 'pane cleanup refresh failure is diagnosed' \
	env FAKE_MODE=cleanup-pane-refresh "$root/scripts/cleanup-pane" '%42'

run_boundary '' 'startup cleanup without stale records remains silent' \
	env FAKE_MODE=cleanup-stale-none "$root/scripts/cleanup-stale"
run_boundary 'tmux-agents-status: cleanup-stale: query failed' 'startup cleanup pane query failure is diagnosed' \
	env FAKE_MODE=cleanup-stale-query "$root/scripts/cleanup-stale"
run_boundary 'tmux-agents-status: cleanup-stale: query failed' 'startup cleanup option query failure is diagnosed' \
	env FAKE_MODE=cleanup-stale-options "$root/scripts/cleanup-stale"
run_boundary 'tmux-agents-status: cleanup-stale: parse failed' 'startup cleanup rejects malformed pane topology before mutation' \
	env FAKE_MODE=cleanup-stale-malformed-panes "$root/scripts/cleanup-stale"
if grep -q '<set-option>' "$tmp/calls"; then fail 'malformed pane topology performs no cleanup'; fi
run_boundary 'tmux-agents-status: cleanup-stale: parse failed' 'startup cleanup rejects malformed option output before mutation' \
	env FAKE_MODE=cleanup-stale-malformed-options "$root/scripts/cleanup-stale"
if grep -q '<set-option>' "$tmp/calls"; then fail 'malformed option output performs no cleanup'; fi
run_boundary '' 'startup cleanup accepts zero pane records' \
	env FAKE_MODE=cleanup-stale-empty-panes "$root/scripts/cleanup-stale"
run_boundary 'tmux-agents-status: cleanup-stale: parse failed' 'startup cleanup parser failure is diagnosed without raw stderr' \
	env FAKE_FAIL=awk "$root/scripts/cleanup-stale"
if grep -q '<set-option>' "$tmp/calls"; then fail 'cleanup parser failure performs no cleanup'; fi
run_boundary 'tmux-agents-status: cleanup-stale: write failed' 'startup cleanup write failure is diagnosed once' \
	env FAKE_MODE=cleanup-stale-partial "$root/scripts/cleanup-stale"
assert_equal 1 "$(grep -c '<set-option><-su><@tmux-agents-status-state-%99><;><set-option><-su><@tmux-agents-status-ack-%99>' "$tmp/calls")" 'partial ordered cleanup is attempted once without rollback or retry'
if grep -q '<refresh-client>' "$tmp/calls"; then fail 'partial startup cleanup does not refresh'; fi
run_boundary 'tmux-agents-status: cleanup-stale: query failed' 'startup cleanup client query failure is diagnosed' \
	env FAKE_MODE=cleanup-stale-clients "$root/scripts/cleanup-stale"
run_boundary 'tmux-agents-status: cleanup-stale: refresh failed' 'startup cleanup refresh failure is diagnosed' \
	env FAKE_MODE=cleanup-stale-refresh "$root/scripts/cleanup-stale"
run_boundary '' 'state-only stale option is removed in ordered sequence' \
	env FAKE_MODE=cleanup-stale-state-only "$root/scripts/cleanup-stale"
grep -q '<set-option><-su><@tmux-agents-status-state-%99><;><set-option><-su><@tmux-agents-status-ack-%99>' "$tmp/calls" || fail 'state-only cleanup removes state before acknowledgement'
run_boundary '' 'ack-only stale option is removed in ordered sequence' \
	env FAKE_MODE=cleanup-stale-ack-only "$root/scripts/cleanup-stale"
grep -q '<set-option><-su><@tmux-agents-status-state-%100><;><set-option><-su><@tmux-agents-status-ack-%100>' "$tmp/calls" || fail 'ack-only cleanup still removes state before acknowledgement'

run_boundary 'tmux-agents-status: cleanup-stale: query failed' 'plugin continues after startup cleanup failure' \
	env FAKE_MODE=plugin-cleanup-query "$root/tmux-agents-status.tmux"
grep -q '<set-option><-goq><@tmux-agents-status-window>' "$tmp/calls" || fail 'startup cleanup failure does not prevent independent defaults loading'

printf 'ok - renderer and mutation failures degrade with safe diagnostics\n'
