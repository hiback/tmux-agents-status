// Minimal stdio MCP server for the Claude Code release smoke. It exposes no
// tools and does nothing until the smoke script creates the trigger file, at
// which point it asks the client for input so the real elicitation dialog and
// its native hook pair can be observed.
//
// Usage: node test/smoke-claude-elicit.mjs <trigger file>
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";

const trigger = process.argv[2];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

let elicited = false;
const watch = setInterval(() => {
	if (elicited || !existsSync(trigger)) return;
	elicited = true;
	clearInterval(watch);
	send({
		jsonrpc: "2.0",
		id: "elicit-1",
		method: "elicitation/create",
		params: {
			message: "Release smoke wait probe",
			requestedSchema: { type: "object", properties: { ok: { type: "boolean", title: "ok" } }, required: [] },
		},
	});
}, 200);

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.id === undefined || !message.method) return;
	if (message.method === "initialize")
		reply(message.id, {
			protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
			capabilities: {},
			serverInfo: { name: "tmux-agents-status-smoke-probe", version: "0.0.0" },
		});
	else if (message.method === "tools/list") reply(message.id, { tools: [] });
	else if (message.method === "resources/list") reply(message.id, { resources: [] });
	else if (message.method === "prompts/list") reply(message.id, { prompts: [] });
	else reply(message.id, {});
});
