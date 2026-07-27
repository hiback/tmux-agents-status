#!/bin/sh
# Shared adapter package contract. It prints the packed adapter module on
# stdout so each adapter check can add its own native-loader assertions.
set -eu

workspace=$1
package=$2
root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)
tmp=${TMPDIR:-/tmp}/tmux-agents-status-package-$$
mkdir "$tmp"
trap 'rm -rf "$tmp"' 0
trap 'exit 1' 1 2 3 15

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

(
	cd "$root"
	npm pack --silent --workspace "$workspace" --pack-destination "$tmp" >/dev/null
)
set -- "$tmp/$package"-*.tgz
[ "$#" -eq 1 ] && [ -f "$1" ] || fail "npm pack creates exactly one $package artifact"
tarball=$1
tar -tzf "$tarball" | LC_ALL=C sort >"$tmp/contents"
cat >"$tmp/expected" <<'EOF'
package/package.json
package/tmux-agents-status.ts
EOF
cmp -s "$tmp/expected" "$tmp/contents" || {
	printf '%s contained unexpected files:\n' "$package" >&2
	cat "$tmp/contents" >&2
	fail "$package artifact contains only its manifest and adapter"
}
grep -Fx 'package/scripts/state-core' "$tmp/contents" >/dev/null && fail "$package must not contain the shared executable"
adapter=$(tar -xOf "$tarball" package/tmux-agents-status.ts)
printf '%s\n' "$adapter" | grep -Eq 'tas_parse_record|set-option.*tmux-agents-status-state' &&
	fail "$package must not embed a fallback state core or write tmux state directly"
printf '%s\n' "$adapter" | grep -F 'const protocolMajor = "2";' >/dev/null ||
	fail "$package declares compatible core protocol major 2"
manifest=$(tar -xOf "$tarball" package/package.json)
printf '%s\n' "$manifest" | grep -F "\"name\": \"$package\"" >/dev/null || fail "$package name is canonical"
printf '%s\n' "$manifest" | grep -F '"./tmux-agents-status.ts"' >/dev/null || fail "$package resolves only the adapter entrypoint"

printf '%s\n' "$adapter"
