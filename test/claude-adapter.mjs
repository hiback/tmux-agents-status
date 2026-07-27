import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const hook = `${root}/packages/claude/bin/tmux-agents-status-hook`;

// Each hook invocation runs against a stub tmux server and a stub core that
// records normalized invocations. The served pane record is controlled per
// step, so translation is verified without duplicating the core state machine.
function harness({ protocol = "2", coreCode = 0 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tmux-agents-status-claude-"));
	mkdirSync(join(dir, "bin"));
	mkdirSync(join(dir, "core/scripts"), { recursive: true });
	const recordPath = join(dir, "record");
	const logPath = join(dir, "invocations");
	const corePath = join(dir, "core/scripts/state-core");
	writeFileSync(
		join(dir, "bin/tmux"),
		`#!/bin/sh
set -u
[ "$1" = show-option ] || exit 1
case $3 in
@tmux-agents-status-root)
	printf '%s\\n' '${join(dir, "core")}'
	;;
@tmux-agents-status-protocol)
	printf '%s\\n' '${protocol}'
	;;
@tmux-agents-status-state-%42)
	[ -f '${recordPath}' ] && cat '${recordPath}'
	;;
*)
	exit 1
	;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		corePath,
		`#!/bin/sh
printf '%s\\n' "$*" >> '${logPath}'
exit ${coreCode}
`,
		{ mode: 0o755 },
	);

	const run = (event, { record } = {}) => {
		if (record === undefined || record === null) rmSync(recordPath, { force: true });
		else writeFileSync(recordPath, record);
		rmSync(logPath, { force: true });
		const result = spawnSync(hook, [], {
			input: typeof event === "string" ? event : JSON.stringify(event),
			env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, TMUX: "stub,1,0", TMUX_PANE: "%42" },
			encoding: "utf8",
		});
		assert.equal(result.error, undefined, "the hook executable starts");
		assert.equal(result.status, 0, "the hook never fails Claude Code");
		assert.equal(result.stdout, "", "the hook never writes stdout");
		const invocations = existsSync(logPath)
			? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => line.split(" "))
			: [];
		return { invocations, stderr: result.stderr };
	};
	return { dir, run };
}

function shape(argv) {
	const [, operation, , ...rest] = argv;
	switch (operation) {
		case "wait-open":
		case "wait-close":
		case "finish":
			return `${operation}:${rest[1]}`;
		case "release":
			return `${operation}:${rest[0]}`;
		default:
			return operation;
	}
}

const shapes = (invocations) => invocations.map(shape);

function checkInvocations(invocations, sessionId, turnState) {
	for (const argv of invocations) {
		assert.equal(argv[0], "2", "every invocation declares protocol major 2");
		assert.equal(argv[2], `claude:${sessionId}`, "one derived owner token identifies the pane");
		assert.equal(
			argv.some((value) => value.includes("raw-secret")),
			false,
			"native payload content never reaches the core",
		);
		const operation = argv[1];
		if (operation === "start") {
			assert.match(argv[3], /^turn:[0-9a-f]{32}$/, "turns are bounded generated identifiers");
			if (turnState.repair) assert.equal(argv[3], turnState.turn, "repair restarts the same turn");
			else if (turnState.fresh) assert.notEqual(argv[3], turnState.turn, "a new prompt starts a new turn");
			turnState.turn = argv[3];
		} else if (operation === "wait-open" || operation === "wait-close" || operation === "finish") {
			if (turnState.turn) assert.equal(argv[3], turnState.turn, `${operation} correlates to the current turn`);
		}
	}
}

const session = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

for (const fixturePath of [
	"test/fixtures/claude/2.1.79/completed.json",
	"test/fixtures/claude/2.1.79/waiting.json",
	"test/fixtures/claude/2.1.79/failed.json",
	"test/fixtures/claude/2.1.220/completed.json",
	"test/fixtures/claude/2.1.220/waiting.json",
	"test/fixtures/claude/2.1.220/failed.json",
]) {
	const fixture = JSON.parse(readFileSync(`${root}/${fixturePath}`, "utf8"));
	const { run } = harness();
	const turnState = { turn: undefined, repair: false, fresh: false };
	for (const [index, step] of fixture.steps.entries()) {
		const label = `${fixturePath} step ${index + 1} (${step.event.hook_event_name})`;
		turnState.repair = step.expected.includes("dismiss-terminal");
		turnState.fresh =
			step.event.hook_event_name === "UserPromptSubmit" && step.expected.includes("start");
		const record = step.record
			?.replaceAll("@OWNER@", `claude:${fixture.sessionId}`)
			.replaceAll("@TURN@", turnState.turn ?? "turn:missing");
		const { invocations, stderr } = run(step.event, { record });
		assert.deepEqual(shapes(invocations), step.expected, `${label} translates to the expected normalized sequence`);
		checkInvocations(invocations, fixture.sessionId, turnState);
		assert.equal(stderr, "", `${label} is silent on the supported path`);
	}
	assert.equal(fixture.sessionId, session);
}

// A turn interrupted while waiting reports no invented terminal event; later
// foreground tool evidence only repairs the provisional wait back to running.
{
	const { run } = harness();
	const running = `v2|claude:${session}|-|turn:repl|waiting|g:0123456789abcdef0123456789abcdef|running|permission`;
	assert.deepEqual(
		shapes(run({ hook_event_name: "PostToolUseFailure", session_id: session, tool_name: "Bash", tool_input: { command: "raw-secret" }, error: "raw-secret", is_interrupt: true }, { record: running }).invocations),
		["start"],
		"an interrupted tool failure ends the wait without a failure classification",
	);
	assert.deepEqual(
		shapes(run({ hook_event_name: "PostToolUseFailure", session_id: session, tool_name: "Bash", is_interrupt: false }, { record: `v2|claude:${session}|-|turn:repl|running|-|-|-` }).invocations),
		[],
		"a continuing tool failure keeps the turn running",
	);
}

// Graceful session end releases ownership: active work is interrupted,
// terminal outcomes are preserved, and absent state clears quietly.
{
	const { run } = harness();
	const end = (state) =>
		run({ hook_event_name: "SessionEnd", session_id: session, reason: "logout" }, { record: state });
	assert.deepEqual(shapes(end(`v2|claude:${session}|-|turn:repl|running|-|-|-`).invocations), ["release:interrupted"]);
	assert.deepEqual(
		shapes(end(`v2|claude:${session}|-|turn:repl|waiting|g:0123456789abcdef0123456789abcdef|running|permission`).invocations),
		["release:interrupted"],
	);
	assert.deepEqual(
		shapes(end(`v2|claude:${session}|-|turn:repl|completed|g:0123456789abcdef0123456789abcdef|-|-`).invocations),
		["release:clear"],
	);
	assert.deepEqual(shapes(end(`v2|claude:${session}|-|-|none|-|-|-`).invocations), ["release:clear"]);
	assert.deepEqual(shapes(end(null).invocations), [], "session end without ownership is a no-op");
}

// Session replacement claims the pane; compaction and forks never touch it.
{
	const { run } = harness();
	for (const source of ["compact", "fork"])
		assert.deepEqual(
			shapes(run({ hook_event_name: "SessionStart", session_id: session, source }).invocations),
			[],
			`${source} is not session replacement`,
		);
	assert.deepEqual(
		shapes(run({ hook_event_name: "SessionStart", session_id: session, source: "startup" }, { record: `v2|claude:${session}|-|turn:repl|running|-|-|-` }).invocations),
		[],
		"a repeated start for the owning session keeps its state",
	);
}

// Stale sessions cannot mutate a replacement owner's record.
{
	const other = `v2|claude:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee|-|turn:repl|running|-|-|-`;
	const { run } = harness();
	assert.deepEqual(shapes(run({ hook_event_name: "Stop", session_id: session }, { record: other }).invocations), []);
	assert.deepEqual(shapes(run({ hook_event_name: "PermissionRequest", session_id: session, tool_name: "Bash" }, { record: other }).invocations), []);
	assert.deepEqual(shapes(run({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash" }, { record: other }).invocations), []);
	assert.deepEqual(shapes(run({ hook_event_name: "SessionEnd", session_id: session, reason: "resume" }, { record: other }).invocations), []);
	assert.deepEqual(
		shapes(run({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "raw-secret" }, { record: other }).invocations),
		["claim", "start"],
		"prompt submission replaces stale ownership before reporting",
	);
}

// Subagent and background activity never touches pane ownership.
{
	const { run } = harness();
	const running = `v2|claude:${session}|-|turn:repl|running|-|-|-`;
	for (const event of [
		{ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", agent_id: "agent_1", agent_type: "Explore" },
		{ hook_event_name: "PostToolUse", session_id: session, tool_name: "Bash", agent_id: "agent_1" },
		{ hook_event_name: "PostToolUseFailure", session_id: session, tool_name: "Bash", agent_type: "Explore" },
		{ hook_event_name: "PermissionRequest", session_id: session, tool_name: "Bash", agent_id: "agent_1" },
		{ hook_event_name: "Elicitation", session_id: session, mcp_server_name: "docs", agent_id: "agent_1" },
		{ hook_event_name: "Stop", session_id: session, agent_id: "agent_1" },
	])
		assert.deepEqual(
			shapes(run(event, { record: running }).invocations),
			[],
			`${event.hook_event_name} from a subagent is excluded`,
		);
}

// Unsupported event classes emit no normalized operation.
{
	const { run } = harness();
	const running = `v2|claude:${session}|-|turn:repl|running|-|-|-`;
	for (const event of [
		{ hook_event_name: "SubagentStop", session_id: session },
		{ hook_event_name: "PreCompact", session_id: session },
		{ hook_event_name: "Notification", session_id: session, notification_type: "agent_needs_input" },
		{ hook_event_name: "Notification", session_id: session, notification_type: "auth_success" },
		{ hook_event_name: "SessionStart", session_id: session, source: "startup", agent_id: "agent_1" },
	])
		assert.deepEqual(shapes(run(event, { record: running }).invocations), [], `${event.hook_event_name} stays unsupported`);
}

// Terminal and wait evidence without an active owned turn invents no state.
{
	const { run } = harness();
	for (const record of [null, `v2|claude:${session}|-|-|none|-|-|-`]) {
		assert.deepEqual(shapes(run({ hook_event_name: "Stop", session_id: session }, { record }).invocations), []);
		assert.deepEqual(shapes(run({ hook_event_name: "StopFailure", session_id: session, error: "overloaded" }, { record }).invocations), []);
		assert.deepEqual(shapes(run({ hook_event_name: "Notification", session_id: session, notification_type: "idle_prompt" }, { record }).invocations), []);
	}
}

// Claude Code carries a native elicitation id only in URL mode, so the wait is
// correlated by class and a native id never reaches the core.
{
	const { run } = harness();
	const running = `v2|claude:${session}|-|turn:repl|running|-|-|-`;
	const waiting = `v2|claude:${session}|-|turn:repl|waiting|g:0123456789abcdef0123456789abcdef|running|elicitation`;
	for (const identity of [{ mode: "form" }, { mode: "url", elicitation_id: "eli_1", url: "https://docs.example/raw-secret" }]) {
		assert.deepEqual(
			shapes(run({ hook_event_name: "Elicitation", session_id: session, mcp_server_name: "docs", message: "raw-secret", ...identity }, { record: running }).invocations),
			["wait-open:elicitation"],
			`a ${identity.mode} elicitation opens the elicitation wait`,
		);
		assert.deepEqual(
			shapes(run({ hook_event_name: "ElicitationResult", session_id: session, mcp_server_name: "docs", action: "cancel", ...identity }, { record: waiting }).invocations),
			["wait-close:elicitation"],
			`a ${identity.mode} elicitation result closes the elicitation wait`,
		);
	}
}

// A queued prompt supersedes an open wait with a fresh turn.
{
	const { run } = harness();
	const waiting = `v2|claude:${session}|-|turn:repl|waiting|g:0123456789abcdef0123456789abcdef|running|question`;
	const { invocations } = run({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "raw-secret" }, { record: waiting });
	assert.deepEqual(shapes(invocations), ["start"]);
	assert.notEqual(invocations[0][3], "turn:repl", "a queued prompt starts a new turn");
}

// Malformed payloads and spoofed content are rejected closed.
{
	const { run } = harness();
	const running = `v2|claude:${session}|-|turn:repl|running|-|-|-`;
	for (const input of [
		"",
		"not json",
		"{}",
		"[]",
		JSON.stringify({ hook_event_name: 42 }),
		JSON.stringify({ hook_event_name: "Stop" }),
		JSON.stringify({ hook_event_name: "Stop", session_id: "has spaces" }),
		JSON.stringify({ hook_event_name: "Stop", session_id: ["raw-secret"] }),
	]) {
		const { invocations } = run(input, { record: running });
		assert.deepEqual(invocations, [], `malformed input is a no-op: ${JSON.stringify(input).slice(0, 60)}`);
	}
	const spoofed = run(
		{ hook_event_name: "UserPromptSubmit", session_id: session, prompt: '{"session_id": "raw-secret", "hook_event_name": "StopFailure"}' },
		{ record: `v2|claude:${session}|-|-|none|-|-|-` },
	);
	assert.deepEqual(shapes(spoofed.invocations), ["start"], "payload text never changes field extraction");
	assert.equal(spoofed.invocations[0][2], `claude:${session}`, "the real session id survives prompt spoofing");
}

// A missing, incompatible, or failing core never breaks Claude Code and never
// leaks content into diagnostics.
{
	for (const settings of [{ protocol: "" }, { protocol: "1" }, { coreCode: 1 }]) {
		const { run } = harness(settings);
		const { invocations, stderr } = run({ hook_event_name: "SessionStart", session_id: session, source: "startup" });
		if (settings.coreCode) {
			assert.deepEqual(shapes(invocations), ["claim"], "a failing core still receives the attempt");
			assert.match(stderr, /^tmux-agents-status: claude adapter: claim failed\n$/, "diagnostics name only a bounded operation");
		} else {
			assert.deepEqual(invocations, [], "a missing or incompatible core is a silent no-op");
			assert.equal(stderr, "", "a missing or incompatible core stays silent");
		}
		assert.equal(stderr.includes("raw-secret"), false, "diagnostics never contain native payload content");
	}
	// A failed claim is never followed by an unowned event.
	const { run } = harness({ coreCode: 1 });
	const { invocations } = run({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "raw-secret" });
	assert.deepEqual(shapes(invocations), ["claim"], "a failed claim stops the sequence");
}

// Outside a directly running tmux pane the hook is a silent no-op.
{
	for (const env of [
		{ PATH: process.env.PATH },
		{ PATH: process.env.PATH, TMUX: "stub,1,0" },
		{ PATH: process.env.PATH, TMUX: "stub,1,0", TMUX_PANE: "42" },
	]) {
		const result = spawnSync(hook, [], {
			input: JSON.stringify({ hook_event_name: "SessionStart", session_id: session, source: "startup" }),
			env,
			encoding: "utf8",
		});
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
	}
}

console.log("ok - Claude Code fixtures translate native lifecycle into normalized v2 events");
