#!/bin/sh
set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)
tmp=${TMPDIR:-/tmp}/tmux-agents-status-package-pi-$$
mkdir "$tmp"
trap 'rm -rf "$tmp"' 0
trap 'exit 1' 1 2 3 15

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

(
	cd "$root"
	npm pack --silent --workspace packages/pi --pack-destination "$tmp" >/dev/null
)
set -- "$tmp"/tmux-agents-status-pi-*.tgz
[ "$#" -eq 1 ] && [ -f "$1" ] || fail 'npm pack creates exactly one Pi adapter artifact'
tarball=$1
tar -tzf "$tarball" | LC_ALL=C sort >"$tmp/contents"
cat >"$tmp/expected" <<'EOF'
package/package.json
package/tmux-agents-status.ts
EOF
cmp -s "$tmp/expected" "$tmp/contents" || {
	printf 'Pi package contained unexpected files:\n' >&2
	cat "$tmp/contents" >&2
	fail 'Pi npm artifact contains only its manifest and adapter'
}
if tar -xOf "$tarball" package/tmux-agents-status.ts | grep -Eq 'tas_parse_record|set-option.*tmux-agents-status-state'; then
	fail 'Pi adapter must not embed a fallback state core or write tmux state directly'
fi
grep -Fx 'package/scripts/state-core' "$tmp/contents" >/dev/null && fail 'Pi package must not contain the shared executable'
manifest=$(tar -xOf "$tarball" package/package.json)
printf '%s\n' "$manifest" | grep -F '"name": "tmux-agents-status-pi"' >/dev/null || fail 'package name is canonical'
printf '%s\n' "$manifest" | grep -F '"./tmux-agents-status.ts"' >/dev/null || fail 'Pi loads only the adapter entrypoint'
tar -xOf "$tarball" package/tmux-agents-status.ts | grep -F 'const protocolMajor = "2";' >/dev/null || fail 'Pi adapter declares compatible core protocol major 2'

printf 'ok - Pi npm artifact contains only the independently installable adapter\n'
