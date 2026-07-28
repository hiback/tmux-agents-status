import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const moduleUrl = new URL("../packages/pi/index.ts", import.meta.url);
const ownershipKey = Symbol.for("tmux-agents-status.pi-process-ownership-v2");

function resetOwnership() {
	delete globalThis[ownershipKey];
}

function fakePi({
	protocol = "2",
	pluginRoot = root,
	coreCode = 0,
	coreCodes,
} = {}) {
	const handlers = new Map();
	const calls = [];
	const invocations = [];
	let coreIndex = 0;
	return {
		handlers,
		calls,
		invocations,
		api: {
			on(name, handler) {
				handlers.set(name, handler);
			},
			async exec(command, args) {
				calls.push([command, ...args]);
				if (command === "tmux") {
					const option = args.at(-1);
					if (option === "@tmux-agents-status-root")
						return { code: 0, stdout: pluginRoot ? `${pluginRoot}\n` : "" };
					if (option === "@tmux-agents-status-protocol")
						return { code: 0, stdout: `${protocol}\n` };
					return { code: 1, stdout: "raw-secret" };
				}
				if (command === `${root}/scripts/state-core`) {
					invocations.push(args);
					return {
						code: coreCodes?.[coreIndex++] ?? coreCode,
						stdout: "raw-secret",
					};
				}
				return { code: 127, stdout: "raw-secret" };
			},
		},
	};
}

const context = (sessionId, mode = "tui") => ({
	mode,
	sessionManager: { getSessionId: () => sessionId },
	isIdle: () => true,
});
const assistant = (stopReason) => ({
	message: { role: "assistant", stopReason },
});

const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
try {
	process.env.TMUX = "/tmp/tmux.sock,1,0";
	process.env.TMUX_PANE = "%42";
	const extension = (await import(moduleUrl.href)).default;

	for (const fixturePath of [
		"test/fixtures/pi/0.81.1/completed.json",
		"test/fixtures/pi/0.81.1/failed.json",
		"test/fixtures/pi/0.82.1/completed.json",
		"test/fixtures/pi/0.82.1/failed.json",
	]) {
		resetOwnership();
		const fixture = JSON.parse(
			await readFile(`${root}/${fixturePath}`, "utf8"),
		);
		const pi = fakePi();
		extension(pi.api);
		assert.deepEqual(
			pi.invocations,
			[],
			`${fixture.version} factory is side-effect free`,
		);
		const tui = context(`session-${fixture.version}`);
		for (const item of fixture.events)
			await pi.handlers.get(item.name)(item.event, tui);
		assert.equal(pi.invocations[0][0], "2");
		assert.equal(pi.invocations[0][1], "claim");
		assert.match(pi.invocations[0][2], /^pi:[0-9a-f-]{36}$/);
		assert.deepEqual(pi.invocations[0].slice(3), [`pid:${process.pid}`]);
		assert.deepEqual(pi.invocations[1].slice(0, 2), ["2", "start"]);
		assert.equal(pi.invocations[1][2], pi.invocations[0][2]);
		assert.match(pi.invocations[1][3], /^turn:[0-9a-f-]{36}$/);
		assert.deepEqual(pi.invocations[2], [
			"2",
			"finish",
			pi.invocations[0][2],
			pi.invocations[1][3],
			fixture.expectedOutcome,
		]);
		assert.equal(
			pi.invocations.some((args) => args.includes("wait-open")),
			false,
			"Pi fixtures never infer generic waiting",
		);
	}

	resetOwnership();
	const retries = fakePi();
	extension(retries.api);
	const retryContext = context("retry-session");
	await retries.handlers.get("session_start")(
		{ reason: "startup" },
		retryContext,
	);
	const child = fakePi();
	extension(child.api);
	const childContext = context("background-child");
	await child.handlers.get("session_start")(
		{ reason: "startup" },
		childContext,
	);
	await child.handlers.get("agent_start")({}, childContext);
	await child.handlers.get("message_end")(assistant("stop"), childContext);
	await child.handlers.get("agent_settled")({}, childContext);
	assert.deepEqual(
		child.calls,
		[],
		"concurrent child sessions never take pane ownership",
	);
	await retries.handlers.get("agent_start")({}, retryContext);
	const turn = retries.invocations.at(-1)[3];
	await retries.handlers.get("message_end")(assistant("error"), retryContext);
	await retries.handlers.get("agent_start")({}, retryContext);
	await retries.handlers.get("message_end")(assistant("stop"), retryContext);
	await retries.handlers.get("agent_settled")({}, retryContext);
	assert.equal(
		retries.invocations.at(-1)[3],
		turn,
		"retries retain one turn identity",
	);
	assert.equal(
		retries.invocations.at(-1)[4],
		"completed",
		"latest settled outcome wins",
	);

	resetOwnership();
	const retryWithoutFinalOutcome = fakePi();
	extension(retryWithoutFinalOutcome.api);
	const retryWithoutOutcomeContext = context("retry-without-outcome");
	await retryWithoutFinalOutcome.handlers.get("session_start")(
		{ reason: "startup" },
		retryWithoutOutcomeContext,
	);
	await retryWithoutFinalOutcome.handlers.get("agent_start")(
		{},
		retryWithoutOutcomeContext,
	);
	await retryWithoutFinalOutcome.handlers.get("message_end")(
		assistant("error"),
		retryWithoutOutcomeContext,
	);
	await retryWithoutFinalOutcome.handlers.get("agent_start")(
		{},
		retryWithoutOutcomeContext,
	);
	await retryWithoutFinalOutcome.handlers.get("agent_settled")(
		{},
		retryWithoutOutcomeContext,
	);
	assert.equal(
		retryWithoutFinalOutcome.invocations.some((args) => args[1] === "finish"),
		false,
		"a retry without a supported final outcome cannot classify an earlier attempt as terminal",
	);
	assert.deepEqual(
		retryWithoutFinalOutcome.invocations.slice(-2).map((args) => args[1]),
		["release", "claim"],
		"unsupported final outcome returns ownership to no-report state",
	);

	for (const [reason, outcome] of [
		["stop", "completed"],
		["toolUse", "completed"],
		["error", "failed"],
		["length", "failed"],
		["aborted", "failed"],
	]) {
		resetOwnership();
		const pi = fakePi();
		extension(pi.api);
		const tui = context(`outcome-${reason}`);
		await pi.handlers.get("session_start")({ reason: "startup" }, tui);
		await pi.handlers.get("agent_start")({}, tui);
		await pi.handlers.get("message_end")(assistant(reason), tui);
		await pi.handlers.get("agent_settled")({}, tui);
		assert.equal(pi.invocations.at(-1)[1], "finish");
		assert.equal(
			pi.invocations.at(-1)[4],
			outcome,
			`${reason} maps only at settlement`,
		);
	}

	resetOwnership();
	const unsupportedOutcome = fakePi();
	extension(unsupportedOutcome.api);
	const unsupportedContext = context("unsupported-outcome");
	await unsupportedOutcome.handlers.get("session_start")(
		{ reason: "startup" },
		unsupportedContext,
	);
	await unsupportedOutcome.handlers.get("agent_start")({}, unsupportedContext);
	await unsupportedOutcome.handlers.get("agent_settled")(
		{},
		unsupportedContext,
	);
	assert.deepEqual(
		unsupportedOutcome.invocations.map((args) => args[1]),
		["claim", "start", "release", "claim"],
		"settlement without a supported outcome clears running without inventing a terminal state",
	);

	resetOwnership();
	const failedNoReportReclaim = fakePi({ coreCodes: [0, 0, 0, 1, 0, 0] });
	extension(failedNoReportReclaim.api);
	const failedNoReportContext = context("failed-no-report-reclaim");
	await failedNoReportReclaim.handlers.get("session_start")(
		{ reason: "startup" },
		failedNoReportContext,
	);
	await failedNoReportReclaim.handlers.get("agent_start")(
		{},
		failedNoReportContext,
	);
	const reclaimDiagnostics = [];
	const originalReclaimError = console.error;
	console.error = (...args) => reclaimDiagnostics.push(args.join(" "));
	try {
		await failedNoReportReclaim.handlers.get("agent_settled")(
			{},
			failedNoReportContext,
		);
	} finally {
		console.error = originalReclaimError;
	}
	await failedNoReportReclaim.handlers.get("agent_start")(
		{},
		failedNoReportContext,
	);
	assert.deepEqual(reclaimDiagnostics, [
		"tmux-agents-status: pi adapter: claim failed",
	]);
	assert.deepEqual(
		failedNoReportReclaim.invocations.map((args) => args[1]),
		["claim", "start", "release", "claim", "claim", "start"],
		"a failed no-report reclaim is retried before the next turn starts",
	);

	resetOwnership();
	const serialized = fakePi();
	extension(serialized.api);
	const serializedContext = context("serialized");
	await serialized.handlers.get("session_start")(
		{ reason: "startup" },
		serializedContext,
	);
	await Promise.all([
		serialized.handlers.get("agent_start")({}, serializedContext),
		serialized.handlers.get("message_end")(
			assistant("stop"),
			serializedContext,
		),
		serialized.handlers.get("agent_settled")({}, serializedContext),
	]);
	assert.deepEqual(
		serialized.invocations.map((args) => args[1]),
		["claim", "start", "finish"],
		"native callbacks are serialized in delivery order",
	);

	resetOwnership();
	const lifecycle = fakePi();
	extension(lifecycle.api);
	const first = context("first");
	await lifecycle.handlers.get("session_start")({ reason: "startup" }, first);
	const firstOwner = lifecycle.invocations[0][2];
	await lifecycle.handlers.get("session_shutdown")({ reason: "reload" }, first);
	const reloadedHandlers = new Map();
	extension({
		...lifecycle.api,
		on: (name, handler) => reloadedHandlers.set(name, handler),
	});
	await reloadedHandlers.get("session_start")({ reason: "reload" }, first);
	assert.equal(
		lifecycle.invocations.length,
		1,
		"reload preserves ownership and state",
	);
	await reloadedHandlers.get("session_shutdown")({ reason: "new" }, first);
	assert.deepEqual(lifecycle.invocations.at(-1), [
		"2",
		"release",
		firstOwner,
		"clear",
	]);
	const second = context("second");
	await reloadedHandlers.get("session_start")({ reason: "new" }, second);
	assert.equal(lifecycle.invocations.at(-1)[1], "claim");
	assert.notEqual(
		lifecycle.invocations.at(-1)[2],
		firstOwner,
		"session replacement rotates ownership",
	);
	await reloadedHandlers.get("agent_start")({}, second);
	const secondOwner = lifecycle.invocations.at(-1)[2];
	await reloadedHandlers.get("session_shutdown")({ reason: "quit" }, second);
	assert.deepEqual(lifecycle.invocations.at(-1), [
		"2",
		"release",
		secondOwner,
		"interrupted",
	]);

	resetOwnership();
	const missingIdentity = fakePi();
	extension(missingIdentity.api);
	await missingIdentity.handlers.get("session_start")(
		{ reason: "startup" },
		{ mode: "tui" },
	);
	await missingIdentity.handlers.get("agent_start")({}, { mode: "tui" });
	assert.deepEqual(
		missingIdentity.calls,
		[],
		"missing native session identity fails closed",
	);

	resetOwnership();
	const nonTui = fakePi();
	extension(nonTui.api);
	const print = context("print", "print");
	await nonTui.handlers.get("session_start")({ reason: "startup" }, print);
	await nonTui.handlers.get("agent_start")({}, print);
	assert.deepEqual(nonTui.calls, [], "non-TUI Pi launches are silent no-ops");

	resetOwnership();
	const malformed = fakePi();
	extension(malformed.api);
	const malformedContext = context("malformed");
	await malformed.handlers.get("session_start")(
		{ reason: "startup" },
		malformedContext,
	);
	await malformed.handlers.get("agent_start")({}, malformedContext);
	const malformedBefore = malformed.invocations.length;
	const malformedDiagnostics = [];
	const originalMalformedError = console.error;
	console.error = (...args) => malformedDiagnostics.push(args.join(" "));
	try {
		await malformed.handlers.get("message_end")(
			{
				get message() {
					throw new Error("raw-secret native content");
				},
			},
			malformedContext,
		);
	} finally {
		console.error = originalMalformedError;
	}
	assert.equal(malformed.invocations.length, malformedBefore);
	assert.equal(
		malformedDiagnostics.some((line) => line.includes("raw-secret")),
		false,
	);

	resetOwnership();
	for (const settings of [
		{ pluginRoot: "" },
		{ protocol: "1" },
		{ coreCode: 1 },
	]) {
		const diagnostics = [];
		const originalError = console.error;
		console.error = (...args) => diagnostics.push(args.join(" "));
		try {
			const pi = fakePi(settings);
			extension(pi.api);
			const tui = context("degraded");
			await pi.handlers.get("session_start")({ reason: "startup" }, tui);
			await pi.handlers.get("agent_start")({}, tui);
			if (!settings.coreCode) assert.deepEqual(pi.invocations, []);
			else
				assert.deepEqual(
					pi.invocations.map((args) => args[1]),
					["claim", "claim"],
					"a failed core claim is retried and never followed by an unowned start",
				);
		} finally {
			console.error = originalError;
		}
		assert.equal(
			diagnostics.some((line) => line.includes("raw-secret")),
			false,
		);
	}

	for (const [tmux, pane] of [
		["", "%42"],
		["server", "42"],
		["server", "%bad"],
	]) {
		resetOwnership();
		process.env.TMUX = tmux;
		process.env.TMUX_PANE = pane;
		const pi = fakePi();
		extension(pi.api);
		assert.deepEqual(
			[...pi.handlers],
			[],
			"unsupported launch context registers nothing",
		);
	}
} finally {
	resetOwnership();
	if (originalTmux === undefined) delete process.env.TMUX;
	else process.env.TMUX = originalTmux;
	if (originalPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalPane;
}

console.log(
	"ok - Pi fixtures translate native lifecycle into normalized v2 events",
);
