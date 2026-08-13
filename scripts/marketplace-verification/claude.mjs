import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  smokeMarketplace,
  stageMarketplace,
} from "./staged-marketplace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nativeSmokeModule = resolve(root, "test/smoke-claude.sh");
const marketplacePaths = [".claude-plugin", "packages/claude"];
const credentialEnvironmentNames = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "SMOKE_ANTHROPIC_API_KEY",
  "SMOKE_OPENAI_API_KEY",
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const claudeBehavior = {
  validatePredecessorTag(tag) {
    if (typeof tag !== "string" ||
        !/^claude-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
      throw new Error("Claude predecessor tag must be canonical stable SemVer");
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

  createAdapterEvidence() {
    return {};
  },

  validateAdapterEvidence(evidence) {
    if (!isPlainObject(evidence) || Object.keys(evidence).length !== 0) {
      throw new Error("Claude adapter evidence must be an empty object");
    }
  },

  runNativeSmoke({ candidateDirectory, execute, predecessorDirectory }) {
    const credential = process.env.SMOKE_ANTHROPIC_API_KEY;
    if (typeof credential !== "string" || credential.trim().length === 0) {
      throw new Error("SMOKE_ANTHROPIC_API_KEY is required for Claude smoke");
    }

    const baseEnvironment = environmentWithoutVerificationCredentials(credential);
    execute("npm", ["install", "--global", "@anthropic-ai/claude-code"], {
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
        ANTHROPIC_API_KEY: credential,
        TAS_SMOKE_MODEL: "claude-haiku-4-5",
      },
      redactions: [credential],
    });
  },
};

export const claudeAdapter = {
  stage(options) {
    return stageMarketplace({ ...options, adapter: claudeBehavior });
  },

  smoke(options) {
    return smokeMarketplace({ ...options, adapter: claudeBehavior });
  },
};
