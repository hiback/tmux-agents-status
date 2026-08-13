#!/usr/bin/env node

import { resolve } from "node:path";
import { claudeAdapter } from "./marketplace-verification/claude.mjs";
import { codexAdapter } from "./marketplace-verification/codex.mjs";
import {
  MarketplaceVerificationError,
} from "./marketplace-verification/staged-marketplace.mjs";

const commandOptions = {
  stage: {
    allowed: new Set(["artifact", "sha", "previous-tag", "output"]),
    required: ["artifact", "sha", "output"],
  },
  smoke: {
    allowed: new Set(["artifact", "sha", "staged", "update"]),
    required: ["artifact", "sha", "staged", "update"],
  },
};

function parseOptions(command, arguments_) {
  const contract = commandOptions[command];
  if (contract === undefined) {
    throw new MarketplaceVerificationError("unknown operation; expected stage or smoke");
  }

  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (typeof name !== "string" || !name.startsWith("--") || value === undefined ||
        value.startsWith("--")) {
      throw new MarketplaceVerificationError("arguments must be explicit --name value pairs");
    }
    const key = name.slice(2);
    if (!contract.allowed.has(key)) {
      throw new MarketplaceVerificationError("unknown command argument");
    }
    if (options.has(key)) {
      throw new MarketplaceVerificationError(`--${key} may be provided only once`);
    }
    options.set(key, value);
  }
  for (const key of contract.required) {
    if (!options.has(key)) {
      throw new MarketplaceVerificationError(`missing required option --${key}`);
    }
  }
  return options;
}

function selectAdapter(artifact) {
  if (artifact === "claude") return claudeAdapter;
  if (artifact === "codex") return codexAdapter;
  throw new MarketplaceVerificationError("unknown artifact; expected claude or codex");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseOptions(command, arguments_);
  const artifact = options.get("artifact");
  const adapter = selectAdapter(artifact);

  const sha = options.get("sha");
  if (command === "stage") {
    const previousTag = options.get("previous-tag");
    adapter.stage({
      artifact,
      output: options.get("output"),
      previousTag,
      repository: resolve("."),
      sha,
    });
    process.stdout.write(
      `marketplace_verification=staged\nartifact=${artifact}\nsha=${sha}\n` +
        `predecessor_tag=${previousTag ?? ""}\n`,
    );
    return;
  }

  const updateValue = options.get("update");
  if (updateValue !== "true" && updateValue !== "false") {
    throw new MarketplaceVerificationError("--update must be exactly true or false");
  }
  adapter.smoke({
    artifact,
    sha,
    staged: options.get("staged"),
    update: updateValue === "true",
  });
  process.stdout.write("marketplace_verification=passed\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`marketplace verification rejected: ${message}\n`);
  process.exitCode = 1;
}
