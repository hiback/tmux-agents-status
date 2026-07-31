import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const socket = `tmux-agents-status-lifecycle-${process.pid}`;
const tmux = (...args) =>
	execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

try {
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "lifecycle");
	tmux("run-shell", `${root}/tmux-agents-status.tmux`);
	const pane = tmux("display-message", "-p", "#{pane_id}").trim();
	const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
	const [session, window] = tmux(
		"display-message",
		"-p",
		"#{session_id} #{window_id}",
	)
		.trim()
		.split(" ");
	process.env.TMUX = `${socketPath},${process.pid},0`;
	process.env.TMUX_PANE = pane;

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

	const handlers = new Map();
	const api = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		async exec(command, args) {
			try {
				const result = await exec(command, args, { env: process.env });
				return { code: 0, stdout: result.stdout };
			} catch (error) {
				return { code: error.code ?? 1, stdout: error.stdout ?? "" };
			}
		},
	};
	const option = (kind) =>
		tmux("show-option", "-sqv", `@tmux-agents-status-${kind}-${pane}`).trim();
	const render = () =>
		execFileSync(`${root}/scripts/render-window`, [session, window, pane], {
			encoding: "utf8",
			env: process.env,
		});
	const extension = (
		await import(new URL("../packages/pi/index.ts", import.meta.url).href)
	).default;
	const tui = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-1" },
		isIdle: () => true,
	};
	const assistant = (stopReason) => ({
		message: { role: "assistant", stopReason },
	});

	extension(api);
	await handlers.get("session_start")({ reason: "startup" }, tui);
	assert.match(option("state"), /^v2\|pi:[^|]+\|pid:[0-9]+\|-\|none\|-\|-\|-$/);
	const owner = option("state").split("|")[1];
	await handlers.get("agent_start")({}, tui);
	const running = option("state");
	assert.match(
		running,
		new RegExp(
			`^v2\\|${owner}\\|pid:${process.pid}\\|turn:[^|]+\\|running\\|-\\|-\\|-$`,
		),
	);
	assert.equal(render(), "#[push-default]#[default] R#[default]#[pop-default]\n");
	const turn = running.split("|")[3];

	// A retry and queued continuation remain within the accepted turn. Only the
	// latest structural outcome is classified at final settlement.
	await handlers.get("message_end")(assistant("error"), tui);
	await handlers.get("agent_start")({}, tui);
	assert.equal(option("state"), running);
	await handlers.get("message_end")(assistant("stop"), tui);
	await handlers.get("agent_settled")({}, tui);
	const completed = option("state");
	assert.match(
		completed,
		new RegExp(
			`^v2\\|${owner}\\|pid:${process.pid}\\|${turn}\\|completed\\|g:[0-9a-f]{32}\\|-\\|-$`,
		),
	);
	assert.equal(render(), "#[push-default]#[default] #[reverse]C#[default]#[default]#[pop-default]\n");

	await handlers.get("session_shutdown")({ reason: "reload" }, tui);
	const reloadHandlers = new Map();
	extension({
		...api,
		on: (event, handler) => reloadHandlers.set(event, handler),
	});
	await reloadHandlers.get("session_start")({ reason: "reload" }, tui);
	assert.equal(
		option("state"),
		completed,
		"reload preserves terminal state and ownership",
	);

	await reloadHandlers.get("session_shutdown")({ reason: "new" }, tui);
	assert.equal(option("state"), "");
	const replacementContext = {
		...tui,
		sessionManager: { getSessionId: () => "session-2" },
	};
	await reloadHandlers.get("session_start")(
		{ reason: "new" },
		replacementContext,
	);
	const replacement = option("state");
	assert.match(replacement, /^v2\|pi:[^|]+\|pid:[0-9]+\|-\|none\|-\|-\|-$/);
	assert.notEqual(replacement.split("|")[1], owner);

	await reloadHandlers.get("agent_start")({}, replacementContext);
	await reloadHandlers.get("message_end")(
		assistant("aborted"),
		replacementContext,
	);
	await reloadHandlers.get("agent_settled")({}, replacementContext);
	assert.match(option("state"), /\|failed\|g:[0-9a-f]{32}\|-\|-$/);
	assert.equal(render(), "#[push-default]#[default] #[reverse]F#[default]#[default]#[pop-default]\n");
	await reloadHandlers.get("session_shutdown")(
		{ reason: "quit" },
		replacementContext,
	);
	assert.equal(
		option("state"),
		"",
		"graceful idle quit clears terminal ownership",
	);
	assert.equal(option("ack"), "");
} finally {
	try {
		tmux("kill-server");
	} catch {}
}

console.log(
	"ok - native Pi events reach rendered v2 status through the shared core",
);
