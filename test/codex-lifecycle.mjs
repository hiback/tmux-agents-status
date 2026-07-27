import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const hook = `${root}/packages/codex/bin/tmux-agents-status-hook`;
const socket = `tmux-agents-status-codex-${process.pid}`;
const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

const session = "9f1d2c3b-4a5e-4f60-8b71-2c3d4e5f6071";
const owner = `codex:${session}`;
const turnA = "01994f2b1a2c7cd09e3f4b5c6d7e8f90";
const turnB = "01994f2b3d4e7cd18a2b3c4d5e6f7081";

try {
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "codex");
	tmux("run-shell", `${root}/tmux-agents-status.tmux`);
	const pane = tmux("display-message", "-p", "#{pane_id}").trim();
	const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
	const [tmuxSession, window] = tmux("display-message", "-p", "#{session_id} #{window_id}").trim().split(" ");
	const env = { ...process.env, TMUX: `${socketPath},${process.pid},0`, TMUX_PANE: pane };

	for (const [name, value] of [
		["running-glyph", "R"],
		["running-style", ""],
		["waiting-glyph", "W"],
		["waiting-style", ""],
		["completed-glyph", "C"],
		["completed-style", ""],
		["failed-glyph", "F"],
		["failed-style", ""],
		["unread-style", "reverse"],
	])
		tmux("set-option", "-g", `@tmux-agents-status-${name}`, value);

	const option = (kind) => tmux("show-option", "-sqv", `@tmux-agents-status-${kind}-${pane}`).trim();
	const render = () =>
		execFileSync(`${root}/scripts/render-window`, [tmuxSession, window, pane], { encoding: "utf8", env });
	const field = (index) => option("state").split("|")[index];

	// Every hook event is a separate short-lived process, as Codex runs it.
	const send = (event) => {
		const result = spawnSync(hook, [], { input: JSON.stringify(event), env, encoding: "utf8" });
		assert.equal(result.status, 0, `${event.hook_event_name} never fails Codex`);
		assert.equal(result.stdout, "", `${event.hook_event_name} never writes stdout`);
	};
	// The legacy notify program receives its payload as the last argument.
	const notify = (event) => {
		const result = spawnSync(hook, [JSON.stringify(event)], { input: "", env, encoding: "utf8" });
		assert.equal(result.status, 0, "the notify program never fails Codex");
		assert.equal(result.stdout, "", "the notify program never writes stdout");
	};

	send({ hook_event_name: "SessionStart", session_id: session, source: "startup" });
	assert.equal(option("state"), `v2|${owner}|-|-|none|-|-|-`, "session start claims the pane without inventing state");
	assert.equal(render(), "\n", "ownership alone renders nothing");

	// Subagent tool activity never takes the pane over.
	send({ hook_event_name: "PreToolUse", session_id: session, turn_id: turnA, tool_name: "Bash", agent_id: "agent_1" });
	assert.equal(field(4), "none", "subagent work stays invisible");

	send({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turnA, prompt: "raw-secret" });
	const running = option("state");
	assert.equal(running, `v2|${owner}|-|turn:${turnA}|running|-|-|-`, "prompt submission reports approximate running");
	assert.equal(render(), "#[default] R\n");

	send({ hook_event_name: "PreToolUse", session_id: session, turn_id: turnA, tool_name: "Bash", tool_input: { command: "raw-secret" } });
	assert.equal(option("state"), running, "activity inside a reported turn changes nothing");

	// Native permission requests report approval-only approximate waiting.
	send({ hook_event_name: "PermissionRequest", session_id: session, turn_id: turnA, tool_name: "Bash", tool_input: { command: "raw-secret" } });
	const waiting = option("state");
	const generation = waiting.split("|")[5];
	assert.equal(waiting, `v2|${owner}|-|turn:${turnA}|waiting|${generation}|running|permission`);
	assert.match(generation, /^g:[0-9a-f]{32}$/);
	assert.equal(render(), "#[default] #[reverse]W#[default]\n");

	send({ hook_event_name: "PermissionRequest", session_id: session, turn_id: turnA, tool_name: "apply_patch", tool_input: { command: "raw-secret" } });
	assert.equal(option("state"), waiting, "a second approval request joins the open episode");

	// The approved tool call is the correlated repair for the provisional wait.
	send({ hook_event_name: "PostToolUse", session_id: session, turn_id: turnA, tool_name: "Bash", tool_response: "raw-secret" });
	assert.equal(option("state"), running, "later foreground activity resumes running");

	// Main-agent stop evidence reports approximate completion.
	send({ hook_event_name: "Stop", session_id: session, turn_id: turnA, stop_hook_active: false, last_assistant_message: "raw-secret" });
	const completed = option("state");
	assert.match(completed, new RegExp(`^v2\\|${owner}\\|-\\|turn:${turnA}\\|completed\\|g:[0-9a-f]{32}\\|-\\|-$`));
	assert.equal(render(), "#[default] #[reverse]C#[default]\n");

	// A turn that continued past its blocked stop repairs the provisional
	// completion through the shared core's owner-checked dismissal.
	send({ hook_event_name: "PreToolUse", session_id: session, turn_id: turnA, tool_name: "apply_patch" });
	assert.equal(option("state"), running, "later same-turn activity repairs approximate completion");
	send({ hook_event_name: "Stop", session_id: session, turn_id: turnA, stop_hook_active: true });
	assert.equal(field(4), "completed");

	// Agent-turn-complete is the second approved completion signal; a delayed
	// delivery for a superseded turn can never reopen or resettle work.
	notify({ type: "agent-turn-complete", "thread-id": session, "turn-id": turnA, cwd: "/work", "input-messages": ["raw-secret"], "last-assistant-message": "raw-secret" });
	assert.equal(field(4), "completed", "a repeated completion signal is idempotent");

	send({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turnB, prompt: "raw-secret" });
	assert.equal(option("state"), `v2|${owner}|-|turn:${turnB}|running|-|-|-`, "a new prompt supersedes the reported completion");
	assert.equal(option("ack"), "", "a superseding turn clears stale acknowledgement");

	notify({ type: "agent-turn-complete", "thread-id": session, "turn-id": turnA, cwd: "/work" });
	assert.equal(field(4), "running", "a delayed notify from a superseded turn is ignored");
	notify({ type: "agent-turn-complete", "thread-id": session, "turn-id": turnB, cwd: "/work", "last-assistant-message": "raw-secret" });
	assert.equal(field(4), "completed", "agent-turn-complete reports approximate completion");
	assert.equal(render(), "#[default] #[reverse]C#[default]\n");

	// User cancellation and failed turns expose no native evidence, so the
	// adapter must never invent a failed outcome for them.
	send({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: turnA, prompt: "raw-secret" });
	assert.equal(field(4), "running");
	send({ hook_event_name: "PreCompact", session_id: session, turn_id: turnA, trigger: "auto" });
	send({ hook_event_name: "SubagentStop", session_id: session, turn_id: turnA, agent_id: "agent_1", agent_type: "reviewer" });
	assert.equal(field(4), "running", "unsupported classes leave the reported state untouched");
	assert.equal(option("state").includes("raw-secret"), false, "native payload content is never persisted");

	// Graceful session end during active work reports the interruption.
	send({ hook_event_name: "SessionEnd", session_id: session, reason: "other" });
	assert.match(
		option("state"),
		new RegExp(`^v2\\|-\\|-\\|turn:${turnA}\\|failed\\|g:[0-9a-f]{32}\\|-\\|-$`),
		"graceful exit during active work reports failed",
	);
	assert.equal(render(), "#[default] #[reverse]F#[default]\n");

	// A later session replaces stale ownership without a false failure.
	const replacement = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	send({ hook_event_name: "SessionStart", session_id: replacement, source: "resume" });
	assert.equal(option("state"), `v2|codex:${replacement}|-|-|none|-|-|-`);
	assert.equal(option("ack"), "", "replacement clears stale acknowledgement");
	assert.equal(render(), "\n", "replacement without work renders nothing");

	// Compaction is not replacement, and a graceful end after a reported
	// outcome clears the record quietly.
	send({ hook_event_name: "UserPromptSubmit", session_id: replacement, turn_id: turnA, prompt: "raw-secret" });
	send({ hook_event_name: "SessionStart", session_id: session, source: "compact" });
	assert.equal(field(1), `codex:${replacement}`, "compaction never claims the pane");
	send({ hook_event_name: "Stop", session_id: replacement, turn_id: turnA, stop_hook_active: false });
	send({ hook_event_name: "SessionEnd", session_id: replacement, reason: "other" });
	assert.equal(option("state"), "", "a reported outcome is released clear");
	assert.equal(render(), "\n");
} finally {
	try {
		tmux("kill-server");
	} catch {}
}

console.log("ok - native Codex events reach rendered v2 status through the shared core");
