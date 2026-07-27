#!/bin/sh
# Real-agent release smoke for the Claude Code adapter. It adds the staged
# marketplace tree through Claude Code's own marketplace command, installs the
# plugin at user scope, launches Claude Code directly in a tmux pane, and
# observes every capability the compatibility matrix claims for Claude Code:
# approximate running, approximate waiting, exact elicitation waiting,
# approximate completed, and exact failed.
#
# Usage: test/smoke-claude.sh <staged marketplace directory> [previous public marketplace directory]
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
. "$root/test/smoke-lib.sh"

package=${1:?staged marketplace directory}
previous=${2-}
package=$(CDPATH= cd "$package" && pwd -P)
[ -z "$previous" ] || previous=$(CDPATH= cd "$previous" && pwd -P)
: "${TAS_SMOKE_MODEL:?model used by the smoke turns}"
: "${ANTHROPIC_API_KEY:?provider credential for the smoke turns}"

plugin=tmux-agents-status@tmux-agents-status

stub_pid=
cleanup() {
	[ -z "$stub_pid" ] || kill "$stub_pid" 2>/dev/null || :
	smoke_end
}

smoke_begin claude
trap cleanup 0
trap 'exit 1' 1 2 3 15
smoke_versions "claude $(claude --version)"

work=$smoke_tmp/work
market=$smoke_tmp/marketplace
trigger=$smoke_tmp/elicit.trigger
mkdir -p "$work" "$market" "$smoke_home/.claude"

# Native first-run state, so a direct launch reaches its prompt instead of an
# onboarding, trust, or API key screen. Claude Code recognizes an environment
# key by its last twenty characters. The key stays in the environment rather
# than in an argument vector every local process can read.
TAS_SMOKE_CONFIG=$smoke_home/.claude.json TAS_SMOKE_PROJECT=$work node <<'EOF'
const { writeFileSync } = require("node:fs");
writeFileSync(
	process.env.TAS_SMOKE_CONFIG,
	JSON.stringify({
		hasCompletedOnboarding: true,
		theme: "dark",
		customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.trim().slice(-20)], rejected: [] },
		projects: { [process.env.TAS_SMOKE_PROJECT]: { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 9 } },
	}),
);
EOF

# A permission request is the only trigger for the documented approximate wait,
# so the smoke asks for one explicitly rather than depending on a default mode.
cat >"$smoke_home/.claude/settings.json" <<'EOF'
{ "permissions": { "ask": ["Bash"] } }
EOF

claude mcp add -s user tmux-agents-status-smoke-probe -- \
	node "$root/test/smoke-claude-elicit.mjs" "$trigger" >/dev/null

staged_version=$(node -p 'require(process.argv[1] + "/packages/claude/.claude-plugin/plugin.json").version' "$package")
installed_version() {
	claude plugin list 2>/dev/null | sed -n 's/^[[:space:]]*Version:[[:space:]]*//p' | head -n 1
}

# A release with a previous public version starts from it, so the candidate
# arrives through the native update path instead of a fresh install.
initial=$package
[ -z "$previous" ] || initial=$previous
cp -R "$initial"/. "$market"/
claude plugin marketplace add "$market" --scope user >/dev/null
claude plugin install "$plugin" --scope user >/dev/null

if [ -n "$previous" ]; then
	[ -n "$(installed_version)" ] && [ "$(installed_version)" != "$staged_version" ] ||
		smoke_fail 'the previous public version installs natively'
	# The marketplace source moves to the release candidate, which is what a
	# published update looks like to an already-installed user.
	rm -rf "$market"
	mkdir "$market"
	cp -R "$package"/. "$market"/
	claude plugin marketplace update tmux-agents-status >/dev/null
	claude plugin update "$plugin" --scope user >/dev/null
	smoke_ok 'the native marketplace and plugin update path reaches the staged artifact'
fi

[ "$(installed_version)" = "$staged_version" ] || smoke_fail 'the staged version is the installed version'
diff -r "$package" "$market" >/dev/null ||
	smoke_fail 'the marketplace source is still exactly the staged artifact'
smoke_ok 'the staged artifact installs at user scope through the repository marketplace'

smoke_launch "cd '$work' && exec claude --model '$TAS_SMOKE_MODEL'"
smoke_await_claim claude 120 -

# Exact waiting needs a real MCP elicitation, which the probe raises on demand.
: >"$trigger"
smoke_await waiting 60 'an MCP elicitation reports exact waiting'
[ "$(smoke_field 8)" = elicitation ] || smoke_fail 'the elicitation wait carries its own request'
smoke_key Escape
smoke_await none 60 'the paired elicitation result closes the exact wait'
rm -f "$trigger"

smoke_type 'Use the Bash tool to run the command true, then reply with the single word ready.'
smoke_await running 60 'a Claude Code turn reports approximate running'
smoke_await waiting 180 'a pending permission request reports approximate waiting'
smoke_key Enter
smoke_await running 60 'answering the request resumes approximate running'
smoke_await completed 300 'a settled Claude Code turn reports approximate completed'

smoke_type '/exit'
smoke_await_release 60

# Exact failed is terminal API failure evidence, which no healthy provider
# produces on demand, so this launch talks to a provider endpoint that always
# answers with a non-retryable error.
node "$root/test/smoke-claude-api.mjs" "$smoke_tmp/stub.port" &
stub_pid=$!
stub_port=
until [ -n "$stub_port" ]; do
	sleep .2
	stub_port=$(cat "$smoke_tmp/stub.port" 2>/dev/null || :)
done

smoke_launch "cd '$work' && export ANTHROPIC_BASE_URL='http://127.0.0.1:$stub_port'; exec claude --model '$TAS_SMOKE_MODEL'"
smoke_await_claim claude 120 -
smoke_type 'Reply with the single word ready.'
smoke_await failed 180 'terminal API failure evidence reports exact failed'

smoke_type '/exit'
smoke_await_release 60
kill "$stub_pid" 2>/dev/null || :
stub_pid=

claude plugin uninstall "$plugin" --scope user >/dev/null
claude plugin list 2>/dev/null | grep -Fq "$plugin" && smoke_fail 'the documented uninstall removes the plugin'
smoke_ok 'claude plugin uninstall removes the adapter at user scope'

smoke_launch "cd '$work' && exec claude --model '$TAS_SMOKE_MODEL'"
smoke_expect_no_claim 45
