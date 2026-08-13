import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  smokeMarketplace,
  stageMarketplace,
} from "./staged-marketplace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nativeSmokeModule = resolve(root, "test/smoke-codex.sh");
const marketplacePaths = [".agents/plugins", "packages/codex"];
const hooksPath = "packages/codex/hooks/hooks.json";
const hookPath = "packages/codex/bin/tmux-agents-status-hook";
const credentialEnvironmentNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "SMOKE_ANTHROPIC_API_KEY",
  "SMOKE_OPENAI_API_KEY",
  "TAS_CODEX_HOOKS_SHA256",
  "TAS_CODEX_HOOK_SHA256",
  "TAS_SMOKE_MODEL",
];

function environmentWithoutVerificationCredentials(selectedCredential) {
  const environment = { ...process.env };
  for (const name of credentialEnvironmentNames) delete environment[name];
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_TOKEN;
  for (const [name, value] of Object.entries(environment)) {
    if (value === selectedCredential) delete environment[name];
  }
  return environment;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readArchiveEntry({ archive, execute }, path) {
  return execute("tar", ["-xOf", archive, "--", path], { binaryOutput: true }).stdout;
}

function hasExactEvidenceFields(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value).sort();
  return fields.length === 2 && fields[0] === "hookSha256" && fields[1] === "hooksSha256";
}

function createAdapterEvidence(context) {
  return {
    hooksSha256: sha256(readArchiveEntry(context, hooksPath)),
    hookSha256: sha256(readArchiveEntry(context, hookPath)),
  };
}

const codexBehavior = {
  validatePredecessorTag(tag) {
    if (typeof tag !== "string" ||
        !/^codex-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
      throw new Error("Codex predecessor tag must be canonical stable SemVer");
    }
  },

  archiveMarketplace({ execute, output, revision }) {
    execute("git", [
      "archive",
      "--format=tar",
      `--output=${output}`,
      revision,
      "--",
      ...marketplacePaths,
    ]);
  },

  createAdapterEvidence,

  validateAdapterEvidence(evidence, { candidateArchive, execute }) {
    if (!hasExactEvidenceFields(evidence)) {
      throw new Error("Codex adapter evidence fields are invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(evidence.hooksSha256) ||
        !/^[0-9a-f]{64}$/.test(evidence.hookSha256)) {
      throw new Error("Codex adapter evidence digest is malformed");
    }
    const expected = createAdapterEvidence({ archive: candidateArchive, execute });
    if (evidence.hooksSha256 !== expected.hooksSha256 ||
        evidence.hookSha256 !== expected.hookSha256) {
      throw new Error("Codex adapter evidence does not match the staged hooks");
    }
    return evidence;
  },

  runNativeSmoke({ adapterEvidence, candidateDirectory, execute, predecessorDirectory }) {
    const credential = process.env.SMOKE_OPENAI_API_KEY;
    if (typeof credential !== "string" || credential.trim().length === 0) {
      throw new Error("SMOKE_OPENAI_API_KEY is required for Codex smoke");
    }

    const baseEnvironment = environmentWithoutVerificationCredentials(credential);
    execute("npm", ["install", "--global", "@openai/codex"], {
      emitOutput: true,
      env: baseEnvironment,
      redactions: [credential],
    });

    const arguments_ = [nativeSmokeModule, candidateDirectory];
    if (predecessorDirectory !== undefined) arguments_.push(predecessorDirectory);
    execute("sh", arguments_, {
      emitOutput: true,
      env: {
        ...baseEnvironment,
        OPENAI_API_KEY: credential,
        TAS_CODEX_HOOKS_SHA256: adapterEvidence.hooksSha256,
        TAS_CODEX_HOOK_SHA256: adapterEvidence.hookSha256,
        TAS_SMOKE_MODEL: "gpt-5.6-luna",
      },
      redactions: [credential],
    });
  },
};

export const codexAdapter = {
  stage(options) {
    return stageMarketplace({ ...options, adapter: codexBehavior });
  },

  smoke(options) {
    return smokeMarketplace({ ...options, adapter: codexBehavior });
  },
};
