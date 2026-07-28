#!/bin/sh
# Real-agent release smoke for the Codex adapter. It adds the staged
# marketplace tree through Codex's own marketplace command, installs the
# plugin, launches Codex directly in a tmux pane, and observes every capability
# the compatibility matrix claims for Codex: approximate running, approval-only
# approximate waiting, and approximate completed. `failed` is unsupported and
# therefore has no scenario.
#
# The lane also proves Codex's hook trust boundary: an installed but untrusted
# adapter runs nothing, and only the native review interaction activates it.
#
# Usage: test/smoke-codex.sh <staged marketplace directory> [previous public marketplace directory]
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$root/test/smoke-lib.sh"

package=${1:?staged marketplace directory}
previous=${2-}
package=$(CDPATH= cd "$package" && pwd -P)
[ -z "$previous" ] || previous=$(CDPATH= cd "$previous" && pwd -P)
: "${OPENAI_API_KEY:?provider credential for the smoke turns}"
# The digests the protected hook-trust review approved. They bind the reviewed
# definition to the one this lane trusts and executes.
: "${TAS_CODEX_HOOKS_SHA256:?reviewed hook definition digest}"
: "${TAS_CODEX_HOOK_SHA256:?reviewed hook executable digest}"
# A slug that becomes unavailable or is migrated makes Codex open its own model
# flow at startup, ahead of the hook review this lane has to answer, so this pin
# is the first thing to suspect if a launch stops reaching its prompt.
: "${TAS_SMOKE_MODEL:?model used by the smoke turns}"

plugin=tmux-agents-status@tmux-agents-status
marketplace=tmux-agents-status

smoke_begin codex
trap smoke_end 0
trap 'exit 1' 1 2 3 15
smoke_versions "codex $(codex --version)"

work=$smoke_tmp/work
market=$smoke_tmp/marketplace
codex_home=$smoke_home/.codex
mkdir -p "$work" "$market" "$codex_home"

digest() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# The key stays in the environment rather than in an argument vector every
# local process can read.
printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null

# Native first-run state, so a direct launch reaches its prompt instead of a
# directory trust dialog. Project trust is not hook trust: the hook review below
# is still required and is still the only thing that activates the adapter.
cat >"$codex_home/config.toml" <<EOF
model = "$TAS_SMOKE_MODEL"

[projects."$work"]
trust_level = "trusted"
EOF

plugin_json() {
	node -p "JSON.parse(require('node:child_process').execFileSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8' })).installed.filter((p) => p.pluginId === '$plugin').map((p) => p.$1).join('')"
}

staged_version=$(node -p 'require(process.argv[1] + "/packages/codex/.codex-plugin/plugin.json").version' "$package")
staged_hooks=$(node -p 'Object.keys(require(process.argv[1] + "/packages/codex/hooks/hooks.json").hooks).length' "$package")

# A release with a previous public version starts from it, so the candidate
# arrives through the native update path instead of a fresh install.
initial=$package
[ -z "$previous" ] || initial=$previous
cp -R "$initial"/. "$market"/
codex plugin marketplace add "$market" >/dev/null
codex plugin add "$plugin" >/dev/null

if [ -n "$previous" ]; then
	installed=$(plugin_json version)
	[ -n "$installed" ] && [ "$installed" != "$staged_version" ] ||
		smoke_fail 'the previous public version installs natively'
	# The marketplace source moves to the release candidate, which is what a
	# published update looks like to an already-installed user. A local
	# marketplace has no snapshot to refresh, so the update is the install
	# command re-resolving the marketplace it already points at.
	rm -rf "$market"
	mkdir "$market"
	cp -R "$package"/. "$market"/
	codex plugin add "$plugin" >/dev/null
	smoke_ok 'the native update path reaches the staged artifact'
fi

[ "$(plugin_json version)" = "$staged_version" ] || smoke_fail 'the staged version is the installed version'
[ "$(plugin_json enabled)" = true ] || smoke_fail 'the staged plugin is installed and enabled'
diff -r "$package" "$market" >/dev/null ||
	smoke_fail 'the marketplace source is still exactly the staged artifact'
smoke_ok 'the staged artifact installs through the repository marketplace'

# Codex executes its own cached copy, so the reviewed definition has to be the
# cached one, not just the one in the marketplace source.
cache=$codex_home/plugins/cache/$marketplace/tmux-agents-status/$staged_version
[ "$(digest "$cache/hooks/hooks.json")" = "$TAS_CODEX_HOOKS_SHA256" ] &&
	[ "$(digest "$cache/bin/tmux-agents-status-hook")" = "$TAS_CODEX_HOOK_SHA256" ] ||
	smoke_fail 'the installed hook definition and executable are the reviewed ones'
[ -x "$cache/bin/tmux-agents-status-hook" ] || smoke_fail 'the installed hook executable stays runnable'
smoke_ok 'the reviewed hook definition and executable are what Codex installed'

trusted_keys() {
	sed -n 's/^\[hooks\.state\."\(.*\)"\]$/\1/p' "$codex_home/config.toml"
}

[ -z "$(trusted_keys)" ] || smoke_fail 'installing the plugin trusts no hook'
smoke_ok 'installing the plugin leaves every hook untrusted'

# A silent pane proves nothing if no turn ever ran, so the negative checks wait
# for Codex to persist a session of its own. Only its existence is read.
expect_silence() {
	limit=$1
	label=$2
	deadline=$(($(date +%s) + limit))
	until [ -n "$(find "$codex_home/sessions" -type f 2>/dev/null | head -n 1)" ]; do
		[ -z "$(smoke_record)" ] || smoke_fail "$label"
		[ "$(date +%s)" -lt "$deadline" ] || smoke_fail "$label (no Codex turn ran in ${limit}s)"
		sleep .2
	done
	grace=$(($(date +%s) + 30))
	while [ "$(date +%s)" -lt "$grace" ]; do
		[ -z "$(smoke_record)" ] || smoke_fail "$label"
		sleep .2
	done
	smoke_ok "$label"
}

# The review prompt's arrival is the one thing this lane must not read off the
# screen, so the trusting answer is repeated until the trust store proves it
# landed. Declining persists nothing, so it is answered once after a settle and
# proven instead by the turn that follows it.
trust_all() {
	limit=$1
	deadline=$(($(date +%s) + limit))
	while [ "$(trusted_keys | grep -c .)" -ne "$staged_hooks" ]; do
		[ "$(date +%s)" -lt "$deadline" ] ||
			smoke_fail "the native review trusts every hook the adapter ships (waited ${limit}s)"
		sleep 5
		smoke_key Down
		smoke_key Enter
	done
}

# An installed but untrusted adapter must stay inert through a whole turn.
# Answering the native review prompt with its decline option is the only thing
# between the launch and the composer.
rm -rf "$codex_home/sessions"
smoke_launch "cd '$work' && exec codex"
sleep 20
smoke_key Down
smoke_key Down
smoke_key Enter
sleep 2
smoke_type 'Reply with the single word ready and nothing else.'
expect_silence 90 'an untrusted adapter reports nothing for a whole turn'
[ -z "$(trusted_keys)" ] || smoke_fail 'a declined review trusts no hook'

smoke_type '/quit'
sleep 5

# The native review interaction is the only thing that activates the adapter.
# Polling the trust store rather than the screen confirms the interaction
# without ever reading pane content.
smoke_launch "cd '$work' && exec codex --ask-for-approval untrusted"
trust_all 120
trusted_keys | grep -qvF "$plugin:hooks/hooks.json:" &&
	smoke_fail 'the review trusts this adapter and nothing else'
[ "$(grep -c '^trusted_hash = "sha256:' "$codex_home/config.toml")" -eq "$staged_hooks" ] ||
	smoke_fail 'every trusted hook is recorded by the digest of its own definition'
smoke_ok 'the native hook review is what activates the adapter'

# Codex holds its session start until a turn runs, so the claim a direct launch
# produces is only observable once this prompt is submitted.
smoke_type 'Use the shell tool to run the command touch smoke.txt, then reply with the single word ready.'
smoke_await_claim codex 120 -
smoke_await running 60 'a Codex turn reports approximate running'
smoke_await waiting 180 'a native approval request reports approximate waiting'
[ "$(smoke_field 8)" = permission ] || smoke_fail 'the approval wait carries its own request'
# Approving repairs the wait through the tool activity that follows it, which
# the fixtures already cover; asserting the intermediate `running` here would
# race a command that finishes as fast as the poll interval.
smoke_key Enter
smoke_await completed 300 'a settled Codex turn reports approximate completed'

smoke_type '/quit'
smoke_await_release 60

codex plugin remove "$plugin" >/dev/null
[ -z "$(plugin_json version)" ] || smoke_fail 'the documented uninstall removes the plugin'
smoke_ok 'codex plugin remove uninstalls the adapter'

rm -rf "$codex_home/sessions"
smoke_launch "cd '$work' && exec codex"
sleep 10
smoke_type 'Reply with the single word ready and nothing else.'
expect_silence 90 'an uninstalled adapter reports nothing for a whole turn'
