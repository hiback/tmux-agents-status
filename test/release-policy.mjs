import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = join(root, "scripts", "release-policy.mjs");
const temporaryRoots = [];

const artifacts = {
  pi: {
    manifest: "packages/pi/package.json",
    shipped: "packages/pi/index.ts",
    lock: true,
  },
  opencode: {
    manifest: "packages/opencode/package.json",
    shipped: "packages/opencode/tmux-agents-status.ts",
    lock: true,
  },
  claude: {
    manifest: "packages/claude/.claude-plugin/plugin.json",
    shipped: "packages/claude/bin/tmux-agents-status-hook",
  },
  codex: {
    manifest: "packages/codex/.codex-plugin/plugin.json",
    shipped: "packages/codex/bin/tmux-agents-status-hook",
  },
};

process.on("exit", () => {
  for (const directory of temporaryRoots) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

function initialLock(version = "1.0.0") {
  return {
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": { workspaces: ["packages/*"] },
      "packages/pi": { name: "fixture-pi", version },
      "packages/opencode": { name: "fixture-opencode", version },
    },
  };
}

function createRepository(version = "1.0.0") {
  const repository = mkdtempSync(join(tmpdir(), "tas-release-policy-"));
  temporaryRoots.push(repository);
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.name", "Release Policy Test");
  git(repository, "config", "user.email", "release-policy@example.invalid");

  for (const [artifact, details] of Object.entries(artifacts)) {
    writeJson(repository, details.manifest, {
      name: `fixture-${artifact}`,
      version,
    });
    const shipped = join(repository, details.shipped);
    mkdirSync(dirname(shipped), { recursive: true });
    writeFileSync(shipped, `// ${artifact} fixture\n`);
  }
  writeJson(repository, ".claude-plugin/marketplace.json", { plugins: [] });
  writeJson(repository, ".agents/plugins/marketplace.json", { plugins: [] });
  writeJson(repository, "package-lock.json", initialLock(version));
  writeFileSync(join(repository, "README.md"), "# Fixture\n");
  mkdirSync(join(repository, "docs", "agents"), { recursive: true });
  writeFileSync(join(repository, "docs", "agents", "release.md"), "# Release\n");
  mkdirSync(join(repository, "test"), { recursive: true });
  writeFileSync(join(repository, "test", "fixture.sh"), "#!/bin/sh\n");
  mkdirSync(join(repository, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repository, ".github", "workflows", "ci.yml"), "name: CI\n");

  commit(repository, "initial fixture");
  return repository;
}

function commit(repository, message) {
  git(repository, "add", "--all");
  git(repository, "commit", "-q", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function append(repository, path, text = "changed\n") {
  const absolute = join(repository, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${readFileSync(absolute, "utf8")}${text}`);
}

function setVersion(repository, artifact, version, syncLock = true) {
  const manifestPath = artifacts[artifact].manifest;
  const manifest = JSON.parse(readFileSync(join(repository, manifestPath), "utf8"));
  manifest.version = version;
  writeJson(repository, manifestPath, manifest);

  if (artifacts[artifact].lock && syncLock) {
    const lockPath = join(repository, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages[`packages/${artifact}`].version = version;
    writeJson(repository, "package-lock.json", lock);
  }
}

function checkChanges(repository, base, options = {}) {
  const arguments_ = [
    policy,
    "check-changes",
    "--repo",
    repository,
    "--base",
    base,
    "--head",
    "HEAD",
  ];
  if (options.registryVersions) {
    arguments_.push("--registry-versions", options.registryVersions);
  }
  return run(process.execPath, arguments_, { expectFailure: options.expectFailure });
}

function checkArtifact(repository, artifact, tag, options = {}) {
  const arguments_ = [
    policy,
    "check-artifact",
    "--repo",
    repository,
    "--artifact",
    artifact,
    "--tag",
    tag,
    "--head",
    "HEAD",
  ];
  if (options.registryVersions) {
    arguments_.push("--registry-versions", options.registryVersions);
  }
  return run(process.execPath, arguments_, { expectFailure: options.expectFailure });
}

function createFakeCommands() {
  const directory = mkdtempSync(join(tmpdir(), "tas-release-policy-bin-"));
  temporaryRoots.push(directory);
  const npm = join(directory, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_NPM_LOG"
[ "$1" = view ] || { echo 'fake npm permits view only' >&2; exit 90; }
case "$FAKE_NPM_RESPONSE" in
  absent)
    echo 'npm error code E404' >&2
    exit 1
    ;;
  existing)
    printf '"%s"\\n' "$FAKE_NPM_INTEGRITY"
    ;;
  empty)
    printf '\\n'
    ;;
  error)
    echo 'npm error code ENETWORK' >&2
    exit 1
    ;;
  *)
    echo 'unknown fake npm response' >&2
    exit 91
    ;;
esac
`,
  );
  chmodSync(npm, 0o755);

  const gh = join(directory, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_GH_LOG"
count=0
[ ! -f "$FAKE_GH_STATE" ] || count=$(cat "$FAKE_GH_STATE")
count=$((count + 1))
printf '%s\\n' "$count" >"$FAKE_GH_STATE"
response="$FAKE_GH_RESPONSES/$count.json"
[ -f "$response" ] || response="$FAKE_GH_RESPONSES/last.json"
cat "$response"
`,
  );
  chmodSync(gh, 0o755);
  return directory;
}

function checkNpmArtifact(fakeBin, response, options = {}) {
  const log = join(fakeBin, `npm-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(log, "");
  const candidateIntegrity = options.candidateIntegrity ?? "sha512-Y2FuZGlkYXRl";
  const result = run(
    process.execPath,
    [
      policy,
      "check-npm-artifact",
      "--package",
      "fixture-package",
      "--version",
      "1.2.3",
      "--integrity",
      candidateIntegrity,
    ],
    {
      expectFailure: options.expectFailure,
      env: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        FAKE_NPM_LOG: log,
        FAKE_NPM_RESPONSE: response,
        FAKE_NPM_INTEGRITY: options.existingIntegrity ?? candidateIntegrity,
        NPM_TOKEN: options.token ?? "",
        NODE_AUTH_TOKEN: "",
      },
    },
  );
  return { result, log: readFileSync(log, "utf8") };
}

function ciRun(overrides = {}) {
  return {
    id: 4242,
    html_url: "https://github.example/runs/4242",
    event: "push",
    head_branch: "main",
    head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function proveMainCi(fakeBin, responses, options = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "tas-ci-proof-"));
  temporaryRoots.push(fixture);
  const responseDirectory = join(fixture, "responses");
  mkdirSync(responseDirectory);
  responses.forEach((response, index) => {
    writeFileSync(join(responseDirectory, `${index + 1}.json`), `${JSON.stringify(response)}\n`);
  });
  writeFileSync(join(responseDirectory, "last.json"), `${JSON.stringify(responses.at(-1))}\n`);
  const state = join(fixture, "state");
  const log = join(fixture, "gh.log");
  writeFileSync(log, "");

  const arguments_ = [
    policy,
    "prove-main-ci",
    "--repository",
    "hiback/tmux-agents-status",
    "--sha",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "--workflow",
    "ci.yml",
  ];
  for (const [name, value] of [
    ["visibility-timeout-seconds", options.visibilityTimeout],
    ["poll-interval-seconds", options.pollInterval],
    ["total-timeout-seconds", options.totalTimeout],
  ]) {
    if (value !== undefined) arguments_.push(`--${name}`, String(value));
  }

  const result = run(process.execPath, arguments_, {
    expectFailure: options.expectFailure,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: state,
      FAKE_GH_RESPONSES: responseDirectory,
      GH_TOKEN: "fake-token",
    },
  });
  return {
    result,
    log: readFileSync(log, "utf8"),
  };
}

for (const [artifact, details] of Object.entries(artifacts)) {
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  append(repository, details.shipped);
  commit(repository, `${artifact} content without version`);
  const rejected = checkChanges(repository, base, { expectFailure: true });
  assert.match(`${rejected.stdout}${rejected.stderr}`, new RegExp(artifact, "i"));

  setVersion(repository, artifact, "1.0.1");
  commit(repository, `${artifact} version`);
  checkChanges(repository, base);
}

for (const [artifact, marketplace] of [
  ["claude", ".claude-plugin/marketplace.json"],
  ["codex", ".agents/plugins/marketplace.json"],
]) {
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  append(repository, marketplace, " ");
  commit(repository, `${artifact} marketplace without version`);
  checkChanges(repository, base, { expectFailure: true });
  setVersion(repository, artifact, "1.0.1");
  commit(repository, `${artifact} marketplace version`);
  checkChanges(repository, base);
}

{
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  append(repository, artifacts.pi.shipped);
  append(repository, artifacts.claude.shipped);
  setVersion(repository, "pi", "1.0.1");
  setVersion(repository, "claude", "1.0.1");
  commit(repository, "valid multi-adapter candidate");
  checkChanges(repository, base);
}

{
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  append(repository, artifacts.pi.shipped);
  append(repository, artifacts.claude.shipped);
  setVersion(repository, "pi", "1.0.1");
  commit(repository, "partial multi-adapter candidate");
  const rejected = checkChanges(repository, base, { expectFailure: true });
  assert.match(`${rejected.stdout}${rejected.stderr}`, /claude/i);
}

{
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  for (const path of [
    "test/fixture.sh",
    ".github/workflows/ci.yml",
    "README.md",
    "docs/agents/release.md",
  ]) {
    append(repository, path);
  }
  commit(repository, "non-distribution maintenance");
  checkChanges(repository, base);
}

{
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  const lock = JSON.parse(readFileSync(join(repository, "package-lock.json"), "utf8"));
  lock.fixtureMetadata = { changed: true };
  writeJson(repository, "package-lock.json", lock);
  commit(repository, "lock metadata only");
  checkChanges(repository, base);

  lock.packages["packages/pi"].version = "9.9.9";
  writeJson(repository, "package-lock.json", lock);
  commit(repository, "desynchronize lock");
  const rejected = checkChanges(repository, base, { expectFailure: true });
  assert.match(`${rejected.stdout}${rejected.stderr}`, /lock|pi/i);
}

for (const [candidate, accepted] of [
  ["1.0.1", true],
  ["1.1.0", true],
  ["1.0.0", false],
  ["0.9.9", false],
  ["1.0.1-beta.1", false],
  ["01.0.1", false],
  ["not-a-version", false],
]) {
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  append(repository, artifacts.pi.shipped);
  setVersion(repository, "pi", candidate);
  commit(repository, `candidate ${candidate}`);
  checkChanges(repository, base, { expectFailure: !accepted });
}

for (const artifact of ["pi", "opencode", "claude", "codex"]) {
  const repository = createRepository();
  git(repository, "tag", `${artifact}-v1.0.0`);
  append(repository, artifacts[artifact].shipped);
  setVersion(repository, artifact, "1.1.0");
  commit(repository, `${artifact} candidate`);
  git(repository, "tag", `${artifact}-v1.1.0`);
  const options = {};
  if (artifacts[artifact].lock) {
    const registryPath = join(repository, "registry-versions.json");
    writeJson(repository, "registry-versions.json", { [artifact]: ["1.0.0"] });
    options.registryVersions = registryPath;
  }
  const accepted = checkArtifact(repository, artifact, `${artifact}-v1.1.0`, options);
  assert.match(accepted.stdout, /candidate=1\.1\.0/);
  assert.match(accepted.stdout, /previous=1\.0\.0/);
}

{
  const repository = createRepository();
  git(repository, "tag", "pi-v1.0.0");
  setVersion(repository, "pi", "1.2.0");
  commit(repository, "pi 1.2.0");
  git(repository, "tag", "pi-v1.2.0");
  setVersion(repository, "pi", "1.3.0");
  commit(repository, "pi 1.3.0");
  git(repository, "tag", "pi-v1.3.0");
  const registryPath = join(repository, "registry-versions.json");
  writeJson(repository, "registry-versions.json", {
    pi: ["0.9.0", "1.1.0", "1.2.5", "1.3.0"],
  });
  const accepted = checkArtifact(repository, "pi", "pi-v1.3.0", {
    registryVersions: registryPath,
  });
  assert.match(accepted.stdout, /previous=1\.2\.5/);
}

{
  const repository = createRepository();
  git(repository, "tag", "pi-v1.0.0");
  setVersion(repository, "pi", "1.2.0");
  commit(repository, "pi tag-only checkpoint");
  git(repository, "tag", "pi-v1.2.0");
  setVersion(repository, "pi", "1.3.0");
  commit(repository, "pi candidate after tag-only checkpoint");
  git(repository, "tag", "pi-v1.3.0");
  const registryPath = join(repository, "registry-versions.json");
  writeJson(repository, "registry-versions.json", { pi: ["1.0.0"] });
  const accepted = checkArtifact(repository, "pi", "pi-v1.3.0", {
    registryVersions: registryPath,
  });
  assert.match(accepted.stdout, /previous=1\.0\.0/);
}

{
  const repository = createRepository();
  git(repository, "tag", "core-v0.1.0");
  const accepted = checkArtifact(repository, "core", "core-v0.1.0");
  assert.match(accepted.stdout, /candidate=0\.1\.0/);
  assert.match(accepted.stdout, /previous=\n/);
}

{
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  git(repository, "tag", "pi-v1.1.0");
  append(repository, artifacts.pi.shipped);
  setVersion(repository, "pi", "1.1.0");
  commit(repository, "reuse historical pi version");
  checkChanges(repository, base, { expectFailure: true });
}

{
  const repository = createRepository();
  const base = git(repository, "rev-parse", "HEAD");
  append(repository, artifacts.pi.shipped);
  setVersion(repository, "pi", "1.1.0");
  commit(repository, "registry reuse");
  const registryPath = join(repository, "registry-versions.json");
  writeJson(repository, "registry-versions.json", { pi: ["1.1.0"] });
  checkChanges(repository, base, {
    expectFailure: true,
    registryVersions: registryPath,
  });
}

{
  const repository = createRepository();
  git(repository, "tag", "core-v1.0.0-beta.1");
  git(repository, "tag", "core-v2.0.0");
  checkArtifact(repository, "core", "core-v2.0.0", { expectFailure: true });
}

{
  const repository = createRepository();
  setVersion(repository, "pi", "1.1.0");
  commit(repository, "pi manifest 1.1.0");
  git(repository, "tag", "pi-v1.2.0");
  checkArtifact(repository, "pi", "pi-v1.2.0", { expectFailure: true });
}

{
  const fakeBin = createFakeCommands();
  const absent = checkNpmArtifact(fakeBin, "absent");
  assert.match(absent.result.stdout, /decision=publish/);
  assert.match(absent.result.stdout, /authentication=trusted-publishing/);

  const identical = checkNpmArtifact(fakeBin, "existing");
  assert.match(identical.result.stdout, /decision=already-published/);

  checkNpmArtifact(fakeBin, "existing", {
    existingIntegrity: "sha512-ZGlmZmVyZW50",
    expectFailure: true,
  });
  checkNpmArtifact(fakeBin, "error", { expectFailure: true });
  checkNpmArtifact(fakeBin, "empty", { expectFailure: true });

  const tokenFallback = checkNpmArtifact(fakeBin, "absent", { token: "temporary-secret" });
  assert.match(tokenFallback.result.stdout, /authentication=token-fallback/);
  assert.match(tokenFallback.log, /^view /);
  assert.doesNotMatch(tokenFallback.log, /publish/);
}

{
  const fakeBin = createFakeCommands();
  const proof = proveMainCi(fakeBin, [{ workflow_runs: [ciRun()] }]);
  assert.match(
    proof.result.stdout,
    /^run_id=4242\nrun_url=https:\/\/github\.example\/runs\/4242\n$/,
  );
  assert.match(proof.result.stderr, /4242/);
  assert.match(proof.result.stderr, /visibility[^\n]*120/i);
  assert.match(proof.result.stderr, /poll[^\n]*10/i);
  assert.match(proof.result.stderr, /total[^\n]*3540/i);
  assert.match(proof.log, /actions\/workflows\/ci\.yml\/runs/);
  assert.match(proof.log, /branch=main/);
  assert.match(proof.log, /event=push/);
  assert.match(proof.log, /head_sha=aaaaaaaa/);
}

{
  const fakeBin = createFakeCommands();
  const wrongRuns = {
    workflow_runs: [
      ciRun({ id: 1, head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      ciRun({ id: 2, head_branch: "feature" }),
      ciRun({ id: 3, event: "pull_request" }),
    ],
  };
  const proof = proveMainCi(fakeBin, [wrongRuns, { workflow_runs: [ciRun()] }], {
    pollInterval: 0,
    visibilityTimeout: 1,
    totalTimeout: 1,
  });
  assert.match(proof.result.stdout, /^run_id=4242/m);
}

{
  const fakeBin = createFakeCommands();
  const proof = proveMainCi(
    fakeBin,
    [
      {
        workflow_runs: [
          ciRun({
            id: 4001,
            html_url: "https://github.example/runs/4001",
            status: "queued",
            conclusion: null,
          }),
        ],
      },
      {
        workflow_runs: [
          ciRun({
            id: 4002,
            html_url: "https://github.example/runs/4002",
            status: "in_progress",
            conclusion: null,
          }),
        ],
      },
      { workflow_runs: [ciRun()] },
    ],
    { pollInterval: 0, visibilityTimeout: 1, totalTimeout: 1 },
  );
  assert.match(proof.result.stdout, /^run_id=4242/m);
}

for (const conclusion of [
  "failure",
  "cancelled",
  "skipped",
  "stale",
  "action_required",
  "timed_out",
]) {
  const fakeBin = createFakeCommands();
  proveMainCi(
    fakeBin,
    [{ workflow_runs: [ciRun({ conclusion })] }],
    { expectFailure: true, pollInterval: 0, visibilityTimeout: 0, totalTimeout: 0 },
  );
}

{
  const fakeBin = createFakeCommands();
  proveMainCi(fakeBin, [{ workflow_runs: [] }], {
    expectFailure: true,
    pollInterval: 0,
    visibilityTimeout: 0,
    totalTimeout: 1,
  });
  proveMainCi(
    fakeBin,
    [{ workflow_runs: [ciRun({ status: "in_progress", conclusion: null })] }],
    { expectFailure: true, pollInterval: 0, visibilityTimeout: 0, totalTimeout: 0 },
  );
}

{
  const fakeBin = createFakeCommands();
  proveMainCi(
    fakeBin,
    [
      {
        workflow_runs: [
          ciRun(),
          ciRun({ id: 4343, html_url: "https://github.example/runs/4343" }),
        ],
      },
    ],
    { expectFailure: true, pollInterval: 0, visibilityTimeout: 0, totalTimeout: 0 },
  );
}

console.log("ok - artifact release policy and reusable main CI proof");
