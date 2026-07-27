#!/bin/sh
# Real-agent release smoke for the Pi adapter. It installs the staged npm
# artifact through Pi's own package command, launches Pi directly in a tmux
# pane, and observes every capability the compatibility matrix claims for Pi:
# exact running, approximate completed, approximate failed. Waiting is
# unsupported and therefore has no scenario.
#
# Usage: test/smoke-pi.sh <staged package directory> [previous public version]
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$root/test/smoke-lib.sh"

package=${1:?staged package directory}
previous=${2-}
package=$(CDPATH= cd "$package" && pwd -P)
: "${TAS_SMOKE_MODEL:?provider/model for the smoke turn}"

smoke_begin pi
trap smoke_end 0
trap 'exit 1' 1 2 3 15
smoke_versions "pi $(pi --version)"

# Pi identifies an npm package by name and a local package by resolved absolute
# path, so the published entry has to go before the staged one is registered.
if [ -n "$previous" ]; then
	pi install "npm:tmux-agents-status-pi@$previous" >/dev/null
	pi list | grep -Fq 'tmux-agents-status-pi' ||
		smoke_fail 'the previous public version installs natively'
	pi remove npm:tmux-agents-status-pi >/dev/null
	pi list | grep -Fq 'tmux-agents-status-pi' &&
		smoke_fail 'the previous public entry is gone before the staged one is registered'
	smoke_ok 'the previous public version installs and is replaceable'
fi

pi install "$package" >/dev/null
pi list | grep -Fq "$package" || smoke_fail 'the staged artifact installs natively'
smoke_ok 'the staged artifact installs through pi install'

smoke_launch "exec pi --model '$TAS_SMOKE_MODEL'"
smoke_await_claim pi 120

smoke_type 'Reply with the single word ready and nothing else.'
smoke_await running 60 'a Pi turn reports exact running'
smoke_await completed 300 'a settled Pi turn reports approximate completed'

smoke_type 'Count from 1 to 500, one number per line.'
smoke_await running 60 'a second Pi turn reports exact running'
smoke_key Escape
smoke_await failed 120 'an aborted Pi turn reports approximate failed'

smoke_type '/quit'
smoke_await_release 60

pi remove "$package" >/dev/null
pi list | grep -Fq "$package" && smoke_fail 'the documented uninstall removes the adapter'
smoke_ok 'pi remove uninstalls the adapter'

smoke_launch "exec pi --model '$TAS_SMOKE_MODEL'"
smoke_expect_no_claim 20
