// OpenCode lifecycle adapter. It translates first-party OpenCode bus events
// into the shared tmux core's normalized operations and never inspects prompts,
// responses, tool arguments, transcripts, or model text.

interface ShellResult {
	exitCode?: number | null;
	stdout?: unknown;
}

interface ShellPromise extends PromiseLike<ShellResult> {
	quiet(): ShellPromise;
	nothrow(): ShellPromise;
}

type Shell = (
	strings: TemplateStringsArray,
	...values: (string | string[])[]
) => ShellPromise;

interface OpencodeClient {
	session?: {
		get?: (input: { path: { id: string } }) => Promise<unknown>;
	};
}

interface PluginInput {
	$: Shell;
	client?: OpencodeClient;
}

interface Hooks {
	event?: (input: { event: unknown }) => Promise<void>;
	dispose?: () => Promise<void>;
}

interface ProcessOwnership {
	owner: string;
	claimed: boolean;
	activeRuntime?: symbol;
}

declare const process: {
	env: Record<string, string | undefined>;
	pid: number;
};

const protocolMajor = "2";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ownershipKey = Symbol.for(
	"tmux-agents-status.opencode-process-ownership-v2",
);
const ownershipStore = globalThis as typeof globalThis & {
	[ownershipKey]?: ProcessOwnership;
};

function newOwner() {
	return `opencode:${crypto.randomUUID()}`;
}

function newTurn() {
	return `turn:${crypto.randomUUID()}`;
}

function asObject(value: unknown) {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function identifier(value: unknown) {
	return typeof value === "string" && identifierPattern.test(value)
		? value
		: undefined;
}

// Root sessions own the pane; child sessions carry subagent and background
// work. Native session data that cannot be classified stays unknown.
function sessionInfo(info: unknown) {
	const session = asObject(info);
	const id = identifier(session?.["id"]);
	if (!session || !id) return;
	const parent = session["parentID"];
	if (parent === undefined || parent === null) return { id, isRoot: true };
	if (typeof parent === "string") return { id, isRoot: false };
	return;
}

export const TmuxAgentsStatusPlugin = async ({
	$,
	client,
}: PluginInput): Promise<Hooks> => {
	const pane = process.env.TMUX_PANE ?? "";
	if (!process.env.TMUX || !/^%[0-9]+$/.test(pane)) return {};
	if (typeof $ !== "function") return {};

	// The newest plugin instance in this process owns the pane. Superseded
	// instances stop reporting instead of fighting over the pane record.
	const runtime = Symbol();
	const ownership: ProcessOwnership = {
		owner: newOwner(),
		claimed: false,
		activeRuntime: runtime,
	};
	ownershipStore[ownershipKey] = ownership;

	const sessionIsRoot = new Map<string, boolean>();
	const pending = new Set<string>();
	let tracked: string | undefined;
	let turn: string | undefined;
	let failure = false;
	let cancelled = false;
	let ended = false;
	let queue = Promise.resolve();

	function diagnose(operation: string) {
		console.error(`tmux-agents-status: opencode adapter: ${operation} failed`);
	}

	function enqueue(operation: string, task: () => Promise<void>) {
		queue = queue.then(task, () => task()).catch(() => diagnose(operation));
		return queue;
	}

	function isActive() {
		return !ended && ownershipStore[ownershipKey]?.activeRuntime === runtime;
	}

	function decode(value: unknown) {
		if (typeof value === "string") return value;
		if (value instanceof Uint8Array) return new TextDecoder().decode(value);
		return undefined;
	}

	async function execute(
		command: string,
		args: string[],
		operation: string,
		diagnoseFailure = true,
	) {
		try {
			const result = await $`${command} ${args}`.quiet().nothrow();
			if (result?.exitCode === 0) return decode(result.stdout) ?? "";
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

	async function ensureOwnership() {
		if (ownership.claimed) return true;
		ownership.claimed = await invoke(
			"claim",
			ownership.owner,
			`pid:${process.pid}`,
		);
		return ownership.claimed;
	}

	function resetTurn() {
		turn = undefined;
		failure = false;
		cancelled = false;
		pending.clear();
	}

	function registerSession(info: unknown) {
		const session = sessionInfo(info);
		if (session) sessionIsRoot.set(session.id, session.isRoot);
	}

	async function lookupSession(id: string) {
		try {
			const response = await client?.session?.get?.({ path: { id } });
			const envelope = asObject(response);
			return envelope && "data" in envelope ? envelope["data"] : response;
		} catch {
			return undefined;
		}
	}

	// A session first observed after this plugin loaded, such as a resumed
	// session, carries no parent identity in its own status events. It is
	// resolved through the plugin's own session data; an unresolvable identity
	// stays untracked rather than being guessed.
	async function isRootSession(id: string) {
		const known = sessionIsRoot.get(id);
		if (known !== undefined) return known;
		const session = sessionInfo(await lookupSession(id));
		if (session?.id !== id) return false;
		sessionIsRoot.set(session.id, session.isRoot);
		return session.isRoot;
	}

	async function onBusy(sessionID: string) {
		if (!(await isRootSession(sessionID))) return;
		if (tracked !== sessionID) {
			// A different root session starting work replaces the pane owner. The
			// claim itself clears the previous state without inventing a failure.
			if (tracked !== undefined) {
				ownership.owner = newOwner();
				ownership.claimed = false;
				resetTurn();
			}
			tracked = sessionID;
		}
		if (!(await ensureOwnership())) return;
		// Repeated busy events belong to the accepted turn, including while the
		// user is being asked something.
		if (turn) return;
		const started = newTurn();
		if (await invoke("start", ownership.owner, started)) {
			turn = started;
			failure = false;
		}
	}

	async function onIdle(sessionID: string) {
		if (tracked !== sessionID || !turn) return;
		const outcome = failure || cancelled ? "failed" : "completed";
		if (await invoke("finish", ownership.owner, turn, outcome)) resetTurn();
	}

	function markFailure(sessionID: string | undefined) {
		if (sessionID && sessionID === tracked && turn) failure = true;
	}

	async function onAsked(properties: Record<string, unknown>) {
		const sessionID = identifier(properties["sessionID"]);
		const request = identifier(properties["id"]);
		if (!request || sessionID !== tracked || !turn) return;
		if (!ownership.claimed || pending.has(request)) return;
		if (await invoke("wait-open", ownership.owner, turn, request))
			pending.add(request);
	}

	async function onAnswered(
		properties: Record<string, unknown>,
		rejected: boolean,
	) {
		const sessionID = identifier(properties["sessionID"]);
		const request = identifier(properties["requestID"]);
		if (!request || sessionID !== tracked || !turn) return;
		if (!pending.has(request)) return;
		if (rejected) cancelled = true;
		if (await invoke("wait-close", ownership.owner, turn, request))
			pending.delete(request);
	}

	// An assistant message that settles normally proves the turn continued past a
	// rejected request, which OpenCode allows under continued-on-deny behavior.
	function onMessage(info: unknown) {
		const message = asObject(info);
		if (message?.["role"] !== "assistant") return;
		const sessionID = identifier(message["sessionID"]);
		if (asObject(message["error"])) markFailure(sessionID);
		else if (
			sessionID === tracked &&
			asObject(message["time"])?.["completed"] !== undefined
		)
			cancelled = false;
	}

	async function onStatus(properties: Record<string, unknown>) {
		const sessionID = identifier(properties["sessionID"]);
		const status = asObject(properties["status"]);
		const type = status?.["type"];
		if (!sessionID || typeof type !== "string") return;
		// A retry is in-progress evidence, so only busy and idle move the turn.
		if (type === "busy") await onBusy(sessionID);
		else if (type === "idle") await onIdle(sessionID);
	}

	async function handle(event: unknown) {
		const envelope = asObject(event);
		const type = envelope?.["type"];
		if (typeof type !== "string") return;
		const properties = asObject(envelope?.["properties"]);
		if (!properties) return;
		switch (type) {
			case "session.created":
			case "session.updated":
				registerSession(properties["info"]);
				return;
			case "session.status":
				await onStatus(properties);
				return;
			case "session.error":
				markFailure(identifier(properties["sessionID"]));
				return;
			case "message.updated":
				onMessage(properties["info"]);
				return;
			case "permission.asked":
			case "question.asked":
				await onAsked(properties);
				return;
			case "permission.replied":
				await onAnswered(properties, properties["reply"] === "reject");
				return;
			case "question.replied":
				await onAnswered(properties, false);
				return;
			case "question.rejected":
				await onAnswered(properties, true);
				return;
		}
	}

	enqueue("claim", async () => {
		if (isActive()) await ensureOwnership();
	});

	return {
		event: async ({ event }) =>
			await enqueue("event", async () => {
				if (isActive()) await handle(event);
			}),
		// OpenCode awaits disposal, so ownership is released before the instance
		// goes away. Abrupt death cannot run any in-process hook; the core's
		// liveness projection and later claims cover that case.
		dispose: async () =>
			await enqueue("dispose", async () => {
				if (!isActive()) return;
				ended = true;
				if (ownership.claimed) {
					const reason = turn ? "interrupted" : "clear";
					if (await invoke("release", ownership.owner, reason))
						ownership.claimed = false;
				}
				resetTurn();
				tracked = undefined;
				if (ownershipStore[ownershipKey] === ownership)
					ownership.activeRuntime = undefined;
			}),
	};
};
