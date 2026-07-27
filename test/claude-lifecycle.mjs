import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const hook = `${root}/packages/claude/bin/tmux-agents-status-hook`;
const socket = `tmux-agents-status-claude-${process.pid}`;
const tmux = (...args) =>
	execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

const session = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const owner = `claude:${session}`;

try {
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "claude");
	tmux("run-shell", `${root}/tmux-agents-status.tmux`);
	const pane = tmux("display-message", "-p", "#{pane_id}").trim();
	const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
	const [tmuxSession, window] = tmux("display-message", "-p", "#{session_id} #{window_id}")
		.trim()
		.split(" ");
	const env = {
		...process.env,
		TMUX: `${socketPath},${process.pid},0`,
		TMUX_PANE: pane,
	};

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

	const option = (kind) =>
		tmux("show-option", "-sqv", `@tmux-agents-status-${kind}-${pane}`).trim();
	const render = () =>
		execFileSync(`${root}/scripts/render-window`, [tmuxSession, window, pane], {
			encoding: "utf8",
			env,
		});
	const field = (index) => option("state").split("|")[index];

	// Every hook event is a separate short-lived process, as Claude Code runs it.
	const send = (event) => {
		const result = spawnSync(hook, [], {
			input: JSON.stringify(event),
			env,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, `${event.hook_event_name} never fails Claude Code`);
		assert.equal(result.stdout, "", `${event.hook_event_name} never writes stdout`);
		return result;
	};

	send({ hook_event_name: "SessionStart", session_id: session, source: "startup" });
	assert.match(
		option("state"),
		new RegExp(`^v2\\|${owner}\\|-\\|-\\|none\\|-\\|-\\|-$`),
		"session start claims the pane without inventing state",
	);
	assert.equal(render(), "\n", "ownership alone renders nothing");

	// Subagent tool activity never takes the pane over.
	send({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", agent_id: "agent_1" });
	assert.equal(field(4), "none", "subagent work stays invisible");

	send({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "raw-secret" });
	const running = option("state");
	assert.match(running, new RegExp(`^v2\\|${owner}\\|-\\|turn:[0-9a-f]{32}\\|running\\|-\\|-\\|-$`));
	assert.equal(render(), "#[default] R\n");
	const turn = field(3);

	// Permission and question hooks share one approximate waiting episode.
	send({ hook_event_name: "PermissionRequest", session_id: session, tool_name: "Bash", tool_input: { command: "raw-secret" } });
	const waiting = option("state");
	const generation = waiting.split("|")[5];
	assert.equal(waiting, `v2|${owner}|-|${turn}|waiting|${generation}|running|permission`);
	assert.match(generation, /^g:[0-9a-f]{32}$/);
	assert.equal(render(), "#[default] #[reverse]W#[default]\n");

	send({ hook_event_name: "Notification", session_id: session, notification_type: "permission_prompt", message: "raw-secret" });
	assert.equal(option("state"), waiting, "duplicate permission evidence joins the open episode");

	// Later foreground tool activity repairs the provisional wait.
	send({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: "raw-secret" } });
	assert.equal(option("state"), running, "approved activity resumes running");
	assert.equal(render(), "#[default] R\n");

	send({ hook_event_name: "PreToolUse", session_id: session, tool_name: "AskUserQuestion", tool_input: { questions: "raw-secret" } });
	assert.match(option("state"), new RegExp(`^v2\\|${owner}\\|-\\|${turn}\\|waiting\\|g:[0-9a-f]{32}\\|running\\|question$`));
	send({ hook_event_name: "PostToolUse", session_id: session, tool_name: "AskUserQuestion", tool_response: "raw-secret" });
	assert.equal(option("state"), running, "the answered question resumes running");

	// Paired MCP elicitation reports exact waiting from both native boundaries.
	send({ hook_event_name: "Elicitation", session_id: session, mcp_server_name: "docs", mode: "form", message: "raw-secret" });
	assert.match(
		option("state"),
		new RegExp(`^v2\\|${owner}\\|-\\|${turn}\\|waiting\\|g:[0-9a-f]{32}\\|running\\|elicitation$`),
	);
	send({ hook_event_name: "ElicitationResult", session_id: session, mcp_server_name: "docs", mode: "form", action: "accept", content: "raw-secret" });
	assert.equal(option("state"), running, "the paired elicitation result closes the exact wait");

	// Main-agent stop evidence reports approximate completion.
	send({ hook_event_name: "Stop", session_id: session, last_assistant_message: "raw-secret" });
	const completed = option("state");
	assert.match(completed, new RegExp(`^v2\\|${owner}\\|-\\|${turn}\\|completed\\|g:[0-9a-f]{32}\\|-\\|-$`));
	assert.equal(render(), "#[default] #[reverse]C#[default]\n");

	// A turn that continued past its blocked stop repairs the provisional
	// completion through the shared core's owner-checked dismissal.
	send({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Read" });
	assert.equal(option("state"), running, "later same-turn activity repairs approximate completion");
	send({ hook_event_name: "Stop", session_id: session, stop_hook_active: true });
	assert.match(option("state"), new RegExp(`^v2\\|${owner}\\|-\\|${turn}\\|completed\\|g:[0-9a-f]{32}\\|-\\|-$`));

	// Terminal API failure evidence reports exact failed and is never repaired.
	send({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "raw-secret" });
	assert.notEqual(field(3), turn, "a new prompt starts a new turn");
	send({ hook_event_name: "StopFailure", session_id: session, error: "overloaded", error_details: "raw-secret" });
	assert.equal(field(4), "failed");
	assert.equal(render(), "#[default] #[reverse]F#[default]\n");
	assert.equal(option("state").includes("raw-secret"), false, "native error content is never persisted");
	send({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash" });
	assert.equal(field(4), "failed", "exact terminal failure is never repaired");

	// Graceful session end after a terminal outcome clears the record quietly.
	send({ hook_event_name: "SessionEnd", session_id: session, reason: "logout" });
	assert.equal(option("state"), "", "a terminal outcome already reported is released clear");
	assert.equal(render(), "\n");

	// A later session replaces stale ownership without a false failure.
	const replacement = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
	send({ hook_event_name: "SessionStart", session_id: replacement, source: "resume" });
	assert.match(option("state"), new RegExp(`^v2\\|claude:${replacement}\\|-\\|-\\|none\\|-\\|-\\|-$`));
	assert.equal(option("ack"), "", "replacement clears stale acknowledgement");
	assert.equal(render(), "\n", "replacement without work renders nothing");

	// Ending a session during active work reports the interruption as failed.
	send({ hook_event_name: "UserPromptSubmit", session_id: replacement, prompt: "raw-secret" });
	assert.match(option("state"), new RegExp(`^v2\\|claude:${replacement}\\|-\\|turn:[0-9a-f]{32}\\|running\\|-\\|-\\|-$`));
	send({ hook_event_name: "SessionEnd", session_id: replacement, reason: "prompt_input_exit" });
	assert.match(
		option("state"),
		/^v2\|-\|-\|turn:[0-9a-f]{32}\|failed\|g:[0-9a-f]{32}\|-\|-$/,
		"graceful exit during active work reports failed",
	);
	assert.equal(render(), "#[default] #[reverse]F#[default]\n");

	// A graceful end with no reported state removes the record entirely.
	send({ hook_event_name: "SessionStart", session_id: replacement, source: "clear" });
	send({ hook_event_name: "SessionEnd", session_id: replacement, reason: "clear" });
	assert.equal(option("state"), "", "a quiet session end leaves no record");
} finally {
	try {
		tmux("kill-server");
	} catch {}
}

console.log("ok - native Claude Code events reach rendered v2 status through the shared core");
