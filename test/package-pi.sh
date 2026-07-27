#!/bin/sh
set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

adapter=$("$root/test/package-adapter.sh" packages/pi tmux-agents-status-pi)
printf '%s\n' "$adapter" | grep -F 'export default function' >/dev/null ||
	fail 'Pi loads the adapter through its default extension export'

printf 'ok - Pi npm artifact contains only the independently installable adapter\n'
