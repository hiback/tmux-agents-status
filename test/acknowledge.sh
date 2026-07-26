#!/bin/sh
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
tmp=${TMPDIR:-/tmp}/tmux-agents-status-acknowledge-$$
mkdir "$tmp"
trap 'rm -rf "$tmp"' 0
trap 'exit 1' 1 2 3 15

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

mkdir "$tmp/bin"
cat >"$tmp/bin/tmux" <<'EOF'
#!/bin/sh
{
	for argument do printf '<%s>' "$argument"; done
	printf '\n'
} >>"$FAKE_TMUX_LOG"
case $1:$2 in
list-clients:-F)
	case $3 in
	'#{pane_id}') printf '%s\n' "${FAKE_PANES-%42
%99}" ;;
	'#{client_name}') printf '%s\n' "${FAKE_CLIENTS-client one
client-two}" ;;
	esac
	;;
list-panes:-t)
	printf '0|%%42\n'
	;;
show-option:-gqv)
	case $3 in
	@tmux-agents-status-running-glyph) printf 'R\n' ;;
	@tmux-agents-status-running-style) printf '\n' ;;
	@tmux-agents-status-waiting-glyph) printf 'W\n' ;;
	@tmux-agents-status-waiting-style) printf 'fg=yellow\n' ;;
	@tmux-agents-status-completed-glyph) printf 'C\n' ;;
	@tmux-agents-status-completed-style) printf '\n' ;;
	@tmux-agents-status-failed-glyph) printf 'F\n' ;;
	@tmux-agents-status-failed-style) printf '\n' ;;
	@tmux-agents-status-unread-style) printf 'reverse\n' ;;
	*) exit 1 ;;
	esac
	;;
show-option:-sqv)
	case $3 in
	@tmux-agents-status-state-%42)
		if [ -n "${FAKE_RACE_STATE-}" ]; then
			if [ -e "$FAKE_RACE_STATE" ]; then
				printf 'v2|11111111-1111-4111-8111-111111111111|pid:%s|-|waiting|g:33333333333333333333333333333333|running|request\n' "$FAKE_OWNER"
			else
				printf 'v2|11111111-1111-4111-8111-111111111111|pid:%s|-|waiting|g:22222222222222222222222222222222|running|request\n' "$FAKE_OWNER"
				: >"$FAKE_RACE_STATE"
			fi
		else
			[ "${FAKE_STATE+x}" = x ] || FAKE_STATE="v2|11111111-1111-4111-8111-111111111111|pid:$FAKE_OWNER|-|waiting|g:22222222222222222222222222222222|running|request"
			[ -n "$FAKE_STATE" ] || exit 0
			printf '%s\n' "$FAKE_STATE"
		fi
		;;
	@tmux-agents-status-ack-%42)
		if [ -n "${FAKE_RACE_ACK-}" ] && [ -s "$FAKE_RACE_ACK" ]; then
			IFS= read -r FAKE_ACK <"$FAKE_RACE_ACK"
		elif [ -s "$FAKE_TMUX_LOG.ack" ]; then
			IFS= read -r FAKE_ACK <"$FAKE_TMUX_LOG.ack"
		fi
		[ -n "${FAKE_ACK-}" ] || exit 0
		printf '%s\n' "$FAKE_ACK"
		;;
	*) exit 1 ;;
	esac
	;;
if-shell:-F)
	[ "${FAKE_SET_CODE-0}" -eq 0 ] || exit 1
	if [ -n "${FAKE_RACE_STATE-}" ] && [ -e "$FAKE_RACE_STATE" ]; then
		exit 0
	fi
	generation=${4#*ack-%42 }
	generation=${generation%% ;*}
	if [ -n "${FAKE_RACE_ACK-}" ]; then
		printf '%s\n' "$generation" >"$FAKE_RACE_ACK"
	else
		printf '%s\n' "$generation" >"$FAKE_TMUX_LOG.ack"
	fi
	printf 'TAS_CHANGED\n'
	;;
refresh-client:-S)
	[ "$4" != 'client one' ]
	;;
esac
EOF
chmod +x "$tmp/bin/tmux"
: >"$tmp/calls"
rm -f "$tmp/calls.ack"

if ! PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=$$ \
	"$root/scripts/acknowledge" '%42' >"$tmp/stdout" 2>"$tmp/stderr"; then
	fail 'a visible live alert is acknowledged even when one refresh fails'
fi
[ ! -s "$tmp/stdout" ] || fail 'acknowledgement writes no stdout'
IFS= read -r diagnostic <"$tmp/stderr" || :
[ "${diagnostic-}" = 'tmux-agents-status: acknowledge: refresh failed' ] || fail 'best-effort refresh failure is diagnosed safely'
[ "$(wc -l <"$tmp/stderr" | tr -d ' ')" = 1 ] || fail 'best-effort refresh emits one diagnostic'

grep -Fq '<if-shell><-F><#{==:#{@tmux-agents-status-state-%42},v2|' "$tmp/calls" || fail 'acknowledgement compare-checks the observed record'
grep -Fq 'set-option -s @tmux-agents-status-ack-%42 g:22222222222222222222222222222222' "$tmp/calls" || fail 'the observed generation is persisted through the ordered queue'
grep -Fq '<show-option><-sqv><@tmux-agents-status-ack-%42>' "$tmp/calls" || fail 'acknowledgement persistence is confirmed before refresh'
grep -Fq '<refresh-client><-S><-t><client one>' "$tmp/calls" || fail 'attached clients receive status-only refreshes'

assert_no_write() {
	assertion=$1
	shift
	: >"$tmp/calls"
	rm -f "$tmp/calls.ack"
	PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=$$ "$@"
	! grep -q '<if-shell>\|<refresh-client>' "$tmp/calls" || fail "$assertion"
}

assert_no_write 'invalid pane IDs are no-ops' "$root/scripts/acknowledge" '%bad'
assert_no_write 'extra arguments are no-ops' "$root/scripts/acknowledge" '%42' '%43'
assert_no_write 'invisible panes are no-ops' env FAKE_PANES='%99' "$root/scripts/acknowledge" '%42'
assert_no_write 'absent records are no-ops' env FAKE_STATE='' "$root/scripts/acknowledge" '%42'
assert_no_write 'malformed records are no-ops' env FAKE_STATE='v1|bad' "$root/scripts/acknowledge" '%42'
assert_no_write 'v1 records are no-ops' env FAKE_STATE="v1|$$|11111111-1111-4111-8111-111111111111|running|-" "$root/scripts/acknowledge" '%42'
assert_no_write 'live running records are no-ops' env FAKE_STATE="v2|11111111-1111-4111-8111-111111111111|pid:$$|-|running|-|-|-" "$root/scripts/acknowledge" '%42'
assert_no_write 'the current generation is not acknowledged twice' env FAKE_ACK='g:22222222222222222222222222222222' "$root/scripts/acknowledge" '%42'

: >"$tmp/calls"
rm -f "$tmp/calls.ack"
PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=99999999 \
	"$root/scripts/acknowledge" '%42'
grep -q 'set-option -s @tmux-agents-status-ack-%42 d:11111111-1111-4111-8111-111111111111' "$tmp/calls" ||
	fail 'a visible virtual failure acknowledges its effective generation'
! grep -q 'set-option -s @tmux-agents-status-state-' "$tmp/calls" ||
	fail 'acknowledging a virtual failure does not rewrite state'

: >"$tmp/calls"
rm -f "$tmp/calls.ack"
PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=$$ FAKE_SET_CODE=1 \
	"$root/scripts/acknowledge" '%42'
! grep -q '<refresh-client>' "$tmp/calls" || fail 'failed persistence does not refresh clients'

: >"$tmp/calls"
rm -f "$tmp/calls.ack" "$tmp/race-state-read" "$tmp/race-ack"
PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=$$ \
	FAKE_RACE_STATE="$tmp/race-state-read" FAKE_RACE_ACK="$tmp/race-ack" \
	"$root/scripts/acknowledge" '%42'
[ ! -e "$tmp/race-ack" ] || fail 'a raced newer record rejects acknowledgement of the observed generation'
race_render=$(PATH="$tmp/bin:$PATH" FAKE_TMUX_LOG="$tmp/calls" FAKE_OWNER=$$ \
	FAKE_RACE_STATE="$tmp/race-state-read" FAKE_RACE_ACK="$tmp/race-ack" \
	"$root/scripts/render-window" '$1' '@1' '%42')
[ "$race_render" = '#[default] #[fg=yellow,reverse]W#[default]' ] ||
	fail 'the newer generation remains renderer-visible and unread against the earlier acknowledgement'

printf 'ok - visible live alerts are acknowledged server-wide\n'
