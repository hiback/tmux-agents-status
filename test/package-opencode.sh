#!/bin/sh
set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

adapter=$("$root/test/package-adapter.sh" packages/opencode tmux-agents-status-opencode)
# OpenCode initializes every exported plugin function of a registered package.
[ "$(printf '%s\n' "$adapter" | grep -c '^export ')" = 1 ] ||
	fail 'OpenCode loads exactly one plugin export'
printf '%s\n' "$adapter" | grep -F 'export default' >/dev/null &&
	fail 'a default export would register the OpenCode plugin twice'

printf 'ok - OpenCode npm artifact contains only the independently installable adapter\n'
