#!/bin/sh
# Real-agent release smoke for the OpenCode adapter. It registers the staged npm
# artifact through OpenCode's own global plugin command, launches OpenCode
# directly in a tmux pane, and observes every capability the compatibility
# matrix claims for OpenCode: exact running, waiting, completed, and failed.
#
# Usage: test/smoke-opencode.sh <staged package directory> [previous public version]
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$root/test/smoke-lib.sh"

package=${1:?staged package directory}
previous=${2-}
package=$(CDPATH= cd "$package" && pwd -P)
: "${TAS_SMOKE_MODEL:?provider/model for the smoke turn}"

smoke_begin opencode
trap smoke_end 0
trap 'exit 1' 1 2 3 15
smoke_versions "opencode $(opencode --version)"

# Written before installation so the plugin command extends this file, and so
# an approval request -- the only trigger for exact waiting -- can be provoked.
config=$smoke_home/.config/opencode/opencode.json
mkdir -p "$smoke_home/.config/opencode"
cat >"$config" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "bash": "ask" }
}
EOF

if [ -n "$previous" ]; then
	opencode plugin --global "tmux-agents-status-opencode@$previous" >/dev/null
	grep -Fq 'tmux-agents-status-opencode' "$config" ||
		smoke_fail 'the previous public version registers natively'
	opencode plugin --global --force "$package" >/dev/null
	smoke_ok 'the native update path replaces the previous public version'
else
	opencode plugin --global "$package" >/dev/null
fi
grep -Fq "$package" "$config" || smoke_fail 'the staged artifact registers natively'
smoke_ok 'the staged artifact registers through opencode plugin --global'

smoke_launch "exec opencode --model '$TAS_SMOKE_MODEL'"
smoke_await_claim opencode 120

smoke_type 'Run the shell command true, then reply with the single word ready.'
smoke_await running 60 'an OpenCode turn reports exact running'
smoke_await waiting 180 'a pending permission request reports exact waiting'
smoke_key Enter
smoke_await running 60 'answering the request resumes exact running'
smoke_await completed 300 'a settled OpenCode turn reports exact completed'

smoke_type 'Count from 1 to 500, one number per line.'
smoke_await running 60 'a second OpenCode turn reports exact running'
smoke_key Escape
smoke_await failed 120 'an aborted OpenCode turn reports exact failed'

smoke_type '/exit'
smoke_await_release 60

# OpenCode has no native remove command, so the documented uninstall is deleting
# only this package entry from the global plugin array.
cat >"$config" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "bash": "ask" }
}
EOF
grep -Fq "$package" "$config" && smoke_fail 'the documented uninstall removes the package entry'
smoke_ok 'the documented package-entry removal uninstalls the adapter'

smoke_launch "exec opencode --model '$TAS_SMOKE_MODEL'"
smoke_expect_no_claim 20
