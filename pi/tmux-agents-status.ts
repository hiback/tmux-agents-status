type Mode = "tui" | "rpc" | "json" | "print";
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type State = "running" | "completed" | "failed";

interface PiAPI {
	on(
		event: "agent_start" | "message_end" | "agent_settled",
		handler: (event: unknown, ctx: { mode: Mode }) => Promise<void>,
	): void;
	exec(
		command: string,
		args: string[],
	): Promise<{ code: number | null; stdout: string }>;
}

declare const process: { env: Record<string, string | undefined>; pid: number };

export default function (pi: PiAPI) {
	const pane = process.env.TMUX_PANE ?? "";
	if (!process.env.TMUX || !/^%[0-9]+$/.test(pane)) return;

	const incarnation = crypto.randomUUID();
	const stateOption = `@tmux-agents-status-state-${pane}`;
	const ackOption = `@tmux-agents-status-ack-${pane}`;
	let state: State | undefined;
	let outcome: StopReason | undefined;
	let settlementPending = false;

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

	async function publishRunning() {
		if (state === "running") {
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
		await refresh(await clients());
	}

	async function publishAlert(next: Exclude<State, "running">) {
		if (state === next) return;
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
		await refresh(entries);
	}

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			await publishRunning();
		} catch {
			return;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.mode !== "tui" || state !== "running") return;
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
		if (ctx.mode !== "tui" || state !== "running" || !outcome) return;
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
