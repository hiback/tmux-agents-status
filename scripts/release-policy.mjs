#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const artifacts = {
  core: {
    tagPrefix: "core-v",
  },
  pi: {
    manifest: "packages/pi/package.json",
    shippedPrefixes: ["packages/pi/"],
    tagPrefix: "pi-v",
    lockPath: "packages/pi",
    registry: true,
  },
  opencode: {
    manifest: "packages/opencode/package.json",
    shippedPrefixes: ["packages/opencode/"],
    tagPrefix: "opencode-v",
    lockPath: "packages/opencode",
    registry: true,
  },
  claude: {
    manifest: "packages/claude/.claude-plugin/plugin.json",
    shippedPrefixes: ["packages/claude/", ".claude-plugin/"],
    tagPrefix: "claude-v",
  },
  codex: {
    manifest: "packages/codex/.codex-plugin/plugin.json",
    shippedPrefixes: ["packages/codex/", ".agents/plugins/"],
    tagPrefix: "codex-v",
  },
};

class PolicyError extends Error {}

function parseOptions(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (!name.startsWith("--")) {
      throw new PolicyError(`unexpected argument: ${name}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new PolicyError(`missing value for ${name}`);
    }
    const key = name.slice(2);
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
    index += 1;
  }
  return {
    get(name, fallback) {
      const values = options.get(name);
      return values === undefined ? fallback : values.at(-1);
    },
    require(name) {
      const value = this.get(name);
      if (value === undefined) {
        throw new PolicyError(`missing required option --${name}`);
      }
      return value;
    },
  };
}

function execute(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.error) {
    throw new PolicyError(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new PolicyError(`${command} ${arguments_.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function git(repository, ...arguments_) {
  return execute("git", ["-C", repository, ...arguments_]).stdout;
}

function readJsonAt(repository, revision, path) {
  const contents = git(repository, "show", `${revision}:${path}`);
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new PolicyError(`${path} at ${revision} is not valid JSON: ${error.message}`);
  }
}

function parseVersion(value, description) {
  if (typeof value !== "string" || !stableSemver.test(value)) {
    throw new PolicyError(`${description} must be stable X.Y.Z SemVer; got ${JSON.stringify(value)}`);
  }
  return {
    text: value,
    parts: value.split(".").map((part) => BigInt(part)),
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] < right.parts[index]) return -1;
    if (left.parts[index] > right.parts[index]) return 1;
  }
  return 0;
}

function changedPaths(repository, base, head) {
  const output = git(repository, "diff", "--no-renames", "--name-only", "-z", base, head);
  return output.split("\0").filter(Boolean);
}

function resolveCommit(repository, revision) {
  return git(repository, "rev-parse", `${revision}^{commit}`).trim();
}

function readManifestVersion(repository, revision, artifact) {
  const details = artifacts[artifact];
  const manifest = readJsonAt(repository, revision, details.manifest);
  return parseVersion(manifest.version, `${artifact} manifest version`);
}

function checkLockVersions(repository, head, versions) {
  const lock = readJsonAt(repository, head, "package-lock.json");
  for (const artifact of ["pi", "opencode"]) {
    const lockVersion = lock?.packages?.[artifacts[artifact].lockPath]?.version;
    if (lockVersion !== versions[artifact].text) {
      throw new PolicyError(
        `${artifact} workspace lock version ${JSON.stringify(lockVersion)} does not match manifest version ${versions[artifact].text}`,
      );
    }
  }
}

function readRegistryVersions(path) {
  if (path === undefined) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new PolicyError(`could not read registry versions from ${path}: ${error.message}`);
  }
  if (Array.isArray(value)) return { default: value };
  if (value === null || typeof value !== "object") {
    throw new PolicyError("registry versions must be a JSON array or artifact-to-array object");
  }
  return value;
}

function registryVersionsFor(metadata, artifact) {
  const values = metadata[artifact] ?? metadata.default ?? [];
  if (!Array.isArray(values)) {
    throw new PolicyError(`registry versions for ${artifact} must be an array`);
  }
  return values.map((value) => parseVersion(value, `${artifact} registry version`));
}

function tagVersions(repository, artifact) {
  const details = artifacts[artifact];
  const tags = git(repository, "tag", "--list", `${details.tagPrefix}*`)
    .split("\n")
    .filter(Boolean);
  return tags.map((tag) => ({
    tag,
    version: parseVersion(tag.slice(details.tagPrefix.length), `${artifact} tag ${tag}`),
    commit: resolveCommit(repository, tag),
  }));
}

function currentTagAtHead(tagEntries, candidate, headCommit) {
  const expected = tagEntries.find((entry) => entry.version.text === candidate.text);
  return expected?.commit === headCommit ? expected.tag : undefined;
}

function evaluateHistory(repository, artifact, candidate, head, registryMetadata, explicitCurrentTag) {
  const headCommit = resolveCommit(repository, head);
  const tags = tagVersions(repository, artifact);
  const inferredCurrentTag = currentTagAtHead(tags, candidate, headCommit);
  const currentTag = explicitCurrentTag ?? inferredCurrentTag;
  const currentEntry = currentTag === undefined ? undefined : tags.find((entry) => entry.tag === currentTag);
  const candidateIsCurrent = currentEntry?.commit === headCommit && currentEntry.version.text === candidate.text;

  const tagHistory = tags
    .filter((entry) => !(candidateIsCurrent && entry.tag === currentTag))
    .map((entry) => entry.version);
  const registryHistory = artifacts[artifact].registry
    ? registryVersionsFor(registryMetadata, artifact).filter(
      (version) => !(candidateIsCurrent && version.text === candidate.text),
    )
    : [];

  for (const version of [...tagHistory, ...registryHistory]) {
    if (compareVersions(version, candidate) >= 0) {
      throw new PolicyError(
        `${artifact} candidate ${candidate.text} must be greater than historical version ${version.text}`,
      );
    }
  }

  // Only an installed public package can be an npm adapter's update source.
  const predecessorHistory = artifacts[artifact].registry ? registryHistory : tagHistory;
  let previous;
  for (const version of predecessorHistory) {
    if (previous === undefined || compareVersions(version, previous) > 0) {
      previous = version;
    }
  }
  return previous?.text ?? "";
}

function checkChanges(options) {
  const repository = resolve(options.get("repo", "."));
  const base = options.require("base");
  const head = options.get("head", "HEAD");
  const paths = changedPaths(repository, base, head);
  const versions = {};
  const registryMetadata = readRegistryVersions(options.get("registry-versions"));

  for (const artifact of ["pi", "opencode", "claude", "codex"]) {
    versions[artifact] = readManifestVersion(repository, head, artifact);
  }
  checkLockVersions(repository, head, versions);

  for (const artifact of ["pi", "opencode", "claude", "codex"]) {
    const details = artifacts[artifact];
    const shippedChanged = paths.some((path) =>
      details.shippedPrefixes.some((prefix) => path.startsWith(prefix)),
    );
    if (!shippedChanged) continue;

    const baseVersion = readManifestVersion(repository, base, artifact);
    if (compareVersions(versions[artifact], baseVersion) <= 0) {
      throw new PolicyError(
        `${artifact} shipped content changed, but manifest version ${versions[artifact].text} is not greater than ${baseVersion.text}`,
      );
    }
    evaluateHistory(repository, artifact, versions[artifact], head, registryMetadata);
  }

  process.stdout.write("adapter_versions=accepted\n");
}

function readSeconds(options, name, fallback) {
  const value = Number(options.get(name, String(fallback)));
  if (!Number.isFinite(value) || value < 0) {
    throw new PolicyError(`--${name} must be a non-negative number`);
  }
  return value;
}

function readCiRuns(repository, workflow, sha) {
  const endpoint = `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const response = execute(
    "gh",
    [
      "api",
      "--method",
      "GET",
      endpoint,
      "-f",
      "branch=main",
      "-f",
      "event=push",
      "-f",
      `head_sha=${sha}`,
      "-f",
      "per_page=100",
    ],
    { allowFailure: true },
  );
  if (response.status !== 0) {
    const detail = (response.stderr || response.stdout).trim();
    throw new PolicyError(`GitHub Actions lookup failed${detail ? `: ${detail}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(response.stdout);
  } catch (error) {
    throw new PolicyError(`GitHub Actions returned malformed JSON: ${error.message}`);
  }
  if (!Array.isArray(payload?.workflow_runs)) {
    throw new PolicyError("GitHub Actions response has no workflow_runs array");
  }
  return payload.workflow_runs.filter(
    (run) => run?.event === "push" && run?.head_branch === "main" && run?.head_sha === sha,
  );
}

async function proveMainCi(options) {
  const repository = options.require("repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new PolicyError("--repository must be an owner/name pair");
  }
  const sha = options.require("sha");
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new PolicyError("--sha must be a full 40-character commit SHA");
  }
  const workflow = options.get("workflow", "ci.yml");
  const visibilityTimeout = readSeconds(options, "visibility-timeout-seconds", 120);
  const pollInterval = readSeconds(options, "poll-interval-seconds", 10);
  const totalTimeout = readSeconds(options, "total-timeout-seconds", 3540);
  if (visibilityTimeout > totalTimeout) {
    throw new PolicyError("visibility timeout cannot exceed total timeout");
  }

  const started = performance.now();
  const elapsedSeconds = () => (performance.now() - started) / 1000;
  process.stderr.write(
    `CI proof configuration: visibility timeout ${visibilityTimeout}s; ` +
      `poll interval ${pollInterval}s; total timeout ${totalTimeout}s\n`,
  );

  while (true) {
    const matchingRuns = readCiRuns(repository, workflow, sha);
    if (matchingRuns.length > 1) {
      throw new PolicyError(`found ${matchingRuns.length} matching main CI runs; proof is ambiguous`);
    }
    if (matchingRuns.length === 0) {
      if (elapsedSeconds() >= visibilityTimeout) {
        throw new PolicyError(`no matching main push CI run became visible within ${visibilityTimeout}s`);
      }
    } else {
      const run = matchingRuns[0];
      if (run.status === "completed") {
        if (run.conclusion !== "success") {
          throw new PolicyError(
            `matching main CI run ${run.id ?? "unknown"} concluded ${run.conclusion ?? "without a conclusion"}`,
          );
        }
        if ((typeof run.id !== "number" && typeof run.id !== "string") ||
            typeof run.html_url !== "string" || run.html_url.length === 0) {
          throw new PolicyError("successful main CI run has no reusable identity or URL");
        }
        process.stderr.write(`Accepted main CI run ${run.id}: ${run.html_url}\n`);
        process.stdout.write(`run_id=${run.id}\nrun_url=${run.html_url}\n`);
        return;
      }
      if (run.status !== "queued" && run.status !== "in_progress") {
        throw new PolicyError(
          `matching main CI run ${run.id ?? "unknown"} has unsupported status ${JSON.stringify(run.status)}`,
        );
      }
      process.stderr.write(`Waiting for main CI run ${run.id ?? "unknown"} (${run.status})\n`);
    }

    if (elapsedSeconds() >= totalTimeout) {
      throw new PolicyError(`matching main CI proof did not succeed within ${totalTimeout}s`);
    }
    await delay(pollInterval * 1000);
  }
}

function checkNpmArtifact(options) {
  const packageName = options.require("package");
  const version = parseVersion(options.require("version"), "npm candidate version");
  const candidateIntegrity = options.require("integrity");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(candidateIntegrity)) {
    throw new PolicyError("candidate integrity must be a registry-compatible sha512 value");
  }

  const lookup = execute(
    "npm",
    ["view", `${packageName}@${version.text}`, "dist.integrity", "--json"],
    { allowFailure: true },
  );
  let decision;
  if (lookup.status !== 0) {
    const diagnostic = `${lookup.stdout}\n${lookup.stderr}`;
    if (/\bE404\b/i.test(diagnostic)) {
      decision = "publish";
    } else {
      throw new PolicyError(`npm registry lookup failed: ${diagnostic.trim() || `exit ${lookup.status}`}`);
    }
  } else {
    let existingIntegrity;
    try {
      existingIntegrity = JSON.parse(lookup.stdout);
    } catch (error) {
      throw new PolicyError(`npm registry returned malformed integrity JSON: ${error.message}`);
    }
    if (typeof existingIntegrity !== "string" || existingIntegrity.length === 0) {
      throw new PolicyError("npm registry returned no integrity for an existing version");
    }
    if (existingIntegrity !== candidateIntegrity) {
      throw new PolicyError(
        `npm version ${packageName}@${version.text} already exists with conflicting integrity`,
      );
    }
    decision = "already-published";
  }

  const authentication = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN
    ? "token-fallback"
    : "trusted-publishing";
  process.stdout.write(`decision=${decision}\nauthentication=${authentication}\n`);
}

function checkArtifact(options) {
  const repository = resolve(options.get("repo", "."));
  const artifact = options.require("artifact");
  const details = artifacts[artifact];
  if (details === undefined) {
    throw new PolicyError(`unknown artifact: ${artifact}`);
  }
  const head = options.get("head", "HEAD");
  const tag = options.require("tag");
  if (!tag.startsWith(details.tagPrefix)) {
    throw new PolicyError(`${artifact} tag must start with ${details.tagPrefix}`);
  }

  const tagVersion = parseVersion(tag.slice(details.tagPrefix.length), `${artifact} tag ${tag}`);
  const tagType = git(repository, "cat-file", "-t", `refs/tags/${tag}`).trim();
  if (tagType !== "commit") {
    throw new PolicyError(`${artifact} tag ${tag} must be a lightweight commit tag`);
  }
  const candidate = details.manifest
    ? readManifestVersion(repository, head, artifact)
    : tagVersion;
  const expectedTag = `${details.tagPrefix}${candidate.text}`;
  if (tag !== expectedTag) {
    throw new PolicyError(`${artifact} tag ${tag} does not match candidate ${candidate.text}`);
  }
  if (resolveCommit(repository, tag) !== resolveCommit(repository, head)) {
    throw new PolicyError(`${artifact} tag ${tag} does not point to ${head}`);
  }

  const registryMetadata = readRegistryVersions(options.get("registry-versions"));
  const previous = evaluateHistory(
    repository,
    artifact,
    candidate,
    head,
    registryMetadata,
    tag,
  );
  process.stdout.write(`candidate=${candidate.text}\nprevious=${previous}\n`);
}

function usage() {
  return `Usage:
  release-policy.mjs check-changes --base <git-ref> [--head <git-ref>] [--repo <path>] [--registry-versions <json>]
  release-policy.mjs check-artifact --artifact <name> --tag <tag> [--head <git-ref>] [--repo <path>] [--registry-versions <json>]
  release-policy.mjs check-npm-artifact --package <name> --version <X.Y.Z> --integrity <sha512-value>
  release-policy.mjs prove-main-ci --repository <owner/name> --sha <commit> [--workflow ci.yml]
`;
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(arguments_);
  if (command === "check-changes") {
    checkChanges(options);
    return;
  }
  if (command === "check-artifact") {
    checkArtifact(options);
    return;
  }
  if (command === "check-npm-artifact") {
    checkNpmArtifact(options);
    return;
  }
  if (command === "prove-main-ci") {
    await proveMainCi(options);
    return;
  }
  throw new PolicyError(`unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release policy rejected: ${message}\n`);
  process.exitCode = 1;
}
