import assert from "node:assert/strict";

const extension = (
	await import(new URL("../pi/tmux-agents-status.ts", import.meta.url).href)
).default;

function fakePi({ setCode = 0, listCode = 0, failedRefresh = "" } = {}) {
	const calls = [];
	const handlers = new Map();
	return {
		calls,
		handlers,
		api: {
			on(event, handler) {
				handlers.set(event, handler);
			},
			async exec(command, args) {
				calls.push([command, ...args]);
				if (args[0] === "set-option")
					return { code: setCode, stdout: "", stderr: "" };
				if (args[0] === "list-clients") {
					return {
						code: listCode,
						stdout: "client one\nclient-two\n",
						stderr: "",
					};
				}
				return {
					code: args.at(-1) === failedRefresh ? 1 : 0,
					stdout: "",
					stderr: "",
				};
			},
		},
	};
}

const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
try {
	process.env.TMUX = "/tmp/tmux.sock,1,0";
	process.env.TMUX_PANE = "%42";

	const running = fakePi({ failedRefresh: "client one" });
	extension(running.api);
	assert.deepEqual([...running.handlers.keys()], ["agent_start"]);
	assert.deepEqual(running.calls, [], "startup must not publish pane state");
	await running.handlers.get("agent_start")({}, { mode: "tui" });

	assert.equal(running.calls.length, 4);
	const [setCall, listCall, firstRefresh, secondRefresh] = running.calls;
	assert.deepEqual(setCall.slice(0, 4), [
		"tmux",
		"set-option",
		"-s",
		"@tmux-agents-status-state-%42",
	]);
	assert.match(
		setCall[4],
		new RegExp(
			`^v1\\|${process.pid}\\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\|running\\|-$`,
		),
	);
	assert.deepEqual(listCall, ["tmux", "list-clients", "-F", "#{client_name}"]);
	assert.deepEqual(firstRefresh, [
		"tmux",
		"refresh-client",
		"-S",
		"-t",
		"client one",
	]);
	assert.deepEqual(secondRefresh, [
		"tmux",
		"refresh-client",
		"-S",
		"-t",
		"client-two",
	]);

	const printMode = fakePi();
	extension(printMode.api);
	await printMode.handlers.get("agent_start")({}, { mode: "print" });
	assert.deepEqual(
		printMode.calls,
		[],
		"non-TUI launches must be silent no-ops",
	);

	const failedWrite = fakePi({ setCode: 1 });
	extension(failedWrite.api);
	await failedWrite.handlers.get("agent_start")({}, { mode: "tui" });
	assert.equal(
		failedWrite.calls.length,
		1,
		"refresh must wait for successful persistence",
	);

	for (const [tmux, pane] of [
		["", "%42"],
		["server", "42"],
		["server", "%bad"],
	]) {
		process.env.TMUX = tmux;
		process.env.TMUX_PANE = pane;
		const inactive = fakePi();
		extension(inactive.api);
		assert.deepEqual([...inactive.handlers.keys()], []);
		assert.deepEqual(inactive.calls, []);
	}
} finally {
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
	if (originalPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalPane;
}

console.log(
	"ok - Pi companion publishes running only on accepted TUI agent starts",
);
