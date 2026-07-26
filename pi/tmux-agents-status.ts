type Mode = "tui" | "rpc" | "json" | "print";
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type State = "running" | "waiting" | "completed" | "failed";
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
	incarnation: string;
	claimed: boolean;
	activeRuntime?: symbol;
	primaryContext?: Context;
	sessionId?: string;
}

interface RecordState {
	incarnation: string;
	state: State;
	generation: string;
}

type CurrentRecord =
	| { kind: "absent" }
	| { kind: "invalid" }
	| ({ kind: "record" } & RecordState);

declare const process: { env: Record<string, string | undefined>; pid: number };

const ownershipKey = Symbol.for("tmux-agents-status.process-ownership");
const ownershipStore = globalThis as typeof globalThis & {
	[ownershipKey]?: ProcessOwnership;
};
const recordPattern =
	/^v1\|[1-9][0-9]*\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\|(running\|-|(waiting|completed|failed)\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export default function (pi: PiAPI) {
	const pane = process.env.TMUX_PANE ?? "";
	if (!process.env.TMUX || !/^%[0-9]+$/.test(pane)) return;

	const runtime = Symbol();
	const storedOwnership = ownershipStore[ownershipKey];
	const ownership =
		storedOwnership?.pid === process.pid && storedOwnership.pane === pane
			? storedOwnership
			: {
					pid: process.pid,
					pane,
					incarnation: crypto.randomUUID(),
					claimed: false,
				};
	ownershipStore[ownershipKey] = ownership;
	const incarnation = ownership.incarnation;
	const stateOption = `@tmux-agents-status-state-${pane}`;
	const ackOption = `@tmux-agents-status-ack-${pane}`;
	let state: State | undefined;
	let outcome: StopReason | undefined;
	let settlementPending = false;
	let canCreate = false;
	let ended = false;

	function diagnose(operation: string) {
		console.error(`tmux-agents-status: companion: ${operation} failed`);
	}

	async function tmux(args: string[], operation: string) {
		try {
			const result = await pi.exec("tmux", args);
			if (result.code === 0) return result.stdout;
		} catch {
			diagnose(operation);
			return;
		}
		diagnose(operation);
	}

	function isActive() {
		return ownershipStore[ownershipKey]?.activeRuntime === runtime;
	}

	function stableSessionId(ctx: Context) {
		try {
			const sessionId = ctx.sessionManager?.getSessionId?.();
			return sessionId || undefined;
		} catch {
			return;
		}
	}

	function isConcurrentSecondary(ctx: Context, sessionId: string | undefined) {
		if (
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

	async function clients() {
		const stdout = await tmux(
			["list-clients", "-F", "#{client_name}|#{window_id}"],
			"client query",
		);
		if (stdout === undefined) return;
		if (!stdout) return [];
		const lines = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
		if (!lines) {
			diagnose("client query");
			return;
		}
		const entries = [];
		for (const line of lines.split("\n")) {
			const separator = line.lastIndexOf("|");
			const name = line.slice(0, separator);
			const window = line.slice(separator + 1);
			if (separator < 1 || !/^@[0-9]+$/.test(window)) {
				diagnose("client query");
				return;
			}
			entries.push({ name, window });
		}
		return entries;
	}

	async function paneWindow() {
		const stdout = await tmux(
			["display-message", "-p", "-t", pane, "#{window_id}"],
			"pane query",
		);
		if (stdout === undefined) return;
		const window = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
		if (/^@[0-9]+$/.test(window)) return window;
		diagnose("pane query");
	}

	async function refresh(entries: { name: string }[] | undefined) {
		if (!entries) return;
		await Promise.all(
			entries.map(({ name }) =>
				tmux(["refresh-client", "-S", "-t", name], "refresh"),
			),
		);
	}

	async function currentRecord(): Promise<CurrentRecord> {
		const stdout = await tmux(["show-options", "-s"], "state query");
		if (stdout === undefined) return { kind: "invalid" };
		const prefix = `${stateOption} `;
		const records = stdout
			.split("\n")
			.filter((line) => line.startsWith(prefix));
		if (records.length === 0) return { kind: "absent" };
		if (records.length !== 1) return { kind: "invalid" };
		const value = records[0].slice(prefix.length);
		const match = recordPattern.exec(value);
		if (!match) return { kind: "invalid" };
		const fields = value.split("|");
		return {
			kind: "record",
			incarnation: match[1],
			state: fields[3] as State,
			generation: fields[4],
		};
	}

	function loseOwnership() {
		state = undefined;
		outcome = undefined;
		settlementPending = false;
		canCreate = false;
	}

	async function ownedRecord() {
		const current = await currentRecord();
		if (current.kind !== "record" || current.incarnation !== incarnation) {
			loseOwnership();
			return;
		}
		return current;
	}

	async function clearOptions(requireOwnership: boolean) {
		if (requireOwnership && !(await ownedRecord())) return false;
		const write = await tmux(
			["set-option", "-su", stateOption, ";", "set-option", "-su", ackOption],
			"state write",
		);
		if (write === undefined) return false;
		state = undefined;
		outcome = undefined;
		settlementPending = false;
		canCreate = false;
		ownership.claimed = false;
		await refresh(await clients());
		return true;
	}

	async function publishRunning() {
		const current = await currentRecord();
		if (current.kind === "absent" && !canCreate) {
			loseOwnership();
			return;
		}
		if (
			current.kind !== "absent" &&
			(current.kind !== "record" || current.incarnation !== incarnation)
		) {
			loseOwnership();
			return;
		}
		if (current.kind === "record" && current.state === "running") {
			state = "running";
			if (settlementPending) {
				outcome = undefined;
				settlementPending = false;
			}
			return;
		}
		const write = await tmux(
			[
				"set-option",
				"-s",
				stateOption,
				`v1|${process.pid}|${incarnation}|running|-`,
				";",
				"set-option",
				"-su",
				ackOption,
			],
			"state write",
		);
		if (write === undefined) return;
		state = "running";
		outcome = undefined;
		settlementPending = false;
		canCreate = false;
		ownership.claimed = true;
		await refresh(await clients());
	}

	async function publishAlert(next: Exclude<State, "running">) {
		const current = await ownedRecord();
		if (!current || current.state === next) return;
		const generation = crypto.randomUUID();
		const entries = await clients();
		const window = await paneWindow();
		const args = [
			"set-option",
			"-s",
			stateOption,
			`v1|${process.pid}|${incarnation}|${next}|${generation}`,
		];
		if (window && entries?.some((client) => client.window === window)) {
			args.push(";", "set-option", "-s", ackOption, generation);
		}
		const write = await tmux(args, "state write");
		if (write === undefined) return;
		state = next;
		settlementPending = false;
		ownership.claimed = true;
		await refresh(entries);
	}

	pi.on("session_start", async (event, ctx) => {
		if (ended || ctx.mode !== "tui") return;
		const sessionId = stableSessionId(ctx);
		if (isConcurrentSecondary(ctx, sessionId)) return;
		ownership.activeRuntime = runtime;
		ownership.primaryContext = ctx;
		ownership.sessionId = sessionId;
		try {
			if (event.reason === "startup") {
				if (await clearOptions(false)) canCreate = true;
				return;
			}
			const current = await currentRecord();
			if (event.reason === "reload") {
				if (current.kind === "record" && current.incarnation === incarnation) {
					state = current.state;
					canCreate = false;
					ownership.claimed = true;
				} else if (current.kind === "absent" && !ownership.claimed) {
					state = undefined;
					canCreate = true;
				} else loseOwnership();
				return;
			}
			if (current.kind === "record" && current.incarnation === incarnation) {
				if (await clearOptions(true)) canCreate = true;
			} else if (current.kind === "absent" && !ownership.claimed) {
				state = undefined;
				canCreate = true;
			} else loseOwnership();
		} catch {
			diagnose("handler");
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!isActive() || ctx.mode !== "tui") return;
		try {
			if (event.reason === "reload") return;
			if (event.reason !== "quit") {
				await clearOptions(true);
				return;
			}
			const current = await ownedRecord();
			if (!current) return;
			if (current.state === "running" || current.state === "waiting") {
				await publishAlert("failed");
			} else await clearOptions(true);
		} catch {
			diagnose("handler");
		} finally {
			ended = true;
			if (isActive()) ownership.activeRuntime = undefined;
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!isActive() || ctx.mode !== "tui") return;
		try {
			await publishRunning();
		} catch {
			diagnose("handler");
		}
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			if (!isActive() || ctx.mode !== "tui" || state !== "running") return;
			if (!event || typeof event !== "object" || !("message" in event)) return;
			const message = event.message;
			if (!message || typeof message !== "object" || !("role" in message))
				return;
			if (message.role !== "assistant" || !("stopReason" in message)) return;
			if (
				message.stopReason === "stop" ||
				message.stopReason === "toolUse" ||
				message.stopReason === "error" ||
				message.stopReason === "length" ||
				message.stopReason === "aborted"
			) {
				outcome = message.stopReason;
			}
		} catch {
			diagnose("handler");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!isActive() || ctx.mode !== "tui" || state !== "running" || !outcome)
			return;
		settlementPending = true;
		try {
			await publishAlert(
				outcome === "stop" || outcome === "toolUse" ? "completed" : "failed",
			);
		} catch {
			diagnose("handler");
		}
	});
}
