import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const moduleUrl = new URL(
	"../packages/opencode/tmux-agents-status.ts",
	import.meta.url,
);
const ownershipKey = Symbol.for(
	"tmux-agents-status.opencode-process-ownership-v2",
);
const core = `${root}/scripts/state-core`;

function resetOwnership() {
	delete globalThis[ownershipKey];
}

function fakeOpencode({
	protocol = "2",
	pluginRoot = root,
	coreCode = 0,
	coreCodes,
	sessions = {},
	clientFails = false,
} = {}) {
	const calls = [];
	const invocations = [];
	const lookups = [];
	let coreIndex = 0;
	const shell = (strings, command, args) => {
		assert.deepEqual(
			[...strings],
			["", " ", ""],
			"core and tmux commands are interpolated as argv, never as shell text",
		);
		assert.equal(typeof command, "string");
		assert.ok(Array.isArray(args));
		calls.push([command, ...args]);
		let exitCode = 127;
		let stdout = "raw-secret";
		if (command === "tmux") {
			const option = args.at(-1);
			if (option === "@tmux-agents-status-root") {
				exitCode = 0;
				stdout = pluginRoot ? `${pluginRoot}\n` : "";
			} else if (option === "@tmux-agents-status-protocol") {
				exitCode = 0;
				stdout = `${protocol}\n`;
			} else exitCode = 1;
		} else if (command === core) {
			invocations.push(args);
			exitCode = coreCodes?.[coreIndex++] ?? coreCode;
		}
		const result = { exitCode, stdout: Buffer.from(stdout) };
		const promise = {
			then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
			quiet: () => promise,
			nothrow: () => promise,
		};
		return promise;
	};
	return {
		calls,
		invocations,
		lookups,
		input: {
			$: shell,
			directory: "/work",
			worktree: "/work",
			client: {
				session: {
					async get({ path }) {
						lookups.push(path.id);
						if (clientFails) throw new Error("raw-secret lookup failure");
						const info = sessions[path.id];
						if (!info) throw new Error("raw-secret unknown session");
						return { data: info };
					},
				},
			},
		},
	};
}

function shape(args) {
	const [, operation, , ...rest] = args;
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
const rootSession = (id) => ({
	type: "session.created",
	properties: { info: { id } },
});
const status = (sessionID, type) => ({
	type: "session.status",
	properties: { sessionID, status: { type } },
});

const originalTmux = process.env.TMUX;
const originalPane = process.env.TMUX_PANE;
try {
	process.env.TMUX = "/tmp/tmux.sock,1,0";
	process.env.TMUX_PANE = "%42";
	const exports = await import(moduleUrl.href);
	assert.deepEqual(
		Object.keys(exports),
		["TmuxAgentsStatusPlugin"],
		"the module exports exactly one plugin so OpenCode registers it once",
	);
	const plugin = exports.TmuxAgentsStatusPlugin;

	const load = async (settings) => {
		resetOwnership();
		const opencode = fakeOpencode(settings);
		const hooks = await plugin(opencode.input);
		const send = async (event) => await hooks.event({ event });
		return { ...opencode, hooks, send };
	};

	for (const fixturePath of [
		"test/fixtures/opencode/1.15.11/completed.json",
		"test/fixtures/opencode/1.15.11/failed.json",
		"test/fixtures/opencode/1.15.11/waiting.json",
		"test/fixtures/opencode/1.18.5/completed.json",
		"test/fixtures/opencode/1.18.5/failed.json",
		"test/fixtures/opencode/1.18.5/waiting.json",
	]) {
		const fixture = JSON.parse(await readFile(`${root}/${fixturePath}`, "utf8"));
		const opencode = await load();
		assert.deepEqual(
			opencode.invocations,
			[],
			`${fixture.version} plugin construction publishes no lifecycle state`,
		);
		for (const event of fixture.events) await opencode.send(event);
		assert.deepEqual(
			shapes(opencode.invocations),
			fixture.expected,
			`${fixturePath} translates native events into the expected normalized sequence`,
		);
		const [claim, start] = opencode.invocations;
		assert.equal(claim[0], "2");
		assert.match(claim[2], /^opencode:[0-9a-f-]{36}$/);
		assert.deepEqual(claim.slice(3), [`pid:${process.pid}`]);
		assert.match(start[3], /^turn:[0-9a-f-]{36}$/);
		for (const args of opencode.invocations) {
			assert.equal(args[0], "2", "every invocation declares protocol major 2");
			assert.equal(args[2], claim[2], "one owner token identifies the pane");
			assert.notEqual(
				args[1],
				"dismiss-terminal",
				"exact terminal mappings never dismiss a terminal outcome",
			);
			if (args[1] !== "claim")
				assert.equal(args[3], start[3], "events correlate to the started turn");
			assert.equal(
				args.some((value) => String(value).includes("raw-secret")),
				false,
				"native payload content never reaches the core",
			);
		}
	}

	// Child sessions and their background work never take pane ownership.
	const child = await load();
	await child.send(rootSession("ses_parent"));
	await child.send({
		type: "session.created",
		properties: { info: { id: "ses_child", parentID: "ses_parent" } },
	});
	await child.send(status("ses_child", "busy"));
	await child.send({
		type: "permission.asked",
		properties: { id: "per_child", sessionID: "ses_child", permission: "bash" },
	});
	await child.send({
		type: "session.error",
		properties: { sessionID: "ses_child", error: { name: "UnknownError" } },
	});
	await child.send(status("ses_child", "idle"));
	assert.deepEqual(
		shapes(child.invocations),
		["claim"],
		"child-session lifecycle never publishes state",
	);

	// Selecting an already idle root session stays unobservable.
	const idleSelection = await load();
	await idleSelection.send(rootSession("ses_other"));
	await idleSelection.send(status("ses_other", "idle"));
	await idleSelection.send({
		type: "session.updated",
		properties: { info: { id: "ses_other", title: "raw-secret" } },
	});
	assert.deepEqual(
		shapes(idleSelection.invocations),
		["claim"],
		"an already idle root session invents no state",
	);

	// Duplicate and replayed native events are idempotent.
	const duplicates = await load();
	await duplicates.send(rootSession("ses_dup"));
	await duplicates.send(status("ses_dup", "busy"));
	await duplicates.send(status("ses_dup", "busy"));
	await duplicates.send({
		type: "permission.asked",
		properties: { id: "per_dup", sessionID: "ses_dup" },
	});
	await duplicates.send({
		type: "permission.asked",
		properties: { id: "per_dup", sessionID: "ses_dup" },
	});
	await duplicates.send(status("ses_dup", "busy"));
	await duplicates.send({
		type: "permission.replied",
		properties: { sessionID: "ses_dup", requestID: "per_dup", reply: "always" },
	});
	await duplicates.send({
		type: "permission.replied",
		properties: { sessionID: "ses_dup", requestID: "per_dup", reply: "always" },
	});
	await duplicates.send(status("ses_dup", "idle"));
	await duplicates.send(status("ses_dup", "idle"));
	assert.deepEqual(
		shapes(duplicates.invocations),
		[
			"claim",
			"start",
			"wait-open:per_dup",
			"wait-close:per_dup",
			"finish:completed",
		],
		"repeated busy, request, reply, and idle events are idempotent and never restart a pending wait",
	);

	// Several pending requests share one waiting episode.
	const pending = await load();
	await pending.send(rootSession("ses_multi"));
	await pending.send(status("ses_multi", "busy"));
	await pending.send({
		type: "permission.asked",
		properties: { id: "per_one", sessionID: "ses_multi" },
	});
	await pending.send({
		type: "question.asked",
		properties: { id: "qst_one", sessionID: "ses_multi" },
	});
	await pending.send({
		type: "question.replied",
		properties: { sessionID: "ses_multi", requestID: "qst_one", answers: [] },
	});
	await pending.send({
		type: "permission.replied",
		properties: { sessionID: "ses_multi", requestID: "per_one", reply: "once" },
	});
	assert.deepEqual(
		shapes(pending.invocations),
		[
			"claim",
			"start",
			"wait-open:per_one",
			"wait-open:qst_one",
			"wait-close:qst_one",
			"wait-close:per_one",
		],
		"each correlated request opens and closes exactly once without restarting the turn",
	);

	// Stale and uncorrelatable native deliveries are ignored.
	const stale = await load();
	await stale.send(rootSession("ses_live"));
	await stale.send(status("ses_live", "busy"));
	const liveTurn = stale.invocations.at(-1)[3];
	await stale.send(rootSession("ses_stale"));
	await stale.send(status("ses_stale", "idle"));
	await stale.send({
		type: "session.error",
		properties: { sessionID: "ses_stale", error: { name: "UnknownError" } },
	});
	await stale.send({
		type: "permission.replied",
		properties: { sessionID: "ses_live", requestID: "per_unknown", reply: "once" },
	});
	await stale.send({
		type: "question.rejected",
		properties: { sessionID: "ses_live", requestID: "qst_unknown" },
	});
	await stale.send({
		type: "message.updated",
		properties: {
			info: {
				id: "msg_x",
				sessionID: "ses_stale",
				role: "assistant",
				error: { name: "UnknownError" },
			},
		},
	});
	await stale.send(status("ses_live", "idle"));
	assert.deepEqual(
		shapes(stale.invocations),
		["claim", "start", "finish:completed"],
		"another session's error and unknown request replies cannot change the tracked turn",
	);
	assert.equal(stale.invocations.at(-1)[3], liveTurn);

	// A different root session replaces pane ownership when it starts work.
	const replacement = await load();
	await replacement.send(rootSession("ses_first"));
	await replacement.send(status("ses_first", "busy"));
	await replacement.send(status("ses_first", "idle"));
	const firstOwner = replacement.invocations[0][2];
	await replacement.send(rootSession("ses_second"));
	await replacement.send(status("ses_second", "busy"));
	assert.deepEqual(
		shapes(replacement.invocations),
		["claim", "start", "finish:completed", "claim", "start"],
		"a new root session claims the pane instead of reusing stale ownership",
	);
	assert.notEqual(
		replacement.invocations.at(-1)[2],
		firstOwner,
		"root-session replacement rotates the owner token",
	);
	assert.notEqual(
		replacement.invocations.at(-1)[3],
		replacement.invocations[1][3],
		"a replacing root session starts a new turn",
	);

	// Unknown sessions are resolved through native session data, never guessed.
	const resumedRoot = await load({
		sessions: { ses_resumed: { id: "ses_resumed", directory: "/work" } },
	});
	await resumedRoot.send(status("ses_resumed", "busy"));
	assert.deepEqual(resumedRoot.lookups, ["ses_resumed"]);
	await resumedRoot.send(status("ses_resumed", "busy"));
	assert.deepEqual(
		resumedRoot.lookups,
		["ses_resumed"],
		"a resolved session identity is reused instead of queried repeatedly",
	);
	assert.deepEqual(shapes(resumedRoot.invocations), ["claim", "start"]);

	const resumedChild = await load({
		sessions: {
			ses_background: { id: "ses_background", parentID: "ses_resumed" },
		},
	});
	await resumedChild.send(status("ses_background", "busy"));
	await resumedChild.send(status("ses_background", "idle"));
	assert.deepEqual(
		shapes(resumedChild.invocations),
		["claim"],
		"a resolved child session stays excluded from pane ownership",
	);

	const unresolvable = await load({ clientFails: true });
	await unresolvable.send(status("ses_unknown", "busy"));
	await unresolvable.send(status("ses_unknown", "idle"));
	assert.deepEqual(
		shapes(unresolvable.invocations),
		["claim"],
		"an unresolvable session identity fails closed",
	);

	// Terminal classification uses typed failure and cancellation evidence only.
	for (const [name, evidence, outcome] of [
		["no evidence", [], "completed"],
		[
			"session error",
			[
				{
					type: "session.error",
					properties: {
						sessionID: "ses_class",
						error: { name: "ProviderAuthError" },
					},
				},
			],
			"failed",
		],
		[
			"assistant message error",
			[
				{
					type: "message.updated",
					properties: {
						info: {
							id: "msg_class",
							sessionID: "ses_class",
							role: "assistant",
							error: { name: "StructuredOutputError" },
						},
					},
				},
			],
			"failed",
		],
		[
			"aborted message",
			[
				{
					type: "message.updated",
					properties: {
						info: {
							id: "msg_class",
							sessionID: "ses_class",
							role: "assistant",
							error: { name: "MessageAbortedError" },
						},
					},
				},
			],
			"failed",
		],
		[
			"successful assistant message",
			[
				{
					type: "message.updated",
					properties: {
						info: {
							id: "msg_class",
							sessionID: "ses_class",
							role: "assistant",
							finish: "stop",
							time: { created: 1, completed: 2 },
						},
					},
				},
			],
			"completed",
		],
		[
			"user message",
			[
				{
					type: "message.updated",
					properties: {
						info: {
							id: "msg_class",
							sessionID: "ses_class",
							role: "user",
							error: { name: "UnknownError" },
						},
					},
				},
			],
			"completed",
		],
	]) {
		const classified = await load();
		await classified.send(rootSession("ses_class"));
		await classified.send(status("ses_class", "busy"));
		for (const event of evidence) await classified.send(event);
		await classified.send(status("ses_class", "idle"));
		assert.deepEqual(
			shapes(classified.invocations),
			["claim", "start", `finish:${outcome}`],
			`${name} settles as ${outcome}`,
		);
	}

	// Rejected requests are user cancellation for the turn that ends after them.
	for (const rejection of [
		{
			type: "permission.replied",
			properties: {
				sessionID: "ses_reject",
				requestID: "req_reject",
				reply: "reject",
			},
		},
		{
			type: "question.rejected",
			properties: { sessionID: "ses_reject", requestID: "req_reject" },
		},
	]) {
		const rejected = await load();
		await rejected.send(rootSession("ses_reject"));
		await rejected.send(status("ses_reject", "busy"));
		await rejected.send({
			type: "permission.asked",
			properties: { id: "req_reject", sessionID: "ses_reject" },
		});
		await rejected.send(rejection);
		await rejected.send(status("ses_reject", "idle"));
		assert.deepEqual(shapes(rejected.invocations).at(-1), "finish:failed");
	}

	// A turn that demonstrably continues past a rejected request settles normally.
	const continuedAfterRejection = await load();
	await continuedAfterRejection.send(rootSession("ses_continue"));
	await continuedAfterRejection.send(status("ses_continue", "busy"));
	await continuedAfterRejection.send({
		type: "permission.asked",
		properties: { id: "per_continue", sessionID: "ses_continue" },
	});
	await continuedAfterRejection.send({
		type: "permission.replied",
		properties: {
			sessionID: "ses_continue",
			requestID: "per_continue",
			reply: "reject",
		},
	});
	await continuedAfterRejection.send({
		type: "message.updated",
		properties: {
			info: {
				id: "msg_continue",
				sessionID: "ses_continue",
				role: "assistant",
				finish: "stop",
				time: { created: 1, completed: 2 },
			},
		},
	});
	await continuedAfterRejection.send(status("ses_continue", "idle"));
	assert.deepEqual(
		shapes(continuedAfterRejection.invocations).at(-1),
		"finish:completed",
		"a normally settled assistant message proves the turn survived a rejection",
	);

	// Typed error evidence stays final even when a later message settles.
	const settledAfterError = await load();
	await settledAfterError.send(rootSession("ses_error"));
	await settledAfterError.send(status("ses_error", "busy"));
	await settledAfterError.send({
		type: "session.error",
		properties: { sessionID: "ses_error", error: { name: "UnknownError" } },
	});
	await settledAfterError.send({
		type: "message.updated",
		properties: {
			info: {
				id: "msg_error",
				sessionID: "ses_error",
				role: "assistant",
				finish: "stop",
				time: { created: 1, completed: 2 },
			},
		},
	});
	await settledAfterError.send(status("ses_error", "idle"));
	assert.deepEqual(
		shapes(settledAfterError.invocations).at(-1),
		"finish:failed",
		"typed error evidence is final for its turn",
	);

	// A failure classification never leaks into the next turn.
	const nextTurn = await load();
	await nextTurn.send(rootSession("ses_next"));
	await nextTurn.send(status("ses_next", "busy"));
	await nextTurn.send({
		type: "session.error",
		properties: { sessionID: "ses_next", error: { name: "UnknownError" } },
	});
	await nextTurn.send(status("ses_next", "idle"));
	await nextTurn.send(status("ses_next", "busy"));
	await nextTurn.send(status("ses_next", "idle"));
	assert.deepEqual(
		shapes(nextTurn.invocations),
		["claim", "start", "finish:failed", "start", "finish:completed"],
		"terminal evidence applies only to the turn that produced it",
	);
	assert.notEqual(
		nextTurn.invocations.at(-1)[3],
		nextTurn.invocations[1][3],
		"each busy edge after settlement starts a new turn",
	);

	// Native callbacks are handled in delivery order even when overlapped.
	const serialized = await load();
	await Promise.all([
		serialized.send(rootSession("ses_order")),
		serialized.send(status("ses_order", "busy")),
		serialized.send({
			type: "permission.asked",
			properties: { id: "per_order", sessionID: "ses_order" },
		}),
		serialized.send({
			type: "permission.replied",
			properties: {
				sessionID: "ses_order",
				requestID: "per_order",
				reply: "once",
			},
		}),
		serialized.send(status("ses_order", "idle")),
	]);
	assert.deepEqual(
		shapes(serialized.invocations),
		[
			"claim",
			"start",
			"wait-open:per_order",
			"wait-close:per_order",
			"finish:completed",
		],
		"overlapping native callbacks preserve native order",
	);

	// Awaited disposal releases ownership and ends further reporting.
	const interrupted = await load();
	await interrupted.send(rootSession("ses_dispose"));
	await interrupted.send(status("ses_dispose", "busy"));
	await interrupted.hooks.dispose();
	assert.deepEqual(
		shapes(interrupted.invocations),
		["claim", "start", "release:interrupted"],
		"disposal during active work reports interruption",
	);
	await interrupted.send(status("ses_dispose", "idle"));
	await interrupted.hooks.dispose();
	assert.equal(
		interrupted.invocations.length,
		3,
		"events and repeated disposal after release are no-ops",
	);

	const releasedIdle = await load();
	await releasedIdle.send(rootSession("ses_idle"));
	await releasedIdle.send(status("ses_idle", "busy"));
	await releasedIdle.send(status("ses_idle", "idle"));
	await releasedIdle.hooks.dispose();
	assert.deepEqual(
		shapes(releasedIdle.invocations).at(-1),
		"release:clear",
		"disposal after a settled turn releases without classification",
	);

	const disposedWaiting = await load();
	await disposedWaiting.send(rootSession("ses_wait_dispose"));
	await disposedWaiting.send(status("ses_wait_dispose", "busy"));
	await disposedWaiting.send({
		type: "permission.asked",
		properties: { id: "per_dispose", sessionID: "ses_wait_dispose" },
	});
	await disposedWaiting.hooks.dispose();
	assert.deepEqual(
		shapes(disposedWaiting.invocations).at(-1),
		"release:interrupted",
		"disposal while waiting for the user reports interruption",
	);

	// A replacing plugin instance in the same process owns the pane.
	resetOwnership();
	const firstInstance = fakeOpencode();
	const firstHooks = await plugin(firstInstance.input);
	await firstHooks.event({ event: rootSession("ses_a") });
	const secondInstance = fakeOpencode();
	const secondHooks = await plugin(secondInstance.input);
	await secondHooks.event({ event: rootSession("ses_b") });
	await secondHooks.event({ event: status("ses_b", "busy") });
	await firstHooks.event({ event: status("ses_a", "busy") });
	await firstHooks.dispose();
	assert.deepEqual(
		shapes(firstInstance.invocations),
		["claim"],
		"a superseded plugin instance stops reporting and never releases current ownership",
	);
	assert.deepEqual(shapes(secondInstance.invocations), ["claim", "start"]);
	assert.notEqual(
		secondInstance.invocations[0][2],
		firstInstance.invocations[0][2],
		"a replacing instance claims with its own owner token",
	);

	// Malformed native payloads cannot mutate state or leak content.
	const malformed = await load();
	await malformed.send(rootSession("ses_malformed"));
	await malformed.send(status("ses_malformed", "busy"));
	const before = malformed.invocations.length;
	const diagnostics = [];
	const originalError = console.error;
	console.error = (...args) => diagnostics.push(args.join(" "));
	try {
		for (const event of [
			undefined,
			null,
			"raw-secret",
			{},
			{ type: 42 },
			{ type: "session.status", properties: null },
			{ type: "session.status", properties: { sessionID: "ses_malformed" } },
			{
				type: "session.status",
				properties: { sessionID: 7, status: { type: "busy" } },
			},
			{
				type: "session.status",
				properties: {
					sessionID: "session with spaces",
					status: { type: "busy" },
				},
			},
			{
				type: "permission.asked",
				properties: { id: "per invalid", sessionID: "ses_malformed" },
			},
			{
				type: "permission.asked",
				properties: { sessionID: "ses_malformed" },
			},
			{
				type: "message.updated",
				properties: {
					get info() {
						throw new Error("raw-secret native content");
					},
				},
			},
			{
				type: "session.created",
				properties: { info: { id: "ses_malformed", parentID: 3 } },
			},
		])
			await malformed.send(event);
		await malformed.send(status("ses_malformed", "idle"));
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(
		shapes(malformed.invocations.slice(before)),
		["finish:completed"],
		"malformed native payloads neither publish nor corrupt lifecycle state",
	);
	assert.equal(
		diagnostics.some((line) => line.includes("raw-secret")),
		false,
		"diagnostics never contain native payload content",
	);

	// A missing, incompatible, or failing core cannot break OpenCode.
	for (const settings of [
		{ pluginRoot: "" },
		{ protocol: "1" },
		{ coreCode: 1 },
	]) {
		const degraded = [];
		const originalDegradedError = console.error;
		console.error = (...args) => degraded.push(args.join(" "));
		try {
			const opencode = await load(settings);
			await opencode.send(rootSession("ses_degraded"));
			await opencode.send(status("ses_degraded", "busy"));
			await opencode.send({
				type: "permission.asked",
				properties: { id: "per_degraded", sessionID: "ses_degraded" },
			});
			await opencode.send(status("ses_degraded", "idle"));
			await opencode.hooks.dispose();
			if (settings.coreCode)
				assert.deepEqual(
					shapes(opencode.invocations),
					["claim", "claim"],
					"a failed claim is retried and never followed by an unowned event",
				);
			else
				assert.deepEqual(
					opencode.invocations,
					[],
					"a missing or incompatible core is a silent no-op",
				);
		} finally {
			console.error = originalDegradedError;
		}
		assert.equal(
			degraded.some((line) => line.includes("raw-secret")),
			false,
			"degraded operation exposes no command output",
		);
		assert.equal(
			degraded.every((line) =>
				/^tmux-agents-status: opencode adapter: [a-z-]+ failed$/.test(line),
			),
			true,
			`diagnostics name only a bounded operation (got ${JSON.stringify(degraded)})`,
		);
	}

	// Unsupported launch contexts register nothing.
	for (const [tmux, pane] of [
		["", "%42"],
		["server", "42"],
		["server", "%bad"],
	]) {
		resetOwnership();
		process.env.TMUX = tmux;
		process.env.TMUX_PANE = pane;
		const opencode = fakeOpencode();
		const hooks = await plugin(opencode.input);
		await hooks.event?.({ event: rootSession("ses_outside") });
		await hooks.event?.({ event: status("ses_outside", "busy") });
		await hooks.dispose?.();
		assert.deepEqual(
			opencode.calls,
			[],
			"OpenCode outside a tmux pane is a silent no-op",
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
	"ok - OpenCode fixtures translate native lifecycle into normalized v2 events",
);
