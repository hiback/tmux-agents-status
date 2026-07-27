import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const socket = `tmux-agents-status-opencode-${process.pid}`;
const tmux = (...args) =>
	execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

try {
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "opencode");
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

	// The plugin receives OpenCode's shell helper, which passes interpolated
	// values as separate arguments rather than shell text.
	const shell = (strings, command, args) => {
		assert.deepEqual([...strings], ["", " ", ""]);
		const result = exec(command, args, { env: process.env }).then(
			({ stdout }) => ({ exitCode: 0, stdout: Buffer.from(stdout) }),
			(error) => ({
				exitCode: error.code ?? 1,
				stdout: Buffer.from(error.stdout ?? ""),
			}),
		);
		const promise = {
			then: (resolve, reject) => result.then(resolve, reject),
			quiet: () => promise,
			nothrow: () => promise,
		};
		return promise;
	};

	const option = (kind) =>
		tmux("show-option", "-sqv", `@tmux-agents-status-${kind}-${pane}`).trim();
	const render = () =>
		execFileSync(`${root}/scripts/render-window`, [session, window, pane], {
			encoding: "utf8",
			env: process.env,
		});
	const field = (index) => option("state").split("|")[index];

	const { TmuxAgentsStatusPlugin } = await import(
		new URL("../packages/opencode/tmux-agents-status.ts", import.meta.url).href
	);
	const hooks = await TmuxAgentsStatusPlugin({
		$: shell,
		directory: "/work",
		worktree: "/work",
		client: {
			session: {
				get: async () => {
					throw new Error("session lookups are unnecessary for live sessions");
				},
			},
		},
	});
	const send = (event) => hooks.event({ event });
	const status = (sessionID, type) =>
		send({
			type: "session.status",
			properties: { sessionID, status: { type } },
		});

	await send({
		type: "session.created",
		properties: { info: { id: "ses_live", directory: "/work" } },
	});
	assert.match(
		option("state"),
		/^v2\|opencode:[^|]+\|pid:[0-9]+\|-\|none\|-\|-\|-$/,
		"plugin initialization claims the pane without inventing state",
	);
	const owner = field(1);
	assert.equal(render(), "\n", "ownership alone renders nothing");

	// A subagent session must not take the pane over from its root session.
	await send({
		type: "session.created",
		properties: { info: { id: "ses_child", parentID: "ses_live" } },
	});
	await status("ses_child", "busy");
	assert.equal(field(4), "none", "child-session work stays invisible");

	await status("ses_live", "busy");
	const running = option("state");
	assert.match(
		running,
		new RegExp(
			`^v2\\|${owner}\\|pid:${process.pid}\\|turn:[^|]+\\|running\\|-\\|-\\|-$`,
		),
	);
	assert.equal(render(), "#[default] R\n");
	const turn = field(3);

	// Correlated permission and question requests share one waiting episode.
	await send({
		type: "permission.asked",
		properties: { id: "per_live", sessionID: "ses_live", permission: "bash" },
	});
	const waiting = option("state");
	const generation = waiting.split("|")[5];
	assert.equal(
		waiting,
		`v2|${owner}|pid:${process.pid}|${turn}|waiting|${generation}|running|per_live`,
	);
	assert.match(generation, /^g:[0-9a-f]{32}$/);
	assert.equal(render(), "#[default] #[reverse]W#[default]\n");

	await send({
		type: "question.asked",
		properties: { id: "qst_live", sessionID: "ses_live" },
	});
	assert.equal(
		option("state"),
		`v2|${owner}|pid:${process.pid}|${turn}|waiting|${generation}|running|per_live,qst_live`,
		"a second pending request joins the open waiting episode",
	);
	await status("ses_live", "busy");
	assert.equal(
		option("state"),
		`v2|${owner}|pid:${process.pid}|${turn}|waiting|${generation}|running|per_live,qst_live`,
		"continued busy evidence never cancels pending user input",
	);

	await send({
		type: "question.replied",
		properties: { sessionID: "ses_live", requestID: "qst_live", answers: [] },
	});
	assert.equal(
		option("state"),
		`v2|${owner}|pid:${process.pid}|${turn}|waiting|${generation}|running|per_live`,
		"waiting persists until the last matching request closes",
	);
	await send({
		type: "permission.replied",
		properties: {
			sessionID: "ses_live",
			requestID: "per_live",
			reply: "once",
		},
	});
	assert.equal(option("state"), running, "the final reply resumes running");
	assert.equal(render(), "#[default] R\n");

	await status("ses_live", "idle");
	assert.match(
		option("state"),
		new RegExp(
			`^v2\\|${owner}\\|pid:${process.pid}\\|${turn}\\|completed\\|g:[0-9a-f]{32}\\|-\\|-$`,
		),
		"terminal idle without failure evidence completes the turn",
	);
	assert.equal(render(), "#[default] #[reverse]C#[default]\n");

	// Typed failure evidence classifies the next turn of the same session.
	await status("ses_live", "busy");
	assert.notEqual(field(3), turn, "a later busy edge starts a new turn");
	await send({
		type: "session.error",
		properties: {
			sessionID: "ses_live",
			error: { name: "ProviderAuthError", data: { message: "raw-secret" } },
		},
	});
	await status("ses_live", "idle");
	assert.equal(field(4), "failed");
	assert.equal(render(), "#[default] #[reverse]F#[default]\n");
	assert.equal(
		option("state").includes("raw-secret"),
		false,
		"native error content is never persisted",
	);

	// Another root session starting work replaces ownership without a false alert.
	await send({
		type: "session.created",
		properties: { info: { id: "ses_next", directory: "/work" } },
	});
	await status("ses_next", "busy");
	const replacement = option("state");
	assert.match(
		replacement,
		new RegExp(
			`^v2\\|opencode:[^|]+\\|pid:${process.pid}\\|turn:[^|]+\\|running\\|-\\|-\\|-$`,
		),
	);
	assert.notEqual(replacement.split("|")[1], owner);
	assert.equal(option("ack"), "", "replacement clears stale acknowledgement");

	// Awaited disposal releases ownership and reports abandoned work.
	await hooks.dispose();
	assert.match(
		option("state"),
		/^v2\|-\|-\|turn:[^|]+\|failed\|g:[0-9a-f]{32}\|-\|-$/,
		"disposal during active work publishes failure and removes ownership",
	);
	assert.equal(render(), "#[default] #[reverse]F#[default]\n");

	await status("ses_next", "busy");
	assert.match(
		option("state"),
		/^v2\|-\|-\|turn:[^|]+\|failed\|/,
		"events after disposal cannot revive a released owner",
	);
} finally {
	try {
		tmux("kill-server");
	} catch {}
}

console.log(
	"ok - native OpenCode events reach rendered v2 status through the shared core",
);
