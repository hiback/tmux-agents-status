import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verification = join(root, "scripts", "marketplace-verification.mjs");
const temporaryRoots = [];
const credential = "ticket-01-anthropic-secret-value";

process.on("exit", () => {
  for (const directory of temporaryRoots) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (options.expectFailure ? result.status === 0 : result.status !== 0) {
    const expectation = options.expectFailure ? "failure" : "success";
    assert.fail(
      `${command} ${args.join(" ")} expected ${expectation}\n` +
        `status: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function git(repository, ...args) {
  return run("git", args, { cwd: repository }).stdout.trim();
}

function writeJson(repository, path, value) {
  const absolute = join(repository, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function commit(repository, message) {
  git(repository, "add", "--all");
  git(repository, "commit", "-q", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function createClaudeRepository(options = {}) {
  const repository = temporaryDirectory("tas-marketplace-repository-");
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.name", "Marketplace Verification Test");
  git(repository, "config", "user.email", "marketplace-verification@example.invalid");

  writeJson(repository, ".claude-plugin/marketplace.json", {
    name: "tmux-agents-status",
    plugins: [{ name: "tmux-agents-status", source: "./packages/claude" }],
  });
  writeJson(repository, "packages/claude/.claude-plugin/plugin.json", {
    name: "tmux-agents-status",
    version: options.withPredecessor ? "0.9.0" : "1.0.0",
  });
  writeJson(repository, "packages/claude/hooks/hooks.json", { hooks: {} });
  const executable = join(repository, "packages/claude/bin/tmux-agents-status-hook");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(
    executable,
    options.withPredecessor
      ? "#!/bin/sh\nprintf 'predecessor hook\\n'\n"
      : "#!/bin/sh\nprintf 'candidate hook\\n'\n",
  );
  chmodSync(executable, 0o755);
  writeFileSync(join(repository, "README.md"), "# Not marketplace content\n");

  let previousSha;
  if (options.withPredecessor) {
    previousSha = commit(repository, "predecessor marketplace");
    git(repository, "tag", "claude-v0.9.0");
    writeJson(repository, "packages/claude/.claude-plugin/plugin.json", {
      name: "tmux-agents-status",
      version: "1.0.0",
    });
    writeFileSync(executable, "#!/bin/sh\nprintf 'candidate hook\\n'\n");
  }

  const sha = commit(repository, "candidate marketplace");
  git(repository, "tag", "claude-v1.0.0");
  return { repository, sha, executable, previousSha };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createRecordingGit() {
  const fakeBin = temporaryDirectory("tas-marketplace-git-bin-");
  const invocationLog = join(fakeBin, "invocations");
  writeFileSync(invocationLog, "");
  const executable = join(fakeBin, "git");
  writeFileSync(
    executable,
    `#!/bin/sh
set -eu
invocation_log=${shellQuote(invocationLog)}
system_path=${shellQuote(process.env.PATH)}
printf '%s|credential=%s\\n' "$*" "\${SMOKE_ANTHROPIC_API_KEY:+set}" >>"$invocation_log"
PATH=$system_path
export PATH
exec git "$@"
`,
  );
  chmodSync(executable, 0o755);
  return { fakeBin, invocationLog };
}

function createDestinationRacingGit(destination, populate) {
  const fakeBin = temporaryDirectory("tas-marketplace-racing-git-bin-");
  const executable = join(fakeBin, "git");
  const population = populate
    ? `  printf 'created by concurrent publisher\\n' >${shellQuote(join(destination, "concurrent-owner"))}\n`
    : "";
  writeFileSync(
    executable,
    `#!/bin/sh
set -eu
system_path=${shellQuote(process.env.PATH)}
if [ "\${1-}" = archive ]; then
  mkdir -p ${shellQuote(destination)}
${population}fi
PATH=$system_path
export PATH
exec git "$@"
`,
  );
  chmodSync(executable, 0o755);
  return fakeBin;
}

function createFakeClaudeCommands(options = {}) {
  const fakeBin = temporaryDirectory("tas-marketplace-fake-bin-");
  const invocationLog = join(fakeBin, "invocations");
  writeFileSync(invocationLog, "");
  writeFileSync(
    join(fakeBin, "tar"),
    `#!/bin/sh
set -eu
invocation_log=${shellQuote(invocationLog)}
system_path=${shellQuote(process.env.PATH)}
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${ANTHROPIC_API_KEY-}" ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_API_KEY-}" ]
printf 'unpack|%s\\n' "$*" >>"$invocation_log"
${options.failTar ? "printf 'fake tar failed\\n' >&2\nexit 70" : "PATH=$system_path\nexport PATH\nexec tar \"$@\""}
`,
  );
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh
set -eu
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
printf 'install|%s|anthropic=%s|openai=%s\\n' \
  "$*" "\${ANTHROPIC_API_KEY:+set}" "\${OPENAI_API_KEY:+set}" >>"$FAKE_INVOCATION_LOG"
if [ "\${FAKE_FAIL_COMMAND-}" = npm ]; then
  printf 'fake npm failed: ${credential}\\n' >&2
  exit 71
fi
`,
  );
  writeFileSync(
    join(fakeBin, "sh"),
    `#!/bin/sh
set -eu
[ "$ANTHROPIC_API_KEY" = ${shellQuote(credential)} ]
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_API_KEY-}" ]
[ "$TAS_SMOKE_MODEL" = claude-haiku-4-5 ]
[ "$#" -eq 2 ] || [ "$#" -eq 3 ]
[ -x "$2/packages/claude/bin/tmux-agents-status-hook" ]
previous=\${3-}
[ -z "$previous" ] || [ -x "$previous/packages/claude/bin/tmux-agents-status-hook" ]
printf 'smoke|%s|candidate=%s|previous=%s|model=%s\\n' \
  "$1" "$2" "$previous" "$TAS_SMOKE_MODEL" >>"$FAKE_INVOCATION_LOG"
if [ "\${FAKE_FAIL_COMMAND-}" = smoke ]; then
  printf 'fake smoke failed: ${credential}\\n' >&2
  exit 72
fi
printf 'ok - fake Claude native smoke\\n'
`,
  );
  for (const command of ["tar", "npm", "sh"]) chmodSync(join(fakeBin, command), 0o755);
  return { fakeBin, invocationLog };
}

function fakeClaudeEnvironment(commands, overrides = {}) {
  return {
    PATH: `${commands.fakeBin}:${process.env.PATH}`,
    FAKE_INVOCATION_LOG: commands.invocationLog,
    SMOKE_ANTHROPIC_API_KEY: credential,
    SMOKE_OPENAI_API_KEY: "unselected-openai-secret",
    ANTHROPIC_API_KEY: "unselected-anthropic-provider-secret",
    OPENAI_API_KEY: "unselected-openai-provider-secret",
    TAS_SMOKE_MODEL: "caller-selected-model-is-ignored",
    ...overrides,
  };
}

function copyStaged(source) {
  const destination = join(temporaryDirectory("tas-marketplace-staged-copy-"), "staged");
  cpSync(source, destination, { recursive: true });
  return destination;
}

function readReceipt(directory) {
  return JSON.parse(readFileSync(join(directory, "native-evidence.json"), "utf8"));
}

function writeReceipt(directory, receipt) {
  writeFileSync(join(directory, "native-evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

{
  const { repository, sha, executable } = createClaudeRepository();
  writeFileSync(executable, `#!/bin/sh\nprintf '${credential}\\n'\n`);
  writeFileSync(join(repository, "untracked-secret"), `${credential}\n`);

  const output = join(temporaryDirectory("tas-marketplace-output-parent-"), "staged");
  const recordingGit = createRecordingGit();
  const staged = run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--output",
      output,
    ],
    {
      cwd: repository,
      env: {
        PATH: `${recordingGit.fakeBin}:${process.env.PATH}`,
        SMOKE_ANTHROPIC_API_KEY: credential,
      },
    },
  );

  assert.equal(
    staged.stdout,
    `marketplace_verification=staged\nartifact=claude\nsha=${sha}\npredecessor_tag=\n`,
  );
  assert.equal(staged.stderr, "");
  const gitInvocations = readFileSync(recordingGit.invocationLog, "utf8").trim().split("\n");
  assert.equal(gitInvocations.filter((invocation) => invocation.startsWith("archive ")).length, 1);
  assert.ok(gitInvocations.every((invocation) => invocation.endsWith("|credential=")));
  assert.deepEqual(readdirSync(output).sort(), ["marketplace.tar", "native-evidence.json"]);

  const archive = join(output, "marketplace.tar");
  const receipt = JSON.parse(readFileSync(join(output, "native-evidence.json"), "utf8"));
  assert.deepEqual(receipt, {
    schema: 1,
    artifact: "claude",
    sha,
    marketplaceSha256: sha256(archive),
    predecessor: null,
    adapterEvidence: {},
  });

  const extracted = join(temporaryDirectory("tas-marketplace-extracted-"), "marketplace");
  mkdirSync(extracted);
  run("tar", ["-xf", archive, "-C", extracted]);
  assert.equal(
    readFileSync(join(extracted, "packages/claude/bin/tmux-agents-status-hook"), "utf8"),
    "#!/bin/sh\nprintf 'candidate hook\\n'\n",
  );
  assert.equal(
    statSync(join(extracted, "packages/claude/bin/tmux-agents-status-hook")).mode & 0o777,
    0o755,
  );
  const archivedPaths = run("tar", ["-tf", archive]).stdout.split("\n").filter(Boolean);
  assert.ok(
    archivedPaths.every(
      (path) => path === ".claude-plugin/" || path.startsWith(".claude-plugin/") ||
        path === "packages/" || path === "packages/claude/" || path.startsWith("packages/claude/"),
    ),
  );
  assert.doesNotMatch(readFileSync(archive).toString("utf8"), new RegExp(credential));
  assert.doesNotMatch(readFileSync(join(output, "native-evidence.json"), "utf8"), new RegExp(credential));
}

{
  const { repository, sha } = createClaudeRepository({ withPredecessor: true });
  const output = join(temporaryDirectory("tas-marketplace-predecessor-output-"), "staged");
  const staged = run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--previous-tag",
      "claude-v0.9.0",
      "--output",
      output,
    ],
    { cwd: repository },
  );

  assert.equal(
    staged.stdout,
    `marketplace_verification=staged\nartifact=claude\nsha=${sha}\n` +
      "predecessor_tag=claude-v0.9.0\n",
  );
  assert.deepEqual(readdirSync(output).sort(), [
    "marketplace.tar",
    "native-evidence.json",
    "previous.tar",
  ]);
  const predecessorArchive = join(output, "previous.tar");
  const receipt = JSON.parse(readFileSync(join(output, "native-evidence.json"), "utf8"));
  assert.deepEqual(receipt.predecessor, {
    tag: "claude-v0.9.0",
    marketplaceSha256: sha256(predecessorArchive),
  });

  const extracted = join(temporaryDirectory("tas-marketplace-previous-extracted-"), "marketplace");
  mkdirSync(extracted);
  run("tar", ["-xf", predecessorArchive, "-C", extracted]);
  const previousExecutable = join(extracted, "packages/claude/bin/tmux-agents-status-hook");
  assert.equal(readFileSync(previousExecutable, "utf8"), "#!/bin/sh\nprintf 'predecessor hook\\n'\n");
  assert.equal(statSync(previousExecutable).mode & 0o777, 0o755);
}

{
  const { repository, sha } = createClaudeRepository();
  const output = join(temporaryDirectory("tas-marketplace-smoke-stage-"), "staged");
  run(
    process.execPath,
    [verification, "stage", "--artifact", "claude", "--sha", sha, "--output", output],
    { cwd: repository },
  );

  const fakeBin = temporaryDirectory("tas-marketplace-fake-bin-");
  const invocationLog = join(fakeBin, "invocations");
  writeFileSync(invocationLog, "");
  writeFileSync(
    join(fakeBin, "tar"),
    `#!/bin/sh
set -eu
invocation_log=${shellQuote(invocationLog)}
system_path=${shellQuote(process.env.PATH)}
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${ANTHROPIC_API_KEY-}" ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_API_KEY-}" ]
printf 'unpack|%s\\n' "$*" >>"$invocation_log"
PATH=$system_path
export PATH
exec tar "$@"
`,
  );
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh
set -eu
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
printf 'install|%s|anthropic=%s|openai=%s\\n' \
  "$*" "\${ANTHROPIC_API_KEY:+set}" "\${OPENAI_API_KEY:+set}" >>"$FAKE_INVOCATION_LOG"
`,
  );
  writeFileSync(
    join(fakeBin, "sh"),
    `#!/bin/sh
set -eu
[ "$ANTHROPIC_API_KEY" = ${shellQuote(credential)} ]
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_API_KEY-}" ]
[ "$TAS_SMOKE_MODEL" = claude-haiku-4-5 ]
[ "$#" -eq 2 ]
[ -x "$2/packages/claude/bin/tmux-agents-status-hook" ]
printf 'smoke|%s|candidate=%s|previous=|model=%s\\n' \
  "$1" "$2" "$TAS_SMOKE_MODEL" >>"$FAKE_INVOCATION_LOG"
printf 'ok - fake Claude native smoke\\n'
`,
  );
  for (const command of ["tar", "npm", "sh"]) chmodSync(join(fakeBin, command), 0o755);

  const smoked = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--staged",
      output,
      "--update",
      "true",
    ],
    {
      cwd: root,
      env: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_INVOCATION_LOG: invocationLog,
        FAKE_SYSTEM_PATH: process.env.PATH,
        SMOKE_ANTHROPIC_API_KEY: credential,
        SMOKE_OPENAI_API_KEY: "unselected-openai-secret",
        ANTHROPIC_API_KEY: "unselected-anthropic-provider-secret",
        OPENAI_API_KEY: "unselected-openai-provider-secret",
        TAS_SMOKE_MODEL: "caller-selected-model-is-ignored",
      },
    },
  );

  assert.equal(
    smoked.stdout,
    "ok - fake Claude native smoke\nmarketplace_verification=passed\n",
  );
  assert.equal(smoked.stderr, "");
  const invocations = readFileSync(invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 3);
  assert.match(invocations[0], /^unpack\|/);
  assert.equal(invocations[1], "install|install --global @anthropic-ai/claude-code|anthropic=|openai=");
  assert.match(invocations[2], /^smoke\|.*test\/smoke-claude\.sh\|candidate=.*\|previous=\|model=claude-haiku-4-5$/);
  for (const secret of [
    credential,
    "unselected-openai-secret",
    "unselected-anthropic-provider-secret",
    "unselected-openai-provider-secret",
  ]) {
    assert.doesNotMatch(`${smoked.stdout}${smoked.stderr}${invocations.join("\n")}`, new RegExp(secret));
  }
}

{
  const { repository, sha } = createClaudeRepository({ withPredecessor: true });
  const output = join(temporaryDirectory("tas-marketplace-update-stage-"), "staged");
  run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--previous-tag",
      "claude-v0.9.0",
      "--output",
      output,
    ],
    { cwd: repository },
  );

  const updateCommands = createFakeClaudeCommands();
  const updated = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--staged",
      output,
      "--update",
      "true",
    ],
    { cwd: root, env: fakeClaudeEnvironment(updateCommands) },
  );
  assert.match(updated.stdout, /marketplace_verification=passed/);
  const updateInvocations = readFileSync(updateCommands.invocationLog, "utf8").trim().split("\n");
  assert.equal(updateInvocations.length, 4);
  assert.match(updateInvocations[0], /^unpack\|.*marketplace\.tar/);
  assert.match(updateInvocations[1], /^unpack\|.*previous\.tar/);
  assert.match(updateInvocations[2], /^install\|/);
  assert.match(updateInvocations[3], /^smoke\|.*\|previous=.+\|model=claude-haiku-4-5$/);

  const candidateOnlyCommands = createFakeClaudeCommands();
  const candidateOnly = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--staged",
      output,
      "--update",
      "false",
    ],
    { cwd: root, env: fakeClaudeEnvironment(candidateOnlyCommands) },
  );
  assert.match(candidateOnly.stdout, /marketplace_verification=passed/);
  const candidateOnlyInvocations = readFileSync(
    candidateOnlyCommands.invocationLog,
    "utf8",
  ).trim().split("\n");
  assert.equal(candidateOnlyInvocations.length, 3);
  assert.match(candidateOnlyInvocations[0], /^unpack\|.*marketplace\.tar/);
  assert.match(candidateOnlyInvocations[1], /^install\|/);
  assert.match(candidateOnlyInvocations[2], /^smoke\|.*\|previous=\|model=claude-haiku-4-5$/);
}

{
  const { repository, sha, previousSha } = createClaudeRepository({ withPredecessor: true });
  git(repository, "tag", "-a", "claude-v0.8.0", "-m", "annotated", previousSha);
  const outputParent = temporaryDirectory("tas-marketplace-rejected-stage-");
  const validBase = [
    verification,
    "stage",
    "--artifact",
    "claude",
    "--sha",
    sha,
    "--output",
    join(outputParent, "valid-shape"),
  ];
  const rejectedArguments = [
    ["unknown operation", [verification, "inspect", ...validBase.slice(2)]],
    ["unknown artifact", validBase.map((value) => value === "claude" ? "other" : value)],
    ["unknown option", [...validBase, "--dry-run", "true"]],
    ["repeated option", [...validBase, "--sha", sha]],
    ["malformed SHA", validBase.map((value) => value === sha ? "a".repeat(39) : value)],
    ["missing option value", [...validBase.slice(0, -1)]],
    [
      "cross-artifact predecessor",
      [...validBase, "--previous-tag", "codex-v0.9.0"],
    ],
    [
      "revision expression predecessor",
      [...validBase, "--previous-tag", "claude-v0.9.0^{commit}"],
    ],
    [
      "missing predecessor",
      [...validBase, "--previous-tag", "claude-v0.7.0"],
    ],
    [
      "annotated predecessor",
      [...validBase, "--previous-tag", "claude-v0.8.0"],
    ],
  ];
  for (const [label, args] of rejectedArguments) {
    const rejected = run(process.execPath, args, {
      cwd: repository,
      env: { SMOKE_ANTHROPIC_API_KEY: credential },
      expectFailure: true,
    });
    assert.equal(rejected.stdout, "", label);
    assert.match(rejected.stderr, /^marketplace verification rejected: /, label);
    assert.doesNotMatch(rejected.stderr, new RegExp(credential), label);
  }

  const occupiedOutput = join(outputParent, "occupied");
  mkdirSync(occupiedOutput);
  writeFileSync(join(occupiedOutput, "extra"), "unexpected\n");
  const occupied = run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--output",
      occupiedOutput,
    ],
    { cwd: repository, expectFailure: true },
  );
  assert.match(occupied.stderr, /--output must be absent/);
  assert.deepEqual(readdirSync(occupiedOutput), ["extra"]);

  for (const [label, populate] of [
    ["created-during-archive", false],
    ["populated-during-archive", true],
  ]) {
    const racedOutput = join(outputParent, label);
    const racingGit = createDestinationRacingGit(racedOutput, populate);
    const raced = run(
      process.execPath,
      [
        verification,
        "stage",
        "--artifact",
        "claude",
        "--sha",
        sha,
        "--output",
        racedOutput,
      ],
      {
        cwd: repository,
        env: { PATH: `${racingGit}:${process.env.PATH}` },
        expectFailure: true,
      },
    );
    assert.match(raced.stderr, /output.*(?:absent|conflict)/i, label);
    assert.equal(existsSync(racedOutput), true, label);
    assert.deepEqual(
      readdirSync(racedOutput),
      populate ? ["concurrent-owner"] : [],
      label,
    );
    if (populate) {
      assert.equal(
        readFileSync(join(racedOutput, "concurrent-owner"), "utf8"),
        "created by concurrent publisher\n",
      );
    }
    assert.deepEqual(
      readdirSync(outputParent).filter((name) => name.startsWith(".marketplace-verification-")),
      [],
      label,
    );
  }

  const incompleteRepository = temporaryDirectory("tas-marketplace-incomplete-repository-");
  git(incompleteRepository, "init", "-q", "-b", "main");
  git(incompleteRepository, "config", "user.name", "Marketplace Verification Test");
  git(incompleteRepository, "config", "user.email", "marketplace-verification@example.invalid");
  writeFileSync(join(incompleteRepository, "README.md"), "# Missing marketplace\n");
  const incompleteSha = commit(incompleteRepository, "missing marketplace paths");
  const incompleteOutput = join(outputParent, "incomplete");
  run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "claude",
      "--sha",
      incompleteSha,
      "--output",
      incompleteOutput,
    ],
    { cwd: incompleteRepository, expectFailure: true },
  );
  assert.equal(existsSync(incompleteOutput), false);
}

{
  const { repository, sha } = createClaudeRepository({ withPredecessor: true });
  const firstVersion = join(temporaryDirectory("tas-marketplace-integrity-first-"), "staged");
  const withPredecessor = join(
    temporaryDirectory("tas-marketplace-integrity-previous-"),
    "staged",
  );
  run(
    process.execPath,
    [verification, "stage", "--artifact", "claude", "--sha", sha, "--output", firstVersion],
    { cwd: repository },
  );
  run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "claude",
      "--sha",
      sha,
      "--previous-tag",
      "claude-v0.9.0",
      "--output",
      withPredecessor,
    ],
    { cwd: repository },
  );

  const rejectBeforeExternalEffects = (source, label, mutate, update = true) => {
    const staged = copyStaged(source);
    mutate(staged);
    const commands = createFakeClaudeCommands();
    const rejected = run(
      process.execPath,
      [
        verification,
        "smoke",
        "--artifact",
        "claude",
        "--sha",
        sha,
        "--staged",
        staged,
        "--update",
        String(update),
      ],
      {
        cwd: root,
        env: fakeClaudeEnvironment(commands),
        expectFailure: true,
      },
    );
    assert.equal(readFileSync(commands.invocationLog, "utf8"), "", label);
    assert.equal(rejected.stdout, "", label);
    assert.match(rejected.stderr, /^marketplace verification rejected: /, label);
    assert.doesNotMatch(rejected.stderr, new RegExp(credential), label);
  };

  const firstVersionFailures = [
    ["malformed receipt", (directory) => writeFileSync(join(directory, "native-evidence.json"), "{")],
    ["missing receipt", (directory) => rmSync(join(directory, "native-evidence.json"))],
    ["missing candidate", (directory) => rmSync(join(directory, "marketplace.tar"))],
    ["tampered candidate", (directory) => appendFileSync(join(directory, "marketplace.tar"), credential)],
    ["extra staged file", (directory) => writeFileSync(join(directory, credential), "extra\n")],
    [
      "future schema",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.schema = 2;
        writeReceipt(directory, receipt);
      },
    ],
    [
      "missing field",
      (directory) => {
        const receipt = readReceipt(directory);
        delete receipt.sha;
        writeReceipt(directory, receipt);
      },
    ],
    [
      "extra field",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.credential = credential;
        writeReceipt(directory, receipt);
      },
    ],
    [
      "artifact mismatch",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.artifact = "codex";
        writeReceipt(directory, receipt);
      },
    ],
    [
      "SHA mismatch",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.sha = "a".repeat(40);
        writeReceipt(directory, receipt);
      },
    ],
    [
      "malformed digest",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.marketplaceSha256 = receipt.marketplaceSha256.toUpperCase();
        writeReceipt(directory, receipt);
      },
    ],
    [
      "nonempty Claude evidence",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.adapterEvidence = { credential };
        writeReceipt(directory, receipt);
      },
    ],
    [
      "undeclared predecessor",
      (directory) => cpSync(join(directory, "marketplace.tar"), join(directory, "previous.tar")),
    ],
  ];
  for (const [label, mutate] of firstVersionFailures) {
    rejectBeforeExternalEffects(firstVersion, label, mutate);
  }

  const predecessorFailures = [
    ["missing predecessor", (directory) => rmSync(join(directory, "previous.tar"))],
    ["tampered predecessor", (directory) => appendFileSync(join(directory, "previous.tar"), credential)],
    [
      "cross-artifact predecessor tag",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.predecessor.tag = "codex-v0.9.0";
        writeReceipt(directory, receipt);
      },
    ],
    [
      "malformed predecessor digest",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.predecessor.marketplaceSha256 = "0".repeat(63);
        writeReceipt(directory, receipt);
      },
    ],
    [
      "extra predecessor field",
      (directory) => {
        const receipt = readReceipt(directory);
        receipt.predecessor.credential = credential;
        writeReceipt(directory, receipt);
      },
    ],
  ];
  for (const [label, mutate] of predecessorFailures) {
    rejectBeforeExternalEffects(withPredecessor, label, mutate);
  }
  rejectBeforeExternalEffects(
    withPredecessor,
    "tampered predecessor without update",
    (directory) => appendFileSync(join(directory, "previous.tar"), credential),
    false,
  );
}

{
  const { repository, sha } = createClaudeRepository();
  const staged = join(temporaryDirectory("tas-marketplace-failure-stage-"), "staged");
  run(
    process.execPath,
    [verification, "stage", "--artifact", "claude", "--sha", sha, "--output", staged],
    { cwd: repository },
  );
  const smokeArguments = [
    verification,
    "smoke",
    "--artifact",
    "claude",
    "--sha",
    sha,
    "--staged",
    staged,
    "--update",
    "true",
  ];

  const malformedSmokeArguments = [
    [...smokeArguments, "--dry-run", "true"],
    [...smokeArguments, "--sha", sha],
    smokeArguments.slice(0, -1),
    smokeArguments.map((value) => value === sha ? sha.toUpperCase() : value),
  ];
  for (const args of malformedSmokeArguments) {
    const commands = createFakeClaudeCommands();
    const rejected = run(process.execPath, args, {
      cwd: root,
      env: fakeClaudeEnvironment(commands),
      expectFailure: true,
    });
    assert.equal(readFileSync(commands.invocationLog, "utf8"), "");
    assert.match(rejected.stderr, /^marketplace verification rejected: /);
  }

  for (const selectedCredential of ["", "   "]) {
    const commands = createFakeClaudeCommands();
    const rejected = run(process.execPath, smokeArguments, {
      cwd: root,
      env: fakeClaudeEnvironment(commands, {
        SMOKE_ANTHROPIC_API_KEY: selectedCredential,
        ANTHROPIC_API_KEY: credential,
      }),
      expectFailure: true,
    });
    const invocations = readFileSync(commands.invocationLog, "utf8");
    assert.match(invocations, /^unpack\|/);
    assert.doesNotMatch(invocations, /install\||smoke\|/);
    assert.match(rejected.stderr, /SMOKE_ANTHROPIC_API_KEY is required/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}${invocations}`, new RegExp(credential));
  }

  for (const update of ["yes", "TRUE", "1", ""]) {
    const commands = createFakeClaudeCommands();
    const rejected = run(
      process.execPath,
      smokeArguments.map((value, index) => index === smokeArguments.length - 1 ? update : value),
      {
        cwd: root,
        env: fakeClaudeEnvironment(commands),
        expectFailure: true,
      },
    );
    assert.equal(readFileSync(commands.invocationLog, "utf8"), "");
    assert.match(rejected.stderr, /--update must be exactly true or false/);
  }

  {
    const commands = createFakeClaudeCommands({ failTar: true });
    const rejected = run(process.execPath, smokeArguments, {
      cwd: root,
      env: fakeClaudeEnvironment(commands),
      expectFailure: true,
    });
    const invocations = readFileSync(commands.invocationLog, "utf8").trim().split("\n");
    assert.equal(invocations.length, 1);
    assert.match(invocations[0], /^unpack\|/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(credential));
  }

  {
    const commands = createFakeClaudeCommands();
    const rejected = run(process.execPath, smokeArguments, {
      cwd: root,
      env: fakeClaudeEnvironment(commands, { FAKE_FAIL_COMMAND: "npm" }),
      expectFailure: true,
    });
    const invocations = readFileSync(commands.invocationLog, "utf8").trim().split("\n");
    assert.equal(invocations.length, 2);
    assert.match(invocations[0], /^unpack\|/);
    assert.match(invocations[1], /^install\|/);
    assert.doesNotMatch(invocations.join("\n"), /smoke\|/);
    assert.match(rejected.stderr, /fake npm failed: \[REDACTED\]/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(credential));
  }

  {
    const commands = createFakeClaudeCommands();
    const rejected = run(process.execPath, smokeArguments, {
      cwd: root,
      env: fakeClaudeEnvironment(commands, { FAKE_FAIL_COMMAND: "smoke" }),
      expectFailure: true,
    });
    const invocations = readFileSync(commands.invocationLog, "utf8").trim().split("\n");
    assert.equal(invocations.length, 3);
    assert.match(invocations[0], /^unpack\|/);
    assert.match(invocations[1], /^install\|/);
    assert.match(invocations[2], /^smoke\|/);
    assert.match(rejected.stderr, /fake smoke failed: \[REDACTED\]/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(credential));
  }
}

console.log("ok - staged Claude marketplace verification contract");
