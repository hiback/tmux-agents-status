type Mode = "tui" | "rpc" | "json" | "print";
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type State = "running" | "waiting" | "completed" | "failed";
type StartReason = "startup" | "reload" | "new" | "resume" | "fork";
type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
type Context = { mode: Mode };

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
	activeRuntime: symbol;
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
					activeRuntime: runtime,
				};
	ownership.activeRuntime = runtime;
	ownershipStore[ownershipKey] = ownership;
	const incarnation = ownership.incarnation;
	const stateOption = `@tmux-agents-status-state-${pane}`;
	const ackOption = `@tmux-agents-status-ack-${pane}`;
	let state: State | undefined;
	let outcome: StopReason | undefined;
	let settlementPending = false;
	let canCreate = false;

	function isActive() {
		return ownershipStore[ownershipKey]?.activeRuntime === runtime;
	}

	async function clients() {
		const result = await pi.exec("tmux", [
			"list-clients",
			"-F",
			"#{client_name}|#{window_id}",
		]);
		if (result.code !== 0) return;
		const lines = result.stdout.trimEnd();
		if (!lines) return [];
		return lines.split("\n").map((line) => {
			const separator = line.lastIndexOf("|");
			return {
				name: line.slice(0, separator),
				window: line.slice(separator + 1),
			};
		});
	}

	async function paneWindow() {
		const result = await pi.exec("tmux", [
			"display-message",
			"-p",
			"-t",
			pane,
			"#{window_id}",
		]);
		if (result.code !== 0) return;
		const window = result.stdout.trimEnd();
		return /^@[0-9]+$/.test(window) ? window : undefined;
	}

	async function refresh(entries: { name: string }[] | undefined) {
		if (!entries) return;
		await Promise.all(
			entries.map(({ name }) =>
				pi
					.exec("tmux", ["refresh-client", "-S", "-t", name])
					.catch(() => undefined),
			),
		);
	}

	async function currentRecord(): Promise<CurrentRecord> {
		const result = await pi.exec("tmux", ["show-options", "-s"]);
		if (result.code !== 0) return { kind: "invalid" };
		const prefix = `${stateOption} `;
		const records = result.stdout
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
		const write = await pi.exec("tmux", [
			"set-option",
			"-su",
			stateOption,
			";",
			"set-option",
			"-su",
			ackOption,
		]);
		if (write.code !== 0) return false;
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
		const write = await pi.exec("tmux", [
			"set-option",
			"-s",
			stateOption,
			`v1|${process.pid}|${incarnation}|running|-`,
			";",
			"set-option",
			"-su",
			ackOption,
		]);
		if (write.code !== 0) return;
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
		const write = await pi.exec("tmux", args);
		if (write.code !== 0) return;
		state = next;
		settlementPending = false;
		ownership.claimed = true;
		await refresh(entries);
	}

	pi.on("session_start", async (event, ctx) => {
		if (!isActive() || ctx.mode !== "tui") return;
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
			return;
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!isActive() || ctx.mode !== "tui" || event.reason === "reload") return;
		try {
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
			return;
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!isActive() || ctx.mode !== "tui") return;
		try {
			await publishRunning();
		} catch {
			return;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isActive() || ctx.mode !== "tui" || state !== "running") return;
		if (!event || typeof event !== "object" || !("message" in event)) return;
		const message = event.message;
		if (!message || typeof message !== "object" || !("role" in message)) return;
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
			return;
		}
	});
}
