type Mode = "tui" | "rpc" | "json" | "print";
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
type Context = {
	mode: Mode;
	isIdle?: () => boolean;
	sessionManager?: { getSessionId?: () => string };
};

interface PiAPI {
	on(
		event: "agent_start" | "message_end" | "agent_settled",
		handler: (event: unknown, ctx: Context) => Promise<void>,
	): void;
	on(
		event: "session_start",
		handler: (event: { reason: StartReason }, ctx: Context) => Promise<void>,
	): void;
	on(
		event: "session_shutdown",
		handler: (event: { reason: ShutdownReason }, ctx: Context) => Promise<void>,
	): void;
	exec(
		command: string,
		args: string[],
	): Promise<{ code: number | null; stdout: string }>;
}

interface ProcessOwnership {
	pid: number;
	pane: string;
	owner: string;
	claimed: boolean;
	activeRuntime?: symbol;
	primaryContext?: Context;
	sessionId?: string;
	replacementPending: boolean;
	turn?: string;
	running: boolean;
	outcome?: StopReason;
	settlementPending: boolean;
}

declare const process: {
	env: Record<string, string | undefined>;
	pid: number;
};

const protocolMajor = "2";
const ownershipKey = Symbol.for("tmux-agents-status.pi-process-ownership-v2");
const ownershipStore = globalThis as typeof globalThis & {
	[ownershipKey]?: ProcessOwnership;
};

function newOwner() {
	return `pi:${crypto.randomUUID()}`;
}

function newTurn() {
	return `turn:${crypto.randomUUID()}`;
}

export default function (pi: PiAPI) {
	const pane = process.env.TMUX_PANE ?? "";
	if (!process.env.TMUX || !/^%[0-9]+$/.test(pane)) return;

	const runtime = Symbol();
	const stored = ownershipStore[ownershipKey];
	const ownership =
		stored?.pid === process.pid && stored.pane === pane
			? stored
			: {
					pid: process.pid,
					pane,
					owner: newOwner(),
					claimed: false,
					replacementPending: false,
					running: false,
					settlementPending: false,
				};
	ownershipStore[ownershipKey] = ownership;
	let ended = false;
	let queue = Promise.resolve();

	function diagnose(operation: string) {
		console.error(`tmux-agents-status: pi adapter: ${operation} failed`);
	}

	function enqueue(operation: string, task: () => Promise<void>) {
		queue = queue.then(task, () => task()).catch(() => diagnose(operation));
		return queue;
	}

	async function execute(
		command: string,
		args: string[],
		operation: string,
		diagnoseFailure = true,
	) {
		try {
			const result = await pi.exec(command, args);
			if (result.code === 0) return result.stdout;
		} catch {
			// Diagnostics deliberately exclude command output and native payloads.
		}
		if (diagnoseFailure) diagnose(operation);
		return undefined;
	}

	function oneLine(value: string | undefined) {
		if (value === undefined || value.length > 1025) return;
		const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
		if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return;
		return trimmed;
	}

	async function discoverCore() {
		const root = oneLine(
			await execute(
				"tmux",
				["show-option", "-gqv", "@tmux-agents-status-root"],
				"discovery",
				false,
			),
		);
		if (!root?.startsWith("/")) return;
		const protocol = oneLine(
			await execute(
				"tmux",
				["show-option", "-gqv", "@tmux-agents-status-protocol"],
				"discovery",
				false,
			),
		);
		if (protocol !== protocolMajor) return;
		return `${root.replace(/\/$/, "")}/scripts/state-core`;
	}

	async function invoke(operation: string, ...args: string[]) {
		const core = await discoverCore();
		if (!core) return false;
		const result = await execute(
			core,
			[protocolMajor, operation, ...args],
			operation,
		);
		return result !== undefined;
	}

	function isActive() {
		return !ended && ownershipStore[ownershipKey]?.activeRuntime === runtime;
	}

	function stableSessionId(ctx: Context) {
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			return sessionId || undefined;
		} catch {
			return undefined;
		}
	}

	function isConcurrentSecondary(sessionId: string | undefined) {
		if (
			ownership.replacementPending ||
			!ownership.primaryContext ||
			!ownership.sessionId ||
			!sessionId ||
			ownership.sessionId === sessionId
		)
			return false;
		try {
			if (!ownership.primaryContext.isIdle) return false;
			ownership.primaryContext.isIdle();
			return true;
		} catch {
			return false;
		}
	}

	function resetTurn() {
		ownership.turn = undefined;
		ownership.running = false;
		ownership.outcome = undefined;
		ownership.settlementPending = false;
	}

	async function claim() {
		if (await invoke("claim", ownership.owner, `pid:${process.pid}`))
			ownership.claimed = true;
	}

	pi.on("session_start", (event, ctx) =>
		enqueue("session-start", async () => {
			if (ended || ctx.mode !== "tui") return;
			const sessionId = stableSessionId(ctx);
			if (!sessionId || isConcurrentSecondary(sessionId)) return;
			ownership.activeRuntime = runtime;
			ownership.primaryContext = ctx;
			ownership.sessionId = sessionId;

			if (event.reason === "reload" && ownership.claimed) return;
			if (
				ownership.replacementPending ||
				event.reason === "new" ||
				event.reason === "resume" ||
				event.reason === "fork"
			) {
				ownership.owner = newOwner();
				ownership.claimed = false;
				ownership.replacementPending = false;
				resetTurn();
			}
			if (!ownership.claimed) await claim();
		}),
	);

	pi.on("session_shutdown", (event, ctx) =>
		enqueue("session-shutdown", async () => {
			if (!isActive() || ctx.mode !== "tui") return;
			if (event.reason === "reload") return;
			if (event.reason === "quit") {
				await invoke(
					"release",
					ownership.owner,
					ownership.running ? "interrupted" : "clear",
				);
				ownership.claimed = false;
				resetTurn();
				ended = true;
				if (ownership.activeRuntime === runtime)
					ownership.activeRuntime = undefined;
				return;
			}
			await invoke("release", ownership.owner, "clear");
			ownership.claimed = false;
			ownership.replacementPending = true;
			resetTurn();
		}),
	);

	pi.on("agent_start", (_event, ctx) =>
		enqueue("agent-start", async () => {
			if (!isActive() || ctx.mode !== "tui") return;
			if (!ownership.claimed) await claim();
			if (!ownership.claimed) return;
			if (!ownership.running || ownership.settlementPending) {
				ownership.turn = newTurn();
				ownership.running = true;
				ownership.settlementPending = false;
			}
			// A later low-level run is retry/compaction/continuation evidence. Its
			// eventual outcome, not the preceding attempt's, is the settled result.
			ownership.outcome = undefined;
			await invoke("start", ownership.owner, ownership.turn as string);
		}),
	);

	pi.on("message_end", (event, ctx) =>
		enqueue("message-end", async () => {
			if (!isActive() || ctx.mode !== "tui" || !ownership.running) return;
			if (!event || typeof event !== "object" || !("message" in event)) return;
			const message = event.message;
			if (!message || typeof message !== "object" || !("role" in message))
				return;
			if (message.role !== "assistant" || !("stopReason" in message)) return;
			const reason = message.stopReason;
			if (
				reason === "stop" ||
				reason === "toolUse" ||
				reason === "error" ||
				reason === "length" ||
				reason === "aborted"
			)
				ownership.outcome = reason;
		}),
	);

	pi.on("agent_settled", (_event, ctx) =>
		enqueue("agent-settled", async () => {
			if (!isActive() || ctx.mode !== "tui" || !ownership.running) return;
			ownership.settlementPending = true;
			let persisted: boolean;
			if (ownership.outcome) {
				persisted = await invoke(
					"finish",
					ownership.owner,
					ownership.turn as string,
					ownership.outcome === "stop" || ownership.outcome === "toolUse"
						? "completed"
						: "failed",
				);
			} else {
				const released = await invoke("release", ownership.owner, "clear");
				if (released) ownership.claimed = false;
				persisted =
					released &&
					(await invoke("claim", ownership.owner, `pid:${process.pid}`));
				if (persisted) ownership.claimed = true;
			}
			if (persisted) {
				ownership.running = false;
				ownership.outcome = undefined;
				ownership.settlementPending = false;
			}
		}),
	);
}
