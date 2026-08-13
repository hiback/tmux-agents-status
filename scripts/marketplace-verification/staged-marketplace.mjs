import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const candidateArchiveName = "marketplace.tar";
export const predecessorArchiveName = "previous.tar";
export const receiptName = "native-evidence.json";

const localEnvironmentNames = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
];

export class MarketplaceVerificationError extends Error {}

function localEnvironment() {
  const environment = {};
  for (const name of localEnvironmentNames) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function redact(value, redactions = []) {
  let sanitized = value;
  for (const secret of redactions) {
    if (typeof secret === "string" && secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  return sanitized;
}

function execute(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? localEnvironment(),
  });
  if (result.error) {
    throw new MarketplaceVerificationError(`could not run ${command}`);
  }
  if (result.status !== 0) {
    const detail = redact((result.stderr || result.stdout).trim(), options.redactions);
    throw new MarketplaceVerificationError(
      `${command} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  if (options.emitOutput) {
    process.stdout.write(redact(result.stdout, options.redactions));
    process.stderr.write(redact(result.stderr, options.redactions));
  }
  return result;
}

function requireCommit(repository, revision, errorMessage) {
  const result = execute("git", ["cat-file", "-t", revision], { cwd: repository });
  if (result.stdout.trim() !== "commit") {
    throw new MarketplaceVerificationError(errorMessage);
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256(path) {
  return sha256Bytes(readFileSync(path));
}

function requireAbsentOutput(output) {
  try {
    lstatSync(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new MarketplaceVerificationError("--output availability could not be verified");
  }
  throw new MarketplaceVerificationError("--output must be absent");
}

function publishOutput(source, destination) {
  try {
    // Reserve the absent name so rename can replace only this invocation's empty directory.
    mkdirSync(destination, { mode: 0o000 });
  } catch {
    throw new MarketplaceVerificationError("--output must remain absent until staging completes");
  }
  try {
    renameSync(source, destination);
  } catch {
    throw new MarketplaceVerificationError("--output changed during no-clobber publication");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireRegularFile(path, description) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new MarketplaceVerificationError(`${description} is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new MarketplaceVerificationError(`${description} must be a regular file`);
  }
}

function readReceipt(stagedDirectory) {
  const path = join(stagedDirectory, receiptName);
  requireRegularFile(path, "native evidence receipt");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MarketplaceVerificationError("native evidence receipt must be valid JSON");
  }
}

function validateReceipt({ adapter, artifact, receipt, sha }) {
  if (!hasExactKeys(receipt, [
    "schema",
    "artifact",
    "sha",
    "marketplaceSha256",
    "predecessor",
    "adapterEvidence",
  ])) {
    throw new MarketplaceVerificationError("native evidence receipt fields do not match schema 1");
  }
  if (receipt.schema !== 1) {
    throw new MarketplaceVerificationError("native evidence receipt schema is unsupported");
  }
  if (receipt.artifact !== "claude" && receipt.artifact !== "codex") {
    throw new MarketplaceVerificationError("native evidence receipt has an unknown artifact");
  }
  if (receipt.artifact !== artifact) {
    throw new MarketplaceVerificationError("native evidence receipt artifact does not match");
  }
  if (!/^[0-9a-f]{40}$/.test(receipt.sha) || receipt.sha !== sha) {
    throw new MarketplaceVerificationError("native evidence receipt SHA does not match");
  }
  if (!/^[0-9a-f]{64}$/.test(receipt.marketplaceSha256)) {
    throw new MarketplaceVerificationError("candidate marketplace digest is malformed");
  }
  if (receipt.predecessor !== null) {
    if (!hasExactKeys(receipt.predecessor, ["tag", "marketplaceSha256"])) {
      throw new MarketplaceVerificationError("native evidence predecessor fields are invalid");
    }
    try {
      adapter.validatePredecessorTag(receipt.predecessor.tag);
    } catch {
      throw new MarketplaceVerificationError("native evidence predecessor tag is not canonical");
    }
    if (!/^[0-9a-f]{64}$/.test(receipt.predecessor.marketplaceSha256)) {
      throw new MarketplaceVerificationError("predecessor marketplace digest is malformed");
    }
  }
}

function requireStagedDirectory(staged) {
  let metadata;
  try {
    metadata = lstatSync(staged);
  } catch {
    throw new MarketplaceVerificationError("--staged must identify the staged output directory");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new MarketplaceVerificationError("--staged must identify the staged output directory");
  }
}

export function stageMarketplace({ adapter, artifact, output, previousTag, repository, sha }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new MarketplaceVerificationError("--sha must be a lowercase 40-character commit SHA");
  }
  if (previousTag !== undefined) {
    try {
      adapter.validatePredecessorTag(previousTag);
    } catch {
      throw new MarketplaceVerificationError("--previous-tag is not canonical for the artifact");
    }
  }

  const destination = resolve(output);
  requireAbsentOutput(destination);
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryOutput = mkdtempSync(join(dirname(destination), ".marketplace-verification-"));

  try {
    requireCommit(repository, sha, "--sha must identify a Git commit");
    const runInRepository = (command, arguments_) =>
      execute(command, arguments_, { cwd: repository });
    const candidateArchive = join(temporaryOutput, candidateArchiveName);
    adapter.archiveMarketplace({
      execute: runInRepository,
      output: candidateArchive,
      revision: sha,
    });
    requireRegularFile(candidateArchive, "candidate marketplace archive");

    let predecessor = null;
    if (previousTag !== undefined) {
      const predecessorRevision = `refs/tags/${previousTag}`;
      requireCommit(
        repository,
        predecessorRevision,
        "--previous-tag must identify a lightweight Git commit tag",
      );
      const predecessorArchive = join(temporaryOutput, predecessorArchiveName);
      adapter.archiveMarketplace({
        execute: runInRepository,
        output: predecessorArchive,
        revision: predecessorRevision,
      });
      requireRegularFile(predecessorArchive, "predecessor marketplace archive");
      predecessor = {
        tag: previousTag,
        marketplaceSha256: sha256(predecessorArchive),
      };
    }

    const receipt = {
      schema: 1,
      artifact,
      sha,
      marketplaceSha256: sha256(candidateArchive),
      predecessor,
      adapterEvidence: adapter.createAdapterEvidence({ archive: candidateArchive }),
    };
    writeFileSync(join(temporaryOutput, receiptName), `${JSON.stringify(receipt, null, 2)}\n`);
    const expectedFiles = [candidateArchiveName, receiptName];
    if (predecessor !== null) expectedFiles.push(predecessorArchiveName);
    if (readdirSync(temporaryOutput).sort().join("\n") !== expectedFiles.sort().join("\n")) {
      throw new MarketplaceVerificationError("staging did not produce the fixed output set");
    }

    publishOutput(temporaryOutput, destination);
    return receipt;
  } catch (error) {
    rmSync(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

export function smokeMarketplace({ adapter, artifact, sha, staged, update }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new MarketplaceVerificationError("--sha must be a lowercase 40-character commit SHA");
  }
  if (typeof update !== "boolean") {
    throw new MarketplaceVerificationError("--update must be true or false");
  }

  const stagedDirectory = resolve(staged);
  requireStagedDirectory(stagedDirectory);
  const receipt = readReceipt(stagedDirectory);
  validateReceipt({ adapter, artifact, receipt, sha });

  const expectedFiles = [candidateArchiveName, receiptName];
  if (receipt.predecessor !== null) expectedFiles.push(predecessorArchiveName);
  if (readdirSync(stagedDirectory).sort().join("\n") !== expectedFiles.sort().join("\n")) {
    throw new MarketplaceVerificationError("staged output contains a missing or unexpected file");
  }
  const candidateArchive = join(stagedDirectory, candidateArchiveName);
  requireRegularFile(candidateArchive, "candidate marketplace archive");
  const candidateBytes = readFileSync(candidateArchive);
  if (sha256Bytes(candidateBytes) !== receipt.marketplaceSha256) {
    throw new MarketplaceVerificationError("candidate marketplace archive digest does not match");
  }

  let predecessorBytes;
  if (receipt.predecessor !== null) {
    const predecessorArchive = join(stagedDirectory, predecessorArchiveName);
    requireRegularFile(predecessorArchive, "predecessor marketplace archive");
    predecessorBytes = readFileSync(predecessorArchive);
    if (sha256Bytes(predecessorBytes) !== receipt.predecessor.marketplaceSha256) {
      throw new MarketplaceVerificationError("predecessor marketplace archive digest does not match");
    }
  }

  const work = mkdtempSync(join(tmpdir(), "tas-marketplace-smoke-"));
  try {
    const archiveDirectory = join(work, "archives");
    mkdirSync(archiveDirectory);
    const validatedCandidateArchive = join(archiveDirectory, candidateArchiveName);
    writeFileSync(validatedCandidateArchive, candidateBytes);
    adapter.validateAdapterEvidence(
      receipt.adapterEvidence,
      { candidateArchive: validatedCandidateArchive },
    );

    const candidateDirectory = join(work, "marketplace");
    mkdirSync(candidateDirectory);
    execute("tar", ["-xf", validatedCandidateArchive, "-C", candidateDirectory]);

    let predecessorDirectory;
    if (update && predecessorBytes !== undefined) {
      const validatedPredecessorArchive = join(archiveDirectory, predecessorArchiveName);
      writeFileSync(validatedPredecessorArchive, predecessorBytes);
      predecessorDirectory = join(work, "previous");
      mkdirSync(predecessorDirectory);
      execute("tar", ["-xf", validatedPredecessorArchive, "-C", predecessorDirectory]);
    }
    adapter.runNativeSmoke({
      candidateDirectory,
      execute,
      predecessorDirectory,
      update,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
