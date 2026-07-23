interface PiAPI {
	on(
		event: "agent_start",
		handler: (
			event: unknown,
			ctx: { mode: "tui" | "rpc" | "json" | "print" },
		) => Promise<void>,
	): void;
	exec(
		command: string,
		args: string[],
	): Promise<{ code: number | null; stdout: string }>;
}

declare const process: { env: Record<string, string | undefined>; pid: number };

export default function (pi: PiAPI) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane || !/^%[0-9]+$/.test(pane)) return;

	const incarnation = crypto.randomUUID();
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const write = await pi.exec("tmux", [
			"set-option",
			"-s",
			`@tmux-agents-status-state-${pane}`,
			`v1|${process.pid}|${incarnation}|running|-`,
		]);
		if (write.code !== 0) return;

		try {
			const clients = await pi.exec("tmux", [
				"list-clients",
				"-F",
				"#{client_name}",
			]);
			if (clients.code !== 0) return;
			const clientNames = clients.stdout.trimEnd();
			if (!clientNames) return;
			await Promise.all(
				clientNames
					.split("\n")
					.map((client) =>
						pi
							.exec("tmux", ["refresh-client", "-S", "-t", client])
							.catch(() => undefined),
					),
			);
		} catch {
			return;
		}
	});
}
