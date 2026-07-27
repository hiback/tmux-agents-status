// Provider endpoint for the Claude Code release smoke that answers every
// request with a non-retryable API error, which is the only way to make a real
// agent produce the terminal API failure the adapter reports as exact `failed`.
// It reads no request body and logs nothing.
//
// Usage: node test/smoke-claude-api.mjs <port file>
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const portFile = process.argv[2];
const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "release smoke" } });

const server = createServer((request, response) => {
	request.resume();
	response.writeHead(400, { "content-type": "application/json" });
	response.end(body);
});

server.listen(0, "127.0.0.1", () => writeFileSync(portFile, `${server.address().port}\n`));
