import assert from "node:assert/strict";

const extension = (
	await import(new URL("../pi/tmux-agents-status.ts", import.meta.url).href)
).default;

function fakePi({
	setCode = 0,
	setCodes,
	showCode = 0,
	listCode = 0,
	displayCode = 0,
	clients = "client one|@7\nclient-two|@8\n",
	clientPanes = "client one|%99\nclient-two|%100\n",
	paneWindow = "@7\n",
	failedRefresh = "",
	rejectOperation = "",
	partialClearAt = 0,
} = {}) {
	const calls = [];
	const handlers = new Map();
	const server = {};
	let writeIndex = 0;
	let clearIndex = 0;
	return {
		calls,
		handlers,
		server,
		api: {
			on(event, handler) {
				handlers.set(event, handler);
			},
			async exec(command, args) {
				calls.push([command, ...args]);
				if (args[0] === rejectOperation) throw new Error("raw-secret");
				if (args[0] === "show-options")
					return {
						code: showCode,
						stdout:
							server.state === undefined
								? ""
								: `@tmux-agents-status-state-%42 ${server.state}\n`,
						stderr: "raw-secret",
					};
				if (args[0] === "set-option") {
					if (args[1] === "-su" && ++clearIndex === partialClearAt) {
						server.state = undefined;
						return { code: 1, stdout: "", stderr: "raw-secret" };
					}
					const code =
						args[1] === "-su" ? 0 : (setCodes?.[writeIndex++] ?? setCode);
					if (code === 0) {
						for (let index = 0; index < args.length; ) {
							if (args[index] === ";") {
								index += 1;
								continue;
							}
							index += 1;
							const flag = args[index++];
							const option = args[index++];
							const target = option.includes("-state-") ? "state" : "ack";
							if (flag === "-su") server[target] = undefined;
							else server[target] = args[index++];
						}
					}
					return { code, stdout: "", stderr: "raw-secret" };
				}
				if (args[0] === "list-clients")
					return {
						code: listCode,
						stdout: args.at(-1).includes("pane_id") ? clientPanes : clients,
						stderr: "raw-secret",
					};
				if (args[0] === "display-message")
					return {
						code: displayCode,
						stdout: paneWindow,
						stderr: "raw-secret",
					};
				return {
					code: args.at(-1) === failedRefresh ? 1 : 0,
					stdout: "",
					stderr: "raw-secret",
				};
			},
		},
	};
}

async function initialize(instance, mode = tui) {
	await instance.handlers.get("session_start")({ reason: "startup" }, mode);
	instance.calls.length = 0;
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
		[
			"session_start",
			"session_shutdown",
			"agent_start",
			"message_end",
			"agent_settled",
		],
	);
	assert.deepEqual(lifecycle.calls, [], "factory must not publish pane state");
	await initialize(lifecycle);

	await lifecycle.handlers.get("agent_start")({}, tui);
	assert.equal(lifecycle.calls.length, 5);
	const [
		runningRead,
		runningWrite,
		runningClients,
		firstRefresh,
		secondRefresh,
	] = lifecycle.calls;
	assert.deepEqual(runningRead, ["tmux", "show-options", "-s"]);
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
	assert.equal(lifecycle.calls.length, 6);
	await lifecycle.handlers.get("agent_settled")({}, tui);
	assert.equal(lifecycle.calls.length, 12);
	const [
		alertOwnershipRead,
		alertClients,
		paneWindowQuery,
		completedWrite,
		thirdRefresh,
		fourthRefresh,
	] = lifecycle.calls.slice(6);
	assert.deepEqual(alertOwnershipRead, runningRead);
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
		12,
		"repeating a terminal state must not re-arm it",
	);

	await lifecycle.handlers.get("agent_start")({}, tui);
	const nextRunningWrite = lifecycle.calls.findLast(
		(call) => call[1] === "set-option",
	);
	assert.match(nextRunningWrite[4], /\|running\|-$/);
	assert.deepEqual(nextRunningWrite.slice(5), runningWrite.slice(5));
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
	await initialize(invisible);
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
	await initialize(printMode, { mode: "print" });
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
	await initialize(failedWritePi);
	await failedWritePi.handlers.get("agent_start")({}, tui);
	assert.equal(
		failedWritePi.calls.length,
		2,
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
	await initialize(failedAlertPi);
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
		failedAlertCalls + 6,
		"refresh must happen only after the successful terminal retry",
	);

	const diagnostics = [];
	const originalConsoleError = console.error;
	console.error = (...args) => diagnostics.push(args.join(" "));
	try {
		const readFailure = fakePi({ showCode: 1 });
		extension(readFailure.api);
		await initialize(readFailure);
		await readFailure.handlers.get("agent_start")({}, tui);

		const rejectedRead = fakePi({ rejectOperation: "show-options" });
		extension(rejectedRead.api);
		await initialize(rejectedRead);
		await rejectedRead.handlers.get("agent_start")({}, tui);

		const writeFailure = fakePi({ setCodes: [1] });
		extension(writeFailure.api);
		await initialize(writeFailure);
		await writeFailure.handlers.get("agent_start")({}, tui);

		const clientFailure = fakePi({ listCode: 1 });
		extension(clientFailure.api);
		await clientFailure.handlers.get("session_start")(
			{ reason: "startup" },
			tui,
		);

		const refreshFailure = fakePi({ failedRefresh: "client one" });
		extension(refreshFailure.api);
		await initialize(refreshFailure);
		await refreshFailure.handlers.get("agent_start")({}, tui);

		const partialClear = fakePi({ partialClearAt: 2 });
		extension(partialClear.api);
		await initialize(partialClear);
		await partialClear.handlers.get("agent_start")({}, tui);
		partialClear.server.ack = "persisted-ack";
		partialClear.calls.length = 0;
		await partialClear.handlers.get("session_start")({ reason: "switch" }, tui);
		assert.equal(
			partialClear.server.state,
			undefined,
			"companion state removal persists when acknowledgement removal fails",
		);
		assert.equal(
			partialClear.server.ack,
			"persisted-ack",
			"companion does not roll back partial clear persistence",
		);
		assert.equal(
			partialClear.calls.filter((call) => call[1] === "set-option").length,
			1,
			"companion attempts the ordered clear once",
		);
		assert.deepEqual(
			partialClear.calls.find((call) => call[1] === "set-option").slice(1),
			[
				"set-option",
				"-su",
				"@tmux-agents-status-state-%42",
				";",
				"set-option",
				"-su",
				"@tmux-agents-status-ack-%42",
			],
			"companion clears state before acknowledgement",
		);
		assert.equal(
			partialClear.calls.some((call) => call[1] === "refresh-client"),
			false,
			"companion does not refresh after partial persistence failure",
		);
		await partialClear.handlers.get("session_start")({ reason: "switch" }, tui);
		assert.equal(
			partialClear.calls.filter((call) => call[1] === "set-option").length,
			1,
			"companion does not retry or roll back a partial clear",
		);

		for (const paneFailure of [
			fakePi({ displayCode: 1 }),
			fakePi({ paneWindow: "@7\n@8\n" }),
		]) {
			extension(paneFailure.api);
			await initialize(paneFailure);
			await paneFailure.handlers.get("agent_start")({}, tui);
			await paneFailure.handlers.get("message_end")(assistant("stop"), tui);
			await paneFailure.handlers.get("agent_settled")({}, tui);
			const alertWrite = paneFailure.calls.findLast(
				(call) => call[1] === "set-option" && call[4]?.includes("|completed|"),
			);
			assert.equal(
				alertWrite.length,
				5,
				"failed or malformed pane topology never acknowledges visibility",
			);
		}

		for (const malformedClients of ["secret-client|bad-window\n", "|@7\n"]) {
			const clientOutput = fakePi({ clients: malformedClients });
			extension(clientOutput.api);
			await initialize(clientOutput);
			await clientOutput.handlers.get("agent_start")({}, tui);
			await clientOutput.handlers.get("message_end")(assistant("stop"), tui);
			await clientOutput.handlers.get("agent_settled")({}, tui);
			assert.match(
				clientOutput.server.state,
				/\|completed\|/,
				"state persistence continues after malformed visibility output",
			);
			assert.equal(
				clientOutput.server.ack,
				undefined,
				"malformed client output cannot acknowledge visibility",
			);
			assert.equal(
				clientOutput.calls.some((call) => call[1] === "refresh-client"),
				false,
				"malformed client output cannot choose a refresh target",
			);
		}

		const handlerException = fakePi();
		extension(handlerException.api);
		await initialize(handlerException);
		await handlerException.handlers.get("agent_start")({}, tui);
		await handlerException.handlers.get("message_end")(
			{
				get message() {
					throw new Error("raw-secret handler");
				},
			},
			tui,
		);
	} finally {
		console.error = originalConsoleError;
	}
	assert.deepEqual(diagnostics, [
		"tmux-agents-status: companion: state query failed",
		"tmux-agents-status: companion: state query failed",
		"tmux-agents-status: companion: state write failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: refresh failed",
		"tmux-agents-status: companion: refresh failed",
		"tmux-agents-status: companion: state write failed",
		"tmux-agents-status: companion: pane query failed",
		"tmux-agents-status: companion: pane query failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: client query failed",
		"tmux-agents-status: companion: handler failed",
	]);
	assert.equal(
		diagnostics.some((line) => line.includes("raw-secret")),
		false,
		"companion diagnostics never expose command errors or state",
	);

	const retryStartPi = fakePi();
	extension(retryStartPi.api);
	await initialize(retryStartPi);
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
	await initialize(abandonedAlertPi);
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
