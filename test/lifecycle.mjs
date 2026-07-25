import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const socket = `tmux-agents-status-lifecycle-${process.pid}`;
const tmux = (...args) =>
	execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const uuid = (digit) =>
	`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

try {
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "lifecycle");
	const pane = tmux("display-message", "-p", "#{pane_id}").trim();
	const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
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
	const extension = (
		await import(new URL("../pi/tmux-agents-status.ts", import.meta.url).href)
	).default;
	const tui = { mode: "tui" };

	const oldGeneration = uuid("2");
	tmux(
		"set-option",
		"-s",
		`@tmux-agents-status-state-${pane}`,
		`v1|99|${uuid("1")}|completed|${oldGeneration}`,
	);
	tmux("set-option", "-s", `@tmux-agents-status-ack-${pane}`, oldGeneration);
	extension(api);
	await handlers.get("session_start")({ reason: "startup" }, tui);
	assert.equal(option("state"), "");
	assert.equal(option("ack"), "");

	await handlers.get("agent_start")({}, tui);
	const running = option("state");
	assert.match(running, /\|running\|-$/);
	const incarnation = running.split("|")[2];

	await handlers.get("session_shutdown")({ reason: "reload" }, tui);
	const reloadHandlers = new Map();
	extension({
		...api,
		on: (event, handler) => reloadHandlers.set(event, handler),
	});
	await handlers.get("session_shutdown")({ reason: "quit" }, tui);
	await handlers.get("session_start")({ reason: "startup" }, tui);
	await handlers.get("agent_start")({}, tui);
	await handlers.get("message_end")(
		{ message: { role: "assistant", stopReason: "stop" } },
		tui,
	);
	await handlers.get("agent_settled")({}, tui);
	assert.equal(option("state"), running, "replaced handlers must be inert");
	assert.equal(option("ack"), "");

	await reloadHandlers.get("session_start")({ reason: "reload" }, tui);
	assert.equal(option("state"), running);
	assert.equal(option("state").split("|")[2], incarnation);
	await reloadHandlers.get("message_end")(
		{ message: { role: "assistant", stopReason: "stop" } },
		tui,
	);
	await reloadHandlers.get("agent_settled")({}, tui);
	const completed = option("state");
	const completedAck = option("ack");
	assert.match(completed, /\|completed\|[0-9a-f-]{36}$/);
	await reloadHandlers.get("session_shutdown")({ reason: "reload" }, tui);
	const terminalReloadHandlers = new Map();
	extension({
		...api,
		on: (event, handler) => terminalReloadHandlers.set(event, handler),
	});
	await terminalReloadHandlers.get("session_start")({ reason: "reload" }, tui);
	assert.equal(option("state"), completed);
	assert.equal(option("ack"), completedAck);

	let activeHandlers = terminalReloadHandlers;
	for (const reason of ["new", "resume", "fork"]) {
		await activeHandlers.get("session_shutdown")({ reason }, tui);
		const replacedHandlers = activeHandlers;
		const nextHandlers = new Map();
		extension({
			...api,
			on: (event, handler) => nextHandlers.set(event, handler),
		});
		await replacedHandlers.get("session_start")({ reason: "startup" }, tui);
		await replacedHandlers.get("agent_start")({}, tui);
		assert.equal(option("state"), "", "replaced context must stay empty");
		await nextHandlers.get("session_start")({ reason }, tui);
		assert.equal(option("state"), "");
		assert.equal(option("ack"), "");
		await nextHandlers.get("agent_start")({}, tui);
		assert.equal(option("state").split("|")[2], incarnation);
		activeHandlers = nextHandlers;
	}

	await activeHandlers.get("session_shutdown")({ reason: "quit" }, tui);
	const failed = option("state");
	assert.match(failed, /\|failed\|[0-9a-f-]{36}$/);

	const waitingHandlers = new Map();
	extension({
		...api,
		on: (event, handler) => waitingHandlers.set(event, handler),
	});
	await waitingHandlers.get("session_start")({ reason: "startup" }, tui);
	await waitingHandlers.get("agent_start")({}, tui);
	tmux(
		"set-option",
		"-s",
		`@tmux-agents-status-state-${pane}`,
		`v1|${process.pid}|${incarnation}|waiting|${uuid("6")}`,
	);
	await waitingHandlers.get("session_shutdown")({ reason: "quit" }, tui);
	assert.match(option("state"), /\|failed\|[0-9a-f-]{36}$/);

	const replacement = `v1|88|${uuid("3")}|running|-`;
	tmux("set-option", "-s", `@tmux-agents-status-state-${pane}`, replacement);
	await waitingHandlers.get("agent_start")({}, tui);
	await waitingHandlers.get("session_shutdown")({ reason: "quit" }, tui);
	assert.equal(option("state"), replacement);

	tmux("set-option", "-su", `@tmux-agents-status-state-${pane}`);
	const absentHandlers = new Map();
	extension({
		...api,
		on: (event, handler) => absentHandlers.set(event, handler),
	});
	await absentHandlers.get("session_start")({ reason: "new" }, tui);
	await absentHandlers.get("agent_start")({}, tui);
	assert.equal(
		option("state"),
		"",
		"absence after lost ownership must not authorize creation",
	);

	const idleHandlers = new Map();
	extension({
		...api,
		on: (event, handler) => idleHandlers.set(event, handler),
	});
	await idleHandlers.get("session_start")({ reason: "startup" }, tui);
	await idleHandlers.get("agent_start")({}, tui);
	await idleHandlers.get("message_end")(
		{ message: { role: "assistant", stopReason: "stop" } },
		tui,
	);
	await idleHandlers.get("agent_settled")({}, tui);
	await idleHandlers.get("session_shutdown")({ reason: "quit" }, tui);
	assert.equal(option("state"), "");
	assert.equal(option("ack"), "");

	const deadGeneration = uuid("4");
	tmux(
		"set-option",
		"-s",
		`@tmux-agents-status-state-${pane}`,
		`v1|99999999|${uuid("5")}|failed|${deadGeneration}`,
	);
	tmux("set-option", "-su", `@tmux-agents-status-ack-${pane}`);
	const [session, window] = tmux(
		"display-message",
		"-p",
		"#{session_id} #{window_id}",
	)
		.trim()
		.split(" ");
	const render = () =>
		execFileSync(`${root}/scripts/render-window`, [session, window, pane], {
			encoding: "utf8",
			env: process.env,
		});
	assert.equal(render(), "#[default] #[reverse]F#[default]\n");
	tmux("set-option", "-s", `@tmux-agents-status-ack-${pane}`, deadGeneration);
	assert.equal(render(), "\n");
} finally {
	try {
		tmux("kill-server");
	} catch {}
}

console.log("ok - isolated tmux observes Pi lifecycle ownership transitions");
