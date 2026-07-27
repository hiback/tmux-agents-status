#!/bin/sh
set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

marketplace=$root/.claude-plugin/marketplace.json
plugin=$root/packages/claude

[ -f "$marketplace" ] || fail 'the repository declares a Claude Code marketplace'
[ -d "$plugin" ] || fail 'the marketplace plugin directory exists'

# The plugin tree contains only the adapter: its manifest, hook definitions,
# and hook executable.
(
	cd "$plugin"
	find . -type f | LC_ALL=C sort
) >"${TMPDIR:-/tmp}/tmux-agents-status-claude-tree-$$"
trap 'rm -f "${TMPDIR:-/tmp}/tmux-agents-status-claude-tree-$$"' 0
printf '%s\n' \
	'./.claude-plugin/plugin.json' \
	'./bin/tmux-agents-status-hook' \
	'./hooks/hooks.json' |
	cmp -s - "${TMPDIR:-/tmp}/tmux-agents-status-claude-tree-$$" ||
	fail 'the Claude plugin artifact contains only its manifest, hooks, and executable'

node - "$root" <<'EOF'
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const root = process.argv[2];
const read = (path) => JSON.parse(readFileSync(`${root}/${path}`, "utf8"));

const marketplace = read(".claude-plugin/marketplace.json");
assert.equal(marketplace.name, "tmux-agents-status", "marketplace name is canonical");
assert.equal(typeof marketplace.owner?.name, "string", "marketplace names its owner");
assert.equal(marketplace.plugins.length, 1, "the marketplace ships only the Claude adapter");
assert.equal(marketplace.plugins[0].name, "tmux-agents-status", "plugin name is canonical");
assert.equal(marketplace.plugins[0].source, "./packages/claude", "plugin resolves from this repository");

const manifest = read("packages/claude/.claude-plugin/plugin.json");
assert.equal(manifest.name, "tmux-agents-status", "plugin manifest name is canonical");
assert.match(manifest.version, /^[0-9]+\.[0-9]+\.[0-9]+$/, "plugin is independently versioned");
assert.equal(typeof manifest.description, "string", "plugin manifest describes the adapter");

const command = '"${CLAUDE_PLUGIN_ROOT}/bin/tmux-agents-status-hook"';
const hooks = read("packages/claude/hooks/hooks.json").hooks;
assert.deepEqual(
	Object.keys(hooks).sort(),
	[
		"Elicitation",
		"ElicitationResult",
		"Notification",
		"PermissionRequest",
		"PostToolUse",
		"PostToolUseFailure",
		"PreToolUse",
		"SessionEnd",
		"SessionStart",
		"Stop",
		"StopFailure",
		"UserPromptSubmit",
	],
	"every subscribed native event routes to the adapter",
);
for (const [event, entries] of Object.entries(hooks)) {
	for (const entry of entries) {
		assert.equal(entry.hooks.length, 1, `${event} runs exactly one hook command`);
		const [hook] = entry.hooks;
		assert.equal(hook.type, "command", `${event} uses a command hook`);
		assert.equal(hook.command, command, `${event} invokes the plugin-cached executable`);
		assert.equal(hook.timeout, 1, `${event} stays within a bounded synchronous budget`);
		assert.equal("async" in hook, false, `${event} never runs asynchronously`);
	}
}
assert.equal(
	hooks.SessionStart[0].matcher,
	"startup|resume|clear",
	"session replacement claims exclude compaction and forks",
);
assert.equal(
	hooks.Notification[0].matcher,
	"permission_prompt|idle_prompt",
	"only supported notification classes reach the adapter",
);
for (const event of ["UserPromptSubmit", "Stop"])
	assert.equal("matcher" in hooks[event][0], false, `${event} has no matcher field`);
for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "StopFailure", "Elicitation", "ElicitationResult", "SessionEnd"])
	assert.equal(hooks[event][0].matcher, "*", `${event} matches every value`);
EOF

hook=$plugin/bin/tmux-agents-status-hook
[ -x "$hook" ] || fail 'the hook executable is directly runnable'
grep -F '@tmux-agents-status-root' "$hook" >/dev/null ||
	fail 'the adapter discovers the canonical core root through the tmux server'
grep -F '@tmux-agents-status-protocol' "$hook" >/dev/null ||
	fail 'the adapter negotiates the core protocol through the tmux server'
grep -F '"$protocol" = 2' "$hook" >/dev/null ||
	fail 'the adapter declares compatible core protocol major 2'
grep -E 'set-option|set-hook|tas_parse_record' "$hook" >/dev/null &&
	fail 'the adapter never writes tmux state or embeds a fallback core'

printf 'ok - Claude Code marketplace artifact contains only the independently installable adapter\n'
