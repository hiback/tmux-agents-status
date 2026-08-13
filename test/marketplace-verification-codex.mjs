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
const credential = "ticket-02-openai-secret-value";
const candidateHooks = `${JSON.stringify({
  description: "Candidate Codex hooks",
  hooks: { Stop: [] },
}, null, 2)}\n`;
const candidateHook = "#!/bin/sh\nprintf 'candidate Codex hook\\n'\n";
const predecessorHooks = `${JSON.stringify({
  description: "Predecessor Codex hooks",
  hooks: { SessionEnd: [] },
}, null, 2)}\n`;
const predecessorHook = "#!/bin/sh\nprintf 'predecessor Codex hook\\n'\n";

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

function createCodexRepository(options = {}) {
  const repository = temporaryDirectory("tas-codex-marketplace-repository-");
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.name", "Marketplace Verification Test");
  git(repository, "config", "user.email", "marketplace-verification@example.invalid");

  writeJson(repository, ".agents/plugins/marketplace.json", {
    name: "tmux-agents-status",
    plugins: [{
      name: "tmux-agents-status",
      source: { source: "local", path: "./packages/codex" },
    }],
  });
  writeJson(repository, "packages/codex/.codex-plugin/plugin.json", {
    name: "tmux-agents-status",
    version: options.withPredecessor ? "0.9.0" : "1.0.0",
    hooks: "./hooks/hooks.json",
  });
  const hooks = join(repository, "packages/codex/hooks/hooks.json");
  mkdirSync(dirname(hooks), { recursive: true });
  writeFileSync(hooks, options.withPredecessor ? predecessorHooks : candidateHooks);
  const executable = join(repository, "packages/codex/bin/tmux-agents-status-hook");
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, options.withPredecessor ? predecessorHook : candidateHook);
  chmodSync(executable, 0o755);
  writeFileSync(join(repository, "README.md"), "# Not marketplace content\n");

  let previousSha;
  if (options.withPredecessor) {
    previousSha = commit(repository, "predecessor Codex marketplace");
    git(repository, "tag", "codex-v0.9.0");
    writeJson(repository, "packages/codex/.codex-plugin/plugin.json", {
      name: "tmux-agents-status",
      version: "1.0.0",
      hooks: "./hooks/hooks.json",
    });
    writeFileSync(hooks, candidateHooks);
    writeFileSync(executable, candidateHook);
  }

  const sha = commit(repository, "candidate Codex marketplace");
  git(repository, "tag", "codex-v1.0.0");
  return { executable, hooks, previousSha, repository, sha };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createArchiveMutatingGit(repository) {
  const fakeBin = temporaryDirectory("tas-codex-marketplace-mutating-git-");
  const executable = join(fakeBin, "git");
  const changedHooks = `${candidateHooks.trimEnd()}\n\n`;
  const changedHook = `${candidateHook}# changed after archive\n`;
  writeFileSync(
    executable,
    `#!/bin/sh
set -eu
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
system_path=${shellQuote(process.env.PATH)}
if [ "\${1-}" = archive ]; then
  PATH=$system_path git "$@"
  printf %s ${shellQuote(changedHooks)} >${shellQuote(join(repository, "packages/codex/hooks/hooks.json"))}
  printf %s ${shellQuote(changedHook)} >${shellQuote(join(repository, "packages/codex/bin/tmux-agents-status-hook"))}
  exit 0
fi
PATH=$system_path
export PATH
exec git "$@"
`,
  );
  chmodSync(executable, 0o755);
  return { changedHook, changedHooks, fakeBin };
}

function createFakeCodexCommands(evidence, options = {}) {
  const fakeBin = temporaryDirectory("tas-codex-marketplace-fake-bin-");
  const invocationLog = join(fakeBin, "invocations");
  writeFileSync(invocationLog, "");
  writeFileSync(
    join(fakeBin, "tar"),
    `#!/bin/sh
set -eu
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_BASE_URL-}" ]
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${ANTHROPIC_API_KEY-}" ]
[ -z "\${CREDENTIAL_ALIAS-}" ]
[ -z "\${TAS_CODEX_HOOKS_SHA256-}" ]
[ -z "\${TAS_CODEX_HOOK_SHA256-}" ]
system_path=${shellQuote(process.env.PATH)}
case "\${1-}" in
-xOf)
  printf 'inspect|%s\\n' "$*" >>${shellQuote(invocationLog)}
  ${options.failInspect ? "printf 'fake evidence inspection failed\\n' >&2\n  exit 70" : "PATH=$system_path\n  export PATH\n  exec tar \"$@\""}
  ;;
-xf)
  printf 'unpack|%s\\n' "$*" >>${shellQuote(invocationLog)}
  ${options.failTar ? "printf 'fake tar failed\\n' >&2\n  exit 71" : "PATH=$system_path\n  export PATH\n  exec tar \"$@\""}
  ;;
*)
  exit 69
  ;;
esac
`,
  );
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/bin/sh
set -eu
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_API_KEY-}" ]
[ -z "\${OPENAI_BASE_URL-}" ]
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${ANTHROPIC_API_KEY-}" ]
[ -z "\${ANTHROPIC_AUTH_TOKEN-}" ]
[ -z "\${CLAUDE_CODE_OAUTH_TOKEN-}" ]
[ -z "\${CREDENTIAL_ALIAS-}" ]
[ -z "\${NODE_AUTH_TOKEN-}" ]
[ -z "\${NPM_TOKEN-}" ]
printf 'install|%s|anthropic=%s|openai=%s\\n' \\
  "$*" "\${ANTHROPIC_API_KEY:+set}" "\${OPENAI_API_KEY:+set}" >>"$FAKE_INVOCATION_LOG"
if [ "\${FAKE_FAIL_COMMAND-}" = npm ]; then
  printf 'fake npm failed: ${credential}\\n' >&2
  exit 72
fi
`,
  );
  writeFileSync(
    join(fakeBin, "sh"),
    `#!/bin/sh
set -eu
[ "$OPENAI_API_KEY" = ${shellQuote(credential)} ]
[ -z "\${SMOKE_OPENAI_API_KEY-}" ]
[ -z "\${SMOKE_ANTHROPIC_API_KEY-}" ]
[ -z "\${OPENAI_BASE_URL-}" ]
[ -z "\${ANTHROPIC_API_KEY-}" ]
[ -z "\${ANTHROPIC_AUTH_TOKEN-}" ]
[ -z "\${CLAUDE_CODE_OAUTH_TOKEN-}" ]
[ -z "\${CREDENTIAL_ALIAS-}" ]
[ -z "\${NODE_AUTH_TOKEN-}" ]
[ -z "\${NPM_TOKEN-}" ]
[ "$TAS_SMOKE_MODEL" = gpt-5.6-luna ]
[ "$TAS_CODEX_HOOKS_SHA256" = ${shellQuote(evidence.hooksSha256)} ]
[ "$TAS_CODEX_HOOK_SHA256" = ${shellQuote(evidence.hookSha256)} ]
[ "$#" -eq ${options.expectPrevious ? 3 : 2} ]
[ -f "$2/.agents/plugins/marketplace.json" ]
[ -f "$2/packages/codex/hooks/hooks.json" ]
[ -x "$2/packages/codex/bin/tmux-agents-status-hook" ]
${options.expectPrevious ? "[ -f \"$3/packages/codex/hooks/hooks.json\" ]\n[ -x \"$3/packages/codex/bin/tmux-agents-status-hook\" ]\ngrep -qF 'predecessor Codex hook' \"$3/packages/codex/bin/tmux-agents-status-hook\"" : "[ -z \"\${3-}\" ]"}
printf 'smoke|%s|candidate=%s|previous=%s|model=%s|hooks=%s|hook=%s\\n' \\
  "$1" "$2" "\${3-}" "$TAS_SMOKE_MODEL" \\
  "$TAS_CODEX_HOOKS_SHA256" "$TAS_CODEX_HOOK_SHA256" >>"$FAKE_INVOCATION_LOG"
if [ "\${FAKE_FAIL_COMMAND-}" = smoke ]; then
  printf 'fake Codex smoke failed: ${credential}\\n' >&2
  exit 73
fi
printf 'ok - fake Codex native smoke\\n'
`,
  );
  for (const command of ["tar", "npm", "sh"]) chmodSync(join(fakeBin, command), 0o755);
  return { fakeBin, invocationLog };
}

function fakeCodexEnvironment(commands, overrides = {}) {
  return {
    PATH: `${commands.fakeBin}:${process.env.PATH}`,
    FAKE_INVOCATION_LOG: commands.invocationLog,
    SMOKE_OPENAI_API_KEY: credential,
    SMOKE_ANTHROPIC_API_KEY: "unselected-anthropic-secret",
    OPENAI_API_KEY: "unselected-openai-provider-secret",
    OPENAI_BASE_URL: "https://unselected-openai.invalid",
    ANTHROPIC_API_KEY: "unselected-anthropic-provider-secret",
    ANTHROPIC_AUTH_TOKEN: "unselected-anthropic-auth-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "unselected-claude-oauth-secret",
    CREDENTIAL_ALIAS: credential,
    NODE_AUTH_TOKEN: "unselected-node-token",
    NPM_TOKEN: "unselected-npm-token",
    TAS_CODEX_HOOKS_SHA256: "caller-hooks-digest-is-ignored",
    TAS_CODEX_HOOK_SHA256: "caller-hook-digest-is-ignored",
    TAS_SMOKE_MODEL: "caller-selected-model-is-ignored",
    ...overrides,
  };
}

function readReceipt(directory) {
  return JSON.parse(readFileSync(join(directory, "native-evidence.json"), "utf8"));
}

function writeReceipt(directory, receipt) {
  writeFileSync(join(directory, "native-evidence.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function copyStaged(source) {
  const destination = join(temporaryDirectory("tas-codex-marketplace-staged-copy-"), "staged");
  cpSync(source, destination, { recursive: true });
  return destination;
}

{
  const { repository, sha } = createCodexRepository();
  writeFileSync(join(repository, "untracked-secret"), `${credential}\n`);
  const output = join(temporaryDirectory("tas-codex-marketplace-stage-"), "staged");
  const staged = run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--output",
      output,
    ],
    { cwd: repository, env: { SMOKE_OPENAI_API_KEY: credential } },
  );

  assert.equal(
    staged.stdout,
    `marketplace_verification=staged\nartifact=codex\nsha=${sha}\npredecessor_tag=\n`,
  );
  assert.equal(staged.stderr, "");
  assert.deepEqual(readdirSync(output).sort(), ["marketplace.tar", "native-evidence.json"]);

  const archive = join(output, "marketplace.tar");
  const receipt = JSON.parse(readFileSync(join(output, "native-evidence.json"), "utf8"));
  assert.deepEqual(receipt, {
    schema: 1,
    artifact: "codex",
    sha,
    marketplaceSha256: sha256Bytes(readFileSync(archive)),
    predecessor: null,
    adapterEvidence: {
      hooksSha256: sha256Bytes(candidateHooks),
      hookSha256: sha256Bytes(candidateHook),
    },
  });

  const extracted = join(temporaryDirectory("tas-codex-marketplace-extracted-"), "marketplace");
  mkdirSync(extracted);
  run("tar", ["-xf", archive, "-C", extracted]);
  assert.equal(readFileSync(join(extracted, "packages/codex/hooks/hooks.json"), "utf8"), candidateHooks);
  assert.equal(
    readFileSync(join(extracted, "packages/codex/bin/tmux-agents-status-hook"), "utf8"),
    candidateHook,
  );
  assert.equal(
    statSync(join(extracted, "packages/codex/bin/tmux-agents-status-hook")).mode & 0o777,
    0o755,
  );
  const archivedPaths = run("tar", ["-tf", archive]).stdout.split("\n").filter(Boolean);
  assert.ok(
    archivedPaths.every(
      (path) => path === ".agents/" || path === ".agents/plugins/" ||
        path.startsWith(".agents/plugins/") || path === "packages/" ||
        path === "packages/codex/" || path.startsWith("packages/codex/"),
    ),
  );
  assert.doesNotMatch(readFileSync(archive).toString("utf8"), new RegExp(credential));
  assert.doesNotMatch(readFileSync(join(output, "native-evidence.json"), "utf8"), new RegExp(credential));
}

{
  const { hooks, executable, repository, sha } = createCodexRepository();
  const mutatingGit = createArchiveMutatingGit(repository);
  const output = join(temporaryDirectory("tas-codex-archive-bound-evidence-"), "staged");
  run(
    process.execPath,
    [verification, "stage", "--artifact", "codex", "--sha", sha, "--output", output],
    {
      cwd: repository,
      env: {
        PATH: `${mutatingGit.fakeBin}:${process.env.PATH}`,
        SMOKE_OPENAI_API_KEY: credential,
      },
    },
  );

  assert.equal(readFileSync(hooks, "utf8"), mutatingGit.changedHooks);
  assert.equal(readFileSync(executable, "utf8"), mutatingGit.changedHook);
  const receipt = JSON.parse(readFileSync(join(output, "native-evidence.json"), "utf8"));
  assert.deepEqual(receipt.adapterEvidence, {
    hooksSha256: sha256Bytes(candidateHooks),
    hookSha256: sha256Bytes(candidateHook),
  });
  assert.notEqual(receipt.adapterEvidence.hooksSha256, sha256Bytes(mutatingGit.changedHooks));
  assert.notEqual(receipt.adapterEvidence.hookSha256, sha256Bytes(mutatingGit.changedHook));
}

{
  const { repository, sha } = createCodexRepository();
  const output = join(temporaryDirectory("tas-codex-marketplace-evidence-failure-"), "staged");
  const commands = createFakeCodexCommands({
    hooksSha256: "0".repeat(64),
    hookSha256: "0".repeat(64),
  }, { failInspect: true });
  const rejected = run(
    process.execPath,
    [verification, "stage", "--artifact", "codex", "--sha", sha, "--output", output],
    {
      cwd: repository,
      env: {
        PATH: `${commands.fakeBin}:${process.env.PATH}`,
        SMOKE_OPENAI_API_KEY: credential,
      },
      expectFailure: true,
    },
  );
  assert.equal(existsSync(output), false);
  assert.match(readFileSync(commands.invocationLog, "utf8"), /^inspect\|/);
  assert.doesNotMatch(readFileSync(commands.invocationLog, "utf8"), /^(?:unpack|install|smoke)\|/m);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /fake evidence inspection failed/);
  assert.doesNotMatch(rejected.stderr, new RegExp(credential));
}

{
  const { repository, sha } = createCodexRepository();
  const output = join(temporaryDirectory("tas-codex-marketplace-smoke-"), "staged");
  run(
    process.execPath,
    [verification, "stage", "--artifact", "codex", "--sha", sha, "--output", output],
    { cwd: repository },
  );
  const evidence = readReceipt(output).adapterEvidence;
  const commands = createFakeCodexCommands(evidence);
  const smoked = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--staged",
      output,
      "--update",
      "true",
    ],
    { cwd: root, env: fakeCodexEnvironment(commands) },
  );

  assert.equal(smoked.stdout, "ok - fake Codex native smoke\nmarketplace_verification=passed\n");
  assert.equal(smoked.stderr, "");
  const invocations = readFileSync(commands.invocationLog, "utf8").trim().split("\n");
  assert.equal(invocations.length, 5);
  assert.match(invocations[0], /^inspect\|.*packages\/codex\/hooks\/hooks\.json$/);
  assert.match(invocations[1], /^inspect\|.*packages\/codex\/bin\/tmux-agents-status-hook$/);
  assert.match(invocations[2], /^unpack\|.*marketplace\.tar/);
  assert.equal(invocations[3], "install|install --global @openai/codex|anthropic=|openai=");
  assert.match(
    invocations[4],
    new RegExp(
      `^smoke\\|.*test/smoke-codex\\.sh\\|candidate=.*\\|previous=\\|` +
        `model=gpt-5\\.6-luna\\|hooks=${evidence.hooksSha256}\\|hook=${evidence.hookSha256}$`,
    ),
  );
  for (const secret of [
    credential,
    "unselected-anthropic-secret",
    "unselected-openai-provider-secret",
    "unselected-anthropic-provider-secret",
    "unselected-anthropic-auth-secret",
    "unselected-claude-oauth-secret",
    "unselected-node-token",
    "unselected-npm-token",
  ]) {
    assert.doesNotMatch(
      `${smoked.stdout}${smoked.stderr}${invocations.join("\n")}`,
      new RegExp(secret),
    );
  }
}

{
  const { repository, sha } = createCodexRepository({ withPredecessor: true });
  const output = join(temporaryDirectory("tas-codex-marketplace-update-"), "staged");
  run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--previous-tag",
      "codex-v0.9.0",
      "--output",
      output,
    ],
    { cwd: repository },
  );
  const evidence = readReceipt(output).adapterEvidence;

  const updateCommands = createFakeCodexCommands(evidence, { expectPrevious: true });
  const updated = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--staged",
      output,
      "--update",
      "true",
    ],
    { cwd: root, env: fakeCodexEnvironment(updateCommands) },
  );
  assert.match(updated.stdout, /marketplace_verification=passed/);
  const updateInvocations = readFileSync(updateCommands.invocationLog, "utf8").trim().split("\n");
  assert.equal(updateInvocations.length, 6);
  assert.match(updateInvocations[0], /^inspect\|/);
  assert.match(updateInvocations[1], /^inspect\|/);
  assert.match(updateInvocations[2], /^unpack\|.*marketplace\.tar/);
  assert.match(updateInvocations[3], /^unpack\|.*previous\.tar/);
  assert.match(updateInvocations[4], /^install\|install --global @openai\/codex/);
  assert.match(updateInvocations[5], /^smoke\|.*\|previous=.+\|model=gpt-5\.6-luna\|/);

  const candidateOnlyCommands = createFakeCodexCommands(evidence);
  const candidateOnly = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--staged",
      output,
      "--update",
      "false",
    ],
    { cwd: root, env: fakeCodexEnvironment(candidateOnlyCommands) },
  );
  assert.match(candidateOnly.stdout, /marketplace_verification=passed/);
  const candidateOnlyInvocations = readFileSync(
    candidateOnlyCommands.invocationLog,
    "utf8",
  ).trim().split("\n");
  assert.equal(candidateOnlyInvocations.length, 5);
  assert.match(candidateOnlyInvocations[0], /^inspect\|/);
  assert.match(candidateOnlyInvocations[1], /^inspect\|/);
  assert.match(candidateOnlyInvocations[2], /^unpack\|.*marketplace\.tar/);
  assert.match(candidateOnlyInvocations[3], /^install\|/);
  assert.match(candidateOnlyInvocations[4], /^smoke\|.*\|previous=\|model=gpt-5\.6-luna\|/);
  assert.doesNotMatch(candidateOnlyInvocations.join("\n"), /unpack\|.*previous\.tar/);

  const tampered = copyStaged(output);
  appendFileSync(join(tampered, "previous.tar"), credential);
  const tamperedCommands = createFakeCodexCommands(evidence);
  const rejected = run(
    process.execPath,
    [
      verification,
      "smoke",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--staged",
      tampered,
      "--update",
      "false",
    ],
    {
      cwd: root,
      env: fakeCodexEnvironment(tamperedCommands),
      expectFailure: true,
    },
  );
  assert.equal(readFileSync(tamperedCommands.invocationLog, "utf8"), "");
  assert.match(rejected.stderr, /predecessor marketplace archive digest does not match/);
  assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(credential));
}

{
  const { repository, sha } = createCodexRepository();
  const output = join(temporaryDirectory("tas-codex-marketplace-evidence-"), "staged");
  run(
    process.execPath,
    [verification, "stage", "--artifact", "codex", "--sha", sha, "--output", output],
    { cwd: repository },
  );
  const validEvidence = readReceipt(output).adapterEvidence;
  const evidenceFailures = [
    [
      "missing hook definition digest",
      (receipt) => delete receipt.adapterEvidence.hooksSha256,
      false,
    ],
    [
      "extra native evidence",
      (receipt) => {
        receipt.adapterEvidence.credential = credential;
      },
      false,
    ],
    [
      "malformed executable digest",
      (receipt) => {
        receipt.adapterEvidence.hookSha256 = receipt.adapterEvidence.hookSha256.toUpperCase();
      },
      false,
    ],
    [
      "non-object native evidence",
      (receipt) => {
        receipt.adapterEvidence = null;
      },
      false,
    ],
    [
      "mismatched hook definition digest",
      (receipt) => {
        receipt.adapterEvidence.hooksSha256 = "0".repeat(64);
      },
      true,
    ],
    [
      "mismatched hook executable digest",
      (receipt) => {
        receipt.adapterEvidence.hookSha256 = "f".repeat(64);
      },
      true,
    ],
    [
      "Claude native evidence",
      (receipt) => {
        receipt.adapterEvidence = {};
      },
      false,
    ],
    [
      "cross-artifact receipt",
      (receipt) => {
        receipt.artifact = "claude";
      },
      false,
    ],
  ];

  for (const [label, mutate, inspectsArchive] of evidenceFailures) {
    const staged = copyStaged(output);
    const receipt = readReceipt(staged);
    mutate(receipt);
    writeReceipt(staged, receipt);
    const commands = createFakeCodexCommands(validEvidence);
    const rejected = run(
      process.execPath,
      [
        verification,
        "smoke",
        "--artifact",
        "codex",
        "--sha",
        sha,
        "--staged",
        staged,
        "--update",
        "false",
      ],
      {
        cwd: root,
        env: fakeCodexEnvironment(commands),
        expectFailure: true,
      },
    );
    const invocations = readFileSync(commands.invocationLog, "utf8").trim();
    if (inspectsArchive) {
      assert.equal(invocations.split("\n").length, 2, label);
      assert.match(invocations, /^inspect\|/m, label);
    } else {
      assert.equal(invocations, "", label);
    }
    assert.doesNotMatch(invocations, /^(?:unpack|install|smoke)\|/m, label);
    assert.equal(rejected.stdout, "", label);
    assert.match(rejected.stderr, /^marketplace verification rejected: /, label);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}${invocations}`, new RegExp(credential), label);
  }
}

{
  const { repository, sha } = createCodexRepository();
  const output = join(temporaryDirectory("tas-codex-marketplace-failures-"), "staged");
  run(
    process.execPath,
    [verification, "stage", "--artifact", "codex", "--sha", sha, "--output", output],
    { cwd: repository },
  );
  const evidence = readReceipt(output).adapterEvidence;
  const smokeArguments = [
    verification,
    "smoke",
    "--artifact",
    "codex",
    "--sha",
    sha,
    "--staged",
    output,
    "--update",
    "true",
  ];

  for (const selectedCredential of ["", "   "]) {
    const commands = createFakeCodexCommands(evidence);
    const rejected = run(process.execPath, smokeArguments, {
      cwd: root,
      env: fakeCodexEnvironment(commands, {
        SMOKE_OPENAI_API_KEY: selectedCredential,
        OPENAI_API_KEY: credential,
      }),
      expectFailure: true,
    });
    const invocations = readFileSync(commands.invocationLog, "utf8").trim().split("\n");
    assert.equal(invocations.length, 3);
    assert.match(invocations[0], /^inspect\|/);
    assert.match(invocations[1], /^inspect\|/);
    assert.match(invocations[2], /^unpack\|/);
    assert.doesNotMatch(invocations.join("\n"), /^(?:install|smoke)\|/m);
    assert.match(rejected.stderr, /SMOKE_OPENAI_API_KEY is required/);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}${invocations.join("\n")}`, new RegExp(credential));
  }

  const externalFailures = [
    [
      "evidence inspection",
      { failInspect: true },
      {},
      1,
      /^inspect\|/,
      /fake evidence inspection failed/,
    ],
    ["archive unpack", { failTar: true }, {}, 3, /^unpack\|/, /fake tar failed/],
    ["native install", {}, { FAKE_FAIL_COMMAND: "npm" }, 4, /^install\|/, /fake npm failed: \[REDACTED\]/],
    ["native smoke", {}, { FAKE_FAIL_COMMAND: "smoke" }, 5, /^smoke\|/, /fake Codex smoke failed: \[REDACTED\]/],
  ];
  for (const [label, commandOptions, environment, count, finalPattern, errorPattern] of externalFailures) {
    const commands = createFakeCodexCommands(evidence, commandOptions);
    const rejected = run(process.execPath, smokeArguments, {
      cwd: root,
      env: fakeCodexEnvironment(commands, environment),
      expectFailure: true,
    });
    const invocations = readFileSync(commands.invocationLog, "utf8").trim().split("\n");
    assert.equal(invocations.length, count, label);
    assert.match(invocations.at(-1), finalPattern, label);
    assert.match(rejected.stderr, errorPattern, label);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}${invocations.join("\n")}`, new RegExp(credential), label);
  }
}

{
  const { previousSha, repository, sha } = createCodexRepository({ withPredecessor: true });
  git(repository, "tag", "-a", "codex-v0.8.0", "-m", "annotated", previousSha);
  const outputParent = temporaryDirectory("tas-codex-marketplace-predecessor-");
  const output = join(outputParent, "staged");
  const staged = run(
    process.execPath,
    [
      verification,
      "stage",
      "--artifact",
      "codex",
      "--sha",
      sha,
      "--previous-tag",
      "codex-v0.9.0",
      "--output",
      output,
    ],
    { cwd: repository },
  );

  assert.equal(
    staged.stdout,
    `marketplace_verification=staged\nartifact=codex\nsha=${sha}\n` +
      "predecessor_tag=codex-v0.9.0\n",
  );
  assert.deepEqual(readdirSync(output).sort(), [
    "marketplace.tar",
    "native-evidence.json",
    "previous.tar",
  ]);
  const previousArchive = join(output, "previous.tar");
  const receipt = JSON.parse(readFileSync(join(output, "native-evidence.json"), "utf8"));
  assert.deepEqual(receipt.predecessor, {
    tag: "codex-v0.9.0",
    marketplaceSha256: sha256Bytes(readFileSync(previousArchive)),
  });
  assert.deepEqual(receipt.adapterEvidence, {
    hooksSha256: sha256Bytes(candidateHooks),
    hookSha256: sha256Bytes(candidateHook),
  });

  const extracted = join(temporaryDirectory("tas-codex-marketplace-previous-"), "marketplace");
  mkdirSync(extracted);
  run("tar", ["-xf", previousArchive, "-C", extracted]);
  assert.equal(readFileSync(join(extracted, "packages/codex/hooks/hooks.json"), "utf8"), predecessorHooks);
  const previousExecutable = join(extracted, "packages/codex/bin/tmux-agents-status-hook");
  assert.equal(readFileSync(previousExecutable, "utf8"), predecessorHook);
  assert.equal(statSync(previousExecutable).mode & 0o777, 0o755);

  for (const [label, tag] of [
    ["cross-artifact", "claude-v0.9.0"],
    ["noncanonical version", "codex-v00.9.0"],
    ["revision expression", "codex-v0.9.0^{commit}"],
    ["annotated tag", "codex-v0.8.0"],
  ]) {
    const rejectedOutput = join(outputParent, label.replaceAll(" ", "-"));
    const rejected = run(
      process.execPath,
      [
        verification,
        "stage",
        "--artifact",
        "codex",
        "--sha",
        sha,
        "--previous-tag",
        tag,
        "--output",
        rejectedOutput,
      ],
      { cwd: repository, expectFailure: true },
    );
    assert.equal(rejected.stdout, "", label);
    assert.match(rejected.stderr, /^marketplace verification rejected: /, label);
    assert.equal(existsSync(rejectedOutput), false, label);
  }
}

console.log("ok - staged Codex marketplace verification contract");
