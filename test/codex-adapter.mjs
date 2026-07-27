import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const hook = `${root}/packages/codex/bin/tmux-agents-status-hook`;

// Each invocation runs against a stub tmux server and a stub core that records
// normalized invocations. The served pane record is controlled per step, so
// translation is verified without duplicating the core state machine.
function harness({ protocol = "2", coreCode = 0 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "tmux-agents-status-codex-"));
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

	const run = (event, { record, mode = "hook" } = {}) => {
		if (record === undefined || record === null) rmSync(recordPath, { force: true });
		else writeFileSync(recordPath, record);
		rmSync(logPath, { force: true });
		const payload = typeof event === "string" ? event : JSON.stringify(event);
		const result = spawnSync(hook, mode === "notify" ? [payload] : [], {
			input: mode === "notify" ? "" : payload,
			env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, TMUX: "stub,1,0", TMUX_PANE: "%42" },
			encoding: "utf8",
		});
		assert.equal(result.error, undefined, "the adapter executable starts");
		assert.equal(result.status, 0, "the adapter never fails Codex");
		assert.equal(result.stdout, "", "the adapter never writes stdout");
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

const session = "9f1d2c3b-4a5e-4f60-8b71-2c3d4e5f6071";
const owner = `codex:${session}`;
const turnA = "01994f2b1a2c7cd09e3f4b5c6d7e8f90";
const turnB = "01994f2b3d4e7cd18a2b3c4d5e6f7081";
const running = (turn) => `v2|${owner}|-|turn:${turn}|running|-|-|-`;
const waiting = (turn) =>
	`v2|${owner}|-|turn:${turn}|waiting|g:0123456789abcdef0123456789abcdef|running|permission`;
const completed = (turn) =>
	`v2|${owner}|-|turn:${turn}|completed|g:0123456789abcdef0123456789abcdef|-|-`;

// Codex 0.145.0 is both the declared support floor, because it is the first
// stable release with SessionEnd, and the current stable release.
for (const fixturePath of [
	"test/fixtures/codex/0.145.0/completed.json",
	"test/fixtures/codex/0.145.0/waiting.json",
	"test/fixtures/codex/0.145.0/unsupported.json",
]) {
	const fixture = JSON.parse(readFileSync(`${root}/${fixturePath}`, "utf8"));
	assert.equal(fixture.sessionId, session);
	assert.equal(fixture.version, "0.145.0");
	const { run } = harness();
	for (const [index, step] of fixture.steps.entries()) {
		const label = `${fixturePath} step ${index + 1} (${step.event.hook_event_name ?? step.event.type})`;
		const nativeTurn = step.event.turn_id ?? step.event["turn-id"];
		const record = step.record?.replaceAll("@OWNER@", owner);
		const { invocations, stderr } = run(step.event, { record, mode: step.mode });
		assert.deepEqual(shapes(invocations), step.expected, `${label} translates to the expected normalized sequence`);
		assert.equal(
			step.expected.includes("finish:failed"),
			false,
			`${label} never reports the unsupported failed outcome`,
		);
		for (const argv of invocations) {
			assert.equal(argv[0], "2", "every invocation declares protocol major 2");
			assert.equal(argv[2], owner, "one thread-derived owner token identifies the pane");
			assert.equal(
				argv.some((value) => value.includes("raw-secret")),
				false,
				"native payload content never reaches the core",
			);
			if (["start", "wait-open", "finish"].includes(argv[1]))
				assert.equal(argv[3], `turn:${nativeTurn}`, `${label} correlates through Codex's own turn id`);
		}
		assert.equal(stderr, "", `${label} is silent on the supported path`);
	}
}

// Session replacement claims the pane; compaction never touches it.
{
	const { run } = harness();
	assert.deepEqual(
		shapes(run({ hook_event_name: "SessionStart", session_id: session, source: "compact" }).invocations),
		[],
		"compaction is not session replacement",
	);
	for (const source of ["startup", "resume", "clear"])
		assert.deepEqual(
			shapes(run({ hook_event_name: "SessionStart", session_id: session, source }).invocations),
			["claim"],
			`${source} claims an unowned pane`,
		);
	assert.deepEqual(
		shapes(run({ hook_event_name: "SessionStart", session_id: session, source: "startup" }, { record: running(turnA) }).invocations),
		[],
		"a repeated start for the owning session keeps its state",
	);
}

// Stale sessions cannot mutate a replacement owner's record.
{
	const other = `v2|codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee|-|turn:${turnA}|running|-|-|-`;
	const { run } = harness();
	for (const event of [
		{ hook_event_name: "Stop", session_id: session, turn_id: turnA, stop_hook_active: false },
		{ hook_event_name: "PermissionRequest", session_id: session, turn_id: turnA, tool_name: "Bash" },
		{ hook_event_name: "PreToolUse", session_id: session, turn_id: turnA, tool_name: "Bash" },
		{ hook_event_name: "PostToolUse", session_id: session, turn_id: turnA, tool_name: "Bash" },
		{ hook_event_name: "SessionEnd", session_id: session, reason: "other" },
	])
		assert.deepEqual(shapes(run(event, { record: other }).invocations), [], `${event.hook_event_name} from a replaced session is ignored`);
	assert.deepEqual(
		shapes(run({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turnA, prompt: "raw-secret" }, { record: other }).invocations),
		["claim", "start"],
		"prompt submission replaces stale ownership before reporting",
	);
}

// A superseded turn can neither open a wait nor settle the current turn, while
// activity from a newer turn supersedes the previous one.
{
	const { run } = harness();
	assert.deepEqual(
		shapes(run({ hook_event_name: "PermissionRequest", session_id: session, turn_id: turnA, tool_name: "Bash" }, { record: running(turnB) }).invocations),
		[],
		"a stale permission request opens no wait",
	);
	assert.deepEqual(
		shapes(run({ hook_event_name: "Stop", session_id: session, turn_id: turnA, stop_hook_active: false }, { record: waiting(turnB) }).invocations),
		[],
		"a stale stop settles nothing",
	);
	const superseded = run({ hook_event_name: "PreToolUse", session_id: session, turn_id: turnB, tool_name: "Bash" }, { record: completed(turnA) });
	assert.deepEqual(shapes(superseded.invocations), ["start"], "a newer turn supersedes an approximate completion without dismissal");
	assert.equal(superseded.invocations[0][3], `turn:${turnB}`);
}

// An unowned pane is never touched, and terminal evidence never settles a turn
// that was not observed as active.
{
	const { run } = harness();
	const claimed = `v2|${owner}|-|-|none|-|-|-`;
	for (const event of [
		{ hook_event_name: "Stop", session_id: session, turn_id: turnA, stop_hook_active: false },
		{ hook_event_name: "PermissionRequest", session_id: session, turn_id: turnA, tool_name: "Bash" },
		{ hook_event_name: "PreToolUse", session_id: session, turn_id: turnA, tool_name: "Bash" },
	])
		assert.deepEqual(shapes(run(event, { record: null }).invocations), [], `${event.hook_event_name} on an unowned pane is a no-op`);
	assert.deepEqual(
		shapes(run({ hook_event_name: "Stop", session_id: session, turn_id: turnA, stop_hook_active: false }, { record: claimed }).invocations),
		[],
		"a stop for an unobserved turn invents no outcome",
	);
	assert.deepEqual(
		shapes(run({ hook_event_name: "PreToolUse", session_id: session, turn_id: turnA, tool_name: "Bash" }, { record: claimed }).invocations),
		["start"],
		"foreground activity starts a turn on an owned pane",
	);
	assert.deepEqual(
		shapes(run({ hook_event_name: "PermissionRequest", session_id: session, turn_id: turnA, tool_name: "Bash" }, { record: claimed }).invocations),
		["wait-open:permission"],
		"an approval request is direct wait evidence even before any turn was reported",
	);
}

// Graceful session end releases ownership: active work is interrupted,
// terminal outcomes are preserved, and absent state clears quietly.
{
	const { run } = harness();
	const end = (record) => run({ hook_event_name: "SessionEnd", session_id: session, reason: "other" }, { record });
	assert.deepEqual(shapes(end(running(turnA)).invocations), ["release:interrupted"]);
	assert.deepEqual(shapes(end(waiting(turnA)).invocations), ["release:interrupted"]);
	assert.deepEqual(shapes(end(completed(turnA)).invocations), ["release:clear"]);
	assert.deepEqual(shapes(end(`v2|${owner}|-|-|none|-|-|-`).invocations), ["release:clear"]);
	assert.deepEqual(shapes(end(null).invocations), [], "session end without ownership is a no-op");
}

// The legacy notify entry point reports only its own correlated completion.
{
	const { run } = harness();
	const notify = (event, record) => run(event, { record, mode: "notify" });
	assert.deepEqual(
		shapes(notify({ type: "agent-turn-complete", "thread-id": session, "turn-id": turnA, cwd: "/work" }, running(turnA)).invocations),
		["finish:completed"],
	);
	for (const event of [
		{ type: "agent-turn-complete", "thread-id": session, cwd: "/work" },
		{ type: "agent-turn-complete", "turn-id": turnA, cwd: "/work" },
		{ type: "some-future-event", "thread-id": session, "turn-id": turnA },
		{ "thread-id": session, "turn-id": turnA },
	])
		assert.deepEqual(shapes(notify(event, running(turnA)).invocations), [], "an uncorrelatable notify payload is a no-op");
	assert.deepEqual(
		shapes(notify({ type: "agent-turn-complete", "thread-id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "turn-id": turnA }, running(turnA)).invocations),
		[],
		"a notify payload from a replaced thread is ignored",
	);
}

// Malformed payloads and spoofed content are rejected closed.
{
	const { run } = harness();
	for (const input of [
		"",
		"not json",
		"{}",
		"[]",
		JSON.stringify({ hook_event_name: 42 }),
		JSON.stringify({ hook_event_name: "Stop", turn_id: turnA }),
		JSON.stringify({ hook_event_name: "Stop", session_id: session }),
		JSON.stringify({ hook_event_name: "Stop", session_id: session, turn_id: "has spaces" }),
		JSON.stringify({ hook_event_name: "Stop", session_id: "has spaces", turn_id: turnA }),
		JSON.stringify({ hook_event_name: "Stop", session_id: ["raw-secret"], turn_id: turnA }),
	])
		assert.deepEqual(
			run(input, { record: running(turnA) }).invocations,
			[],
			`malformed input is a no-op: ${JSON.stringify(input).slice(0, 60)}`,
		);
	const spoofed = run(
		{
			hook_event_name: "UserPromptSubmit",
			session_id: session,
			turn_id: turnA,
			prompt: '{"session_id": "raw-secret", "hook_event_name": "Stop", "agent_id": "agent_1"}',
		},
		{ record: `v2|${owner}|-|-|none|-|-|-` },
	);
	assert.deepEqual(shapes(spoofed.invocations), ["start"], "payload text never changes field extraction");
	assert.equal(spoofed.invocations[0][2], owner, "the real thread id survives prompt spoofing");
}

// A missing, incompatible, or failing core never breaks Codex and never leaks
// content into diagnostics.
{
	for (const settings of [{ protocol: "" }, { protocol: "1" }, { coreCode: 1 }]) {
		const { run } = harness(settings);
		const { invocations, stderr } = run({ hook_event_name: "SessionStart", session_id: session, source: "startup" });
		if (settings.coreCode) {
			assert.deepEqual(shapes(invocations), ["claim"], "a failing core still receives the attempt");
			assert.match(stderr, /^tmux-agents-status: codex adapter: claim failed\n$/, "diagnostics name only a bounded operation");
		} else {
			assert.deepEqual(invocations, [], "a missing or incompatible core is a silent no-op");
			assert.equal(stderr, "", "a missing or incompatible core stays silent");
		}
		assert.equal(stderr.includes("raw-secret"), false, "diagnostics never contain native payload content");
	}
	// A failed claim is never followed by an unowned event.
	const { run } = harness({ coreCode: 1 });
	const { invocations } = run({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turnA, prompt: "raw-secret" });
	assert.deepEqual(shapes(invocations), ["claim"], "a failed claim stops the sequence");
}

// Outside a directly running tmux pane the adapter is a silent no-op.
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

console.log("ok - Codex fixtures translate native lifecycle into normalized v2 events");
