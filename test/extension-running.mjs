import assert from "node:assert/strict";

const extension = (
	await import(new URL("../pi/tmux-agents-status.ts", import.meta.url).href)
).default;

function fakePi({
	setCode = 0,
	setCodes,
	listCode = 0,
	clients = "client one|@7\nclient-two|@8\n",
	clientPanes = "client one|%99\nclient-two|%100\n",
	paneWindow = "@7\n",
	failedRefresh = "",
} = {}) {
	const calls = [];
	const handlers = new Map();
	let writeIndex = 0;
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
					return {
						code: setCodes?.[writeIndex++] ?? setCode,
						stdout: "",
						stderr: "",
					};
				if (args[0] === "list-clients")
					return {
						code: listCode,
						stdout: args.at(-1).includes("pane_id") ? clientPanes : clients,
						stderr: "",
					};
				if (args[0] === "display-message")
					return { code: 0, stdout: paneWindow, stderr: "" };
				return {
					code: args.at(-1) === failedRefresh ? 1 : 0,
					stdout: "",
					stderr: "",
				};
			},
		},
	};
}

const tui = { mode: "tui" };
const assistant = (stopReason) => ({
	message: { role: "assistant", stopReason },
});
const generationFrom = (record) => record.split("|").at(-1);

const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
try {
	process.env.TMUX = "/tmp/tmux.sock,1,0";
	process.env.TMUX_PANE = "%42";

	const lifecycle = fakePi({ failedRefresh: "client one" });
	extension(lifecycle.api);
	assert.deepEqual(
		[...lifecycle.handlers.keys()],
		["agent_start", "message_end", "agent_settled"],
	);
	assert.deepEqual(lifecycle.calls, [], "startup must not publish pane state");

	await lifecycle.handlers.get("agent_start")({}, tui);
	assert.equal(lifecycle.calls.length, 4);
	const [runningWrite, runningClients, firstRefresh, secondRefresh] =
		lifecycle.calls;
	assert.deepEqual(runningWrite.slice(0, 4), [
		"tmux",
		"set-option",
		"-s",
		"@tmux-agents-status-state-%42",
	]);
	assert.match(
		runningWrite[4],
		new RegExp(
			`^v1\\|${process.pid}\\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\|running\\|-$`,
		),
	);
	assert.deepEqual(runningWrite.slice(5), [
		";",
		"set-option",
		"-su",
		"@tmux-agents-status-ack-%42",
	]);
	assert.deepEqual(runningClients, [
		"tmux",
		"list-clients",
		"-F",
		"#{client_name}|#{window_id}",
	]);
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

	// Intermediate failures and retries stay running; only the latest assistant
	// outcome is classified at final settlement.
	await lifecycle.handlers.get("message_end")(assistant("error"), tui);
	await lifecycle.handlers.get("agent_start")({}, tui);
	await lifecycle.handlers.get("message_end")(assistant("stop"), tui);
	assert.equal(lifecycle.calls.length, 4);
	await lifecycle.handlers.get("agent_settled")({}, tui);
	assert.equal(lifecycle.calls.length, 9);
	const [
		alertClients,
		paneWindowQuery,
		completedWrite,
		thirdRefresh,
		fourthRefresh,
	] = lifecycle.calls.slice(4);
	assert.deepEqual(alertClients, runningClients);
	assert.deepEqual(paneWindowQuery, [
		"tmux",
		"display-message",
		"-p",
		"-t",
		"%42",
		"#{window_id}",
	]);
	assert.match(completedWrite[4], /\|completed\|[0-9a-f-]{36}$/);
	const completedGeneration = generationFrom(completedWrite[4]);
	// Pane %42 is an inactive split (the clients' active panes are %99/%100),
	// but client one's displayed stable window @7 still acknowledges it.
	assert.deepEqual(completedWrite.slice(5), [
		";",
		"set-option",
		"-s",
		"@tmux-agents-status-ack-%42",
		completedGeneration,
	]);
	assert.deepEqual(thirdRefresh, firstRefresh);
	assert.deepEqual(fourthRefresh, secondRefresh);

	await lifecycle.handlers.get("agent_settled")({}, tui);
	assert.equal(
		lifecycle.calls.length,
		9,
		"repeating a terminal state must not re-arm it",
	);

	await lifecycle.handlers.get("agent_start")({}, tui);
	assert.match(lifecycle.calls[9][4], /\|running\|-$/);
	assert.deepEqual(lifecycle.calls[9].slice(5), runningWrite.slice(5));
	await lifecycle.handlers.get("message_end")(assistant("aborted"), tui);
	await lifecycle.handlers.get("agent_settled")({}, tui);
	const failedWrite = lifecycle.calls.findLast(
		(call) => call[1] === "set-option" && call[4]?.includes("|failed|"),
	);
	assert.match(failedWrite[4], /\|failed\|[0-9a-f-]{36}$/);
	assert.notEqual(generationFrom(failedWrite[4]), completedGeneration);

	const writes = () =>
		lifecycle.calls.filter((call) => call[1] === "set-option");
	const generations = new Set([
		completedGeneration,
		generationFrom(failedWrite[4]),
	]);
	for (const [reason, state] of [
		["toolUse", "completed"],
		["length", "failed"],
		["error", "failed"],
	]) {
		const before = writes().length;
		await lifecycle.handlers.get("agent_start")({}, tui);
		await lifecycle.handlers.get("message_end")(assistant(reason), tui);
		await lifecycle.handlers.get("agent_settled")({}, tui);
		const added = writes().slice(before);
		assert.equal(
			added.length,
			2,
			`${reason} must add exactly one transition pair`,
		);
		assert.match(added[0][4], /\|running\|-$/, `${reason} must start running`);
		assert.match(
			added[1][4],
			new RegExp(`\\|${state}\\|[0-9a-f-]{36}$`),
			`${reason} must settle as the latest ${state} write`,
		);
		const generation = generationFrom(added[1][4]);
		assert.equal(generations.has(generation), false, `${reason} must be fresh`);
		generations.add(generation);
	}
	assert.equal(
		lifecycle.calls.some((call) => call.join("|").includes("|waiting|")),
		false,
		"ordinary Pi events must never infer waiting",
	);

	const invisible = fakePi({ clients: "client|@8\n" });
	extension(invisible.api);
	await invisible.handlers.get("agent_start")({}, tui);
	await invisible.handlers.get("message_end")(assistant("stop"), tui);
	await invisible.handlers.get("agent_settled")({}, tui);
	const invisibleAlert = invisible.calls.findLast(
		(call) => call[1] === "set-option",
	);
	assert.equal(
		invisibleAlert.length,
		5,
		"an alert in a window no client displays must not be acknowledged",
	);

	const printMode = fakePi();
	extension(printMode.api);
	await printMode.handlers.get("agent_start")({}, { mode: "print" });
	await printMode.handlers.get("message_end")(assistant("stop"), {
		mode: "print",
	});
	await printMode.handlers.get("agent_settled")({}, { mode: "print" });
	assert.deepEqual(
		printMode.calls,
		[],
		"non-TUI launches must be silent no-ops",
	);

	const failedWritePi = fakePi({ setCodes: [1, 0] });
	extension(failedWritePi.api);
	await failedWritePi.handlers.get("agent_start")({}, tui);
	assert.equal(
		failedWritePi.calls.length,
		1,
		"refresh must wait for successful persistence",
	);
	await failedWritePi.handlers.get("agent_start")({}, tui);
	const runningRetries = failedWritePi.calls.filter(
		(call) => call[1] === "set-option",
	);
	assert.equal(
		runningRetries.length,
		2,
		"a later agent start must retry a failed running write",
	);
	assert.match(runningRetries.at(-1)[4], /\|running\|-$/);

	const failedAlertPi = fakePi({ setCodes: [0, 1, 0] });
	extension(failedAlertPi.api);
	await failedAlertPi.handlers.get("agent_start")({}, tui);
	await failedAlertPi.handlers.get("message_end")(assistant("stop"), tui);
	await failedAlertPi.handlers.get("agent_settled")({}, tui);
	const failedAlertCalls = failedAlertPi.calls.length;
	assert.equal(failedAlertPi.calls.at(-1)[1], "set-option");
	await failedAlertPi.handlers.get("agent_settled")({}, tui);
	const alertWrites = failedAlertPi.calls.filter(
		(call) => call[1] === "set-option" && call[4]?.includes("|completed|"),
	);
	assert.equal(
		alertWrites.length,
		2,
		"repeated settlement must retry a failed terminal write",
	);
	const retriedGeneration = generationFrom(alertWrites[1][4]);
	assert.notEqual(
		generationFrom(alertWrites[0][4]),
		retriedGeneration,
		"a retried terminal write must use a fresh generation",
	);
	assert.equal(
		alertWrites[1].at(-1),
		retriedGeneration,
		"a visible retry must persist its matching acknowledgement",
	);
	assert.equal(
		failedAlertPi.calls.length,
		failedAlertCalls + 5,
		"refresh must happen only after the successful terminal retry",
	);

	const retryStartPi = fakePi();
	extension(retryStartPi.api);
	await retryStartPi.handlers.get("agent_start")({}, tui);
	await retryStartPi.handlers.get("message_end")(assistant("error"), tui);
	await retryStartPi.handlers.get("agent_start")({}, tui);
	await retryStartPi.handlers.get("agent_settled")({}, tui);
	assert.equal(
		retryStartPi.calls.some(
			(call) => call[1] === "set-option" && call[4]?.includes("|failed|"),
		),
		true,
		"a pre-settlement retry start must preserve the latest outcome",
	);

	const abandonedAlertPi = fakePi({ setCodes: [0, 1] });
	extension(abandonedAlertPi.api);
	await abandonedAlertPi.handlers.get("agent_start")({}, tui);
	await abandonedAlertPi.handlers.get("message_end")(assistant("stop"), tui);
	await abandonedAlertPi.handlers.get("agent_settled")({}, tui);
	await abandonedAlertPi.handlers.get("agent_start")({}, tui);
	const callsBeforeNewSettlement = abandonedAlertPi.calls.length;
	await abandonedAlertPi.handlers.get("agent_settled")({}, tui);
	assert.equal(
		abandonedAlertPi.calls.length,
		callsBeforeNewSettlement,
		"a new turn without an outcome must not retry the prior failed alert",
	);
	assert.equal(
		abandonedAlertPi.calls.filter(
			(call) => call[1] === "set-option" && call[4]?.includes("|completed|"),
		).length,
		1,
		"a new accepted turn must discard the prior pending outcome",
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
	"ok - Pi companion publishes final turn outcomes without false alerts",
);
