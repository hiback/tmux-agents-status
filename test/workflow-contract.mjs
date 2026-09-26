import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = join(root, ".github", "workflows");
const sharedWorkflowPath = "./.github/workflows/marketplace-verification.yml";

function loadWorkflow(name) {
  const path = join(workflowDirectory, name);
  const document = parseDocument(readFileSync(path, "utf8"), {
    prettyErrors: true,
    uniqueKeys: true,
  });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    `${name} must be valid YAML`,
  );
  return document.toJS();
}

function keys(value) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.keys(value).sort();
}

function normalizeExpression(value) {
  let expression = String(value).trim();
  const wrapped = expression.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped !== null) expression = wrapped[1];
  return expression.replace(/\s+/g, "");
}

function assertExpression(actual, expected, message) {
  assert.equal(normalizeExpression(actual), expected.replace(/\s+/g, ""), message);
}

function compactShell(script) {
  return String(script)
    .replace(/\\\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jobEntries(workflow) {
  assert.ok(workflow.jobs !== null && typeof workflow.jobs === "object");
  return Object.entries(workflow.jobs);
}

function steps(job) {
  assert.ok(Array.isArray(job.steps));
  return job.steps;
}

function findUnique(values, predicate, description) {
  const matches = values.filter(predicate);
  assert.equal(matches.length, 1, `expected one ${description}, found ${matches.length}`);
  return matches[0];
}

function jobNeeds(job) {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function dependsOn(jobs, from, target, visited = new Set()) {
  if (visited.has(from)) return false;
  visited.add(from);
  for (const dependency of jobNeeds(jobs[from])) {
    if (dependency === target || dependsOn(jobs, dependency, target, visited)) return true;
  }
  return false;
}

function allSteps(workflow) {
  return jobEntries(workflow).flatMap(([jobId, job]) =>
    Array.isArray(job.steps) ? job.steps.map((step) => ({ job, jobId, step })) : []
  );
}

function actionSteps(workflow, action) {
  return allSteps(workflow).filter(({ step }) =>
    typeof step.uses === "string" && step.uses.startsWith(`${action}@`)
  );
}

function commandSteps(workflow, command) {
  return allSteps(workflow).filter(({ step }) =>
    typeof step.run === "string" && compactShell(step.run).includes(command)
  );
}

function assertReadOnlyPermissions(workflow, description) {
  const permissionEntries = [
    ["workflow", workflow.permissions],
    ...jobEntries(workflow)
      .filter(([, job]) => job.permissions !== undefined)
      .map(([jobId, job]) => [`job ${jobId}`, job.permissions]),
  ];
  for (const [location, permissions] of permissionEntries) {
    assert.ok(
      permissions !== null && typeof permissions === "object" && !Array.isArray(permissions),
      `${description} ${location} permissions must be explicit`,
    );
    for (const [scope, access] of Object.entries(permissions)) {
      assert.ok(
        access === "read" || access === "none",
        `${description} ${location} must not grant ${scope}: ${access}`,
      );
    }
  }
}

function assertSetupBefore(job, targetStep, action, expectedWith = {}) {
  const targetIndex = steps(job).indexOf(targetStep);
  const setup = findUnique(
    steps(job),
    (step) => typeof step.uses === "string" &&
      (step.uses === action || step.uses.startsWith(`${action}@`)),
    `${action} setup in a production-command job`,
  );
  assert.ok(steps(job).indexOf(setup) < targetIndex, `${action} must precede its command`);
  for (const [name, value] of Object.entries(expectedWith)) {
    assert.equal(setup.with?.[name], value);
  }
}

function assertCaller(name, artifact, tagPattern) {
  const workflow = loadWorkflow(name);
  assert.deepEqual(keys(workflow.on), ["push"]);
  assert.deepEqual(workflow.on.push.tags, [tagPattern]);
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  assertReadOnlyPermissions(workflow, name);

  const [jobId, job] = findUnique(
    jobEntries(workflow),
    ([, candidate]) => candidate.uses === sharedWorkflowPath,
    `${artifact} reusable marketplace verification call`,
  );
  assert.equal(jobEntries(workflow).length, 1, `${name} must remain a shallow trigger adapter`);
  assertExpression(
    job.if,
    "github.repository == 'hiback/tmux-agents-status'",
    `${jobId} must retain the official-repository guard`,
  );
  assert.deepEqual(keys(job.with), ["artifact", "sha"]);
  assert.equal(job.with.artifact, artifact);
  assertExpression(job.with.sha, "github.sha", `${jobId} must pass the tagged event SHA`);
  // Environment secrets reach the called environment-bound job only through inheritance.
  assert.equal(job.secrets, "inherit", `${jobId} must inherit secrets for its verification environment`);
  assert.equal(Object.hasOwn(job, "steps"), false, `${jobId} must contain no orchestration steps`);
  assert.equal(Object.hasOwn(job, "environment"), false, `${jobId} must not select an environment`);
}

assertCaller("verify-claude.yml", "claude", "claude-v*");
assertCaller("verify-codex.yml", "codex", "codex-v*");

const shared = loadWorkflow("marketplace-verification.yml");
assert.deepEqual(keys(shared.on), ["workflow_call"]);
const workflowCall = shared.on.workflow_call;
assert.deepEqual(keys(workflowCall.inputs), ["artifact", "sha"]);
for (const input of Object.values(workflowCall.inputs)) {
  assert.equal(input.required, true);
  assert.equal(input.type, "string");
  assert.equal(Object.hasOwn(input, "default"), false);
}
assert.equal(Object.hasOwn(workflowCall, "secrets"), false, "the reusable interface accepts no secrets");
assert.deepEqual(shared.permissions, { actions: "read", contents: "read" });
assertReadOnlyPermissions(shared, "marketplace-verification.yml");

const jobs = shared.jobs;
const [policyJobId, policyJob] = findUnique(
  jobEntries(shared),
  ([, job]) => Array.isArray(job.steps) && job.steps.some((step) =>
    typeof step.run === "string" &&
    compactShell(step.run).includes("scripts/release-policy.mjs check-artifact")
  ),
  "artifact-policy job",
);
assert.equal(Object.hasOwn(policyJob, "environment"), false);
assert.doesNotMatch(JSON.stringify(policyJob), /secrets\./);

const validationStep = findUnique(
  steps(policyJob),
  (step) => typeof step.if === "string" && String(step.run).trim() === "exit 1",
  "fail-closed event and artifact validation step",
);
const invalidExpression = normalizeExpression(validationStep.if);
assert.deepEqual(
  invalidExpression.split("||").sort(),
  [
    "github.repository!='hiback/tmux-agents-status'",
    "github.event_name!='push'",
    "github.event.deleted==true",
    "github.ref_type!='tag'",
    "github.ref!=format('refs/tags/{0}',github.ref_name)",
    "inputs.sha!=github.sha",
    "(inputs.artifact!='claude'&&inputs.artifact!='codex')",
  ].sort(),
  "validation must reject every untrusted event or open artifact identity",
);

const policyStep = findUnique(
  steps(policyJob),
  (step) => typeof step.run === "string" &&
    compactShell(step.run).includes("scripts/release-policy.mjs check-artifact"),
  "canonical artifact-policy command",
);
assert.ok(steps(policyJob).indexOf(validationStep) < steps(policyJob).indexOf(policyStep));
assert.equal(typeof policyStep.id, "string");
assertExpression(policyStep.env.ARTIFACT, "inputs.artifact");
assertExpression(policyStep.env.TAGGED_SHA, "inputs.sha");
assertExpression(policyStep.env.TRUSTED_TAG, "github.ref_name");
const policyCommand = compactShell(policyStep.run);
assert.match(policyCommand, /--artifact "\$ARTIFACT"/);
assert.match(policyCommand, /--tag "\$TRUSTED_TAG"/);
assert.match(policyCommand, /--head "\$TAGGED_SHA"/);
assertExpression(
  policyJob.outputs.previous_tag,
  `steps.${policyStep.id}.outputs.previous_tag`,
  "policy must expose canonical previous_tag unchanged",
);

const ancestryStep = findUnique(
  steps(policyJob),
  (step) => typeof step.run === "string" &&
    compactShell(step.run).includes("git merge-base --is-ancestor"),
  "default-branch ancestry check",
);
assert.ok(
  steps(policyJob).indexOf(policyStep) < steps(policyJob).indexOf(ancestryStep),
  "artifact policy must succeed before default-branch ancestry",
);
assertExpression(ancestryStep.env.DEFAULT_BRANCH, "github.event.repository.default_branch");
assertExpression(ancestryStep.env.TAGGED_SHA, "inputs.sha");
assert.match(compactShell(ancestryStep.run), /git merge-base --is-ancestor "\$TAGGED_SHA"/);
assertSetupBefore(policyJob, policyStep, "actions/checkout", {
  "fetch-depth": 0,
  ref: "${{ inputs.sha }}",
});
assertSetupBefore(policyJob, policyStep, "actions/setup-node", { "node-version": "24" });

const [proofJobId, proofJob] = findUnique(
  jobEntries(shared),
  ([, job]) => job.uses === "./.github/workflows/ci-proof.yml",
  "exact-SHA main CI proof call",
);
assert.ok(jobNeeds(proofJob).includes(policyJobId));
assert.deepEqual(keys(proofJob.with), ["sha"]);
assertExpression(proofJob.with.sha, "inputs.sha");
assert.equal(Object.hasOwn(proofJob, "secrets"), false);
assert.deepEqual(proofJob.permissions, { actions: "read", contents: "read" });

const stageCommands = commandSteps(shared, "scripts/marketplace-verification.mjs stage");
assert.equal(stageCommands.length, 1, "production marketplace staging must have one command step");
assert.equal(
  allSteps(shared).reduce(
    (count, { step }) => count +
      (typeof step.run === "string"
        ? (step.run.match(/scripts\/marketplace-verification\.mjs\s+stage\b/g) ?? []).length
        : 0),
    0,
  ),
  1,
  "production marketplace staging must be invoked exactly once",
);
const { job: stageJob, jobId: stageJobId, step: stageStep } = stageCommands[0];
assert.deepEqual(jobNeeds(stageJob).sort(), [policyJobId, proofJobId].sort());
assert.equal(Object.hasOwn(stageJob, "environment"), false);
assert.doesNotMatch(JSON.stringify(stageJob), /secrets\./);
assertExpression(stageStep.env.ARTIFACT, "inputs.artifact");
assertExpression(stageStep.env.TAGGED_SHA, "inputs.sha");
assertExpression(
  stageStep.env.PREVIOUS_TAG,
  `needs.${policyJobId}.outputs.previous_tag`,
  "stage must receive release-policy previous_tag directly",
);
assert.equal(stageStep.env.STAGED_DIRECTORY, "${{ runner.temp }}/staged-marketplace");
const stageCommand = compactShell(stageStep.run);
for (const argument of [
  "--artifact \"$ARTIFACT\"",
  "--sha \"$TAGGED_SHA\"",
  "--output \"$STAGED_DIRECTORY\"",
  "--previous-tag \"$PREVIOUS_TAG\"",
]) {
  assert.ok(stageCommand.includes(argument), `stage command must contain ${argument}`);
}
assert.match(stageCommand, /\[ -n "\$PREVIOUS_TAG" \]/);
assert.doesNotMatch(stageCommand, /(?:claude|codex)-v\$PREVIOUS_TAG/);
assertSetupBefore(stageJob, stageStep, "actions/checkout", {
  "fetch-depth": 0,
  ref: "${{ inputs.sha }}",
});
assertSetupBefore(stageJob, stageStep, "actions/setup-node", { "node-version": "24" });

const uploads = actionSteps(shared, "actions/upload-artifact");
assert.equal(uploads.length, 1, "the staged marketplace must have one upload");
assert.equal(uploads[0].jobId, stageJobId);
assert.ok(
  steps(stageJob).indexOf(stageStep) < steps(stageJob).indexOf(uploads[0].step),
  "production marketplace staging must precede artifact upload",
);
assert.equal(uploads[0].step.with["if-no-files-found"], "error");
assert.equal(uploads[0].step.with["retention-days"], 7);

const smokeCommands = commandSteps(shared, "scripts/marketplace-verification.mjs smoke");
assert.equal(smokeCommands.length, 1, "both lanes must share one production smoke definition");
assert.equal(
  allSteps(shared).reduce(
    (count, { step }) => count +
      (typeof step.run === "string"
        ? (step.run.match(/scripts\/marketplace-verification\.mjs\s+smoke\b/g) ?? []).length
        : 0),
    0,
  ),
  1,
  "the matrix must contain one production smoke invocation",
);
const { job: smokeJob, jobId: smokeJobId, step: smokeStep } = smokeCommands[0];
assert.ok(jobNeeds(smokeJob).includes(stageJobId));
assert.ok(dependsOn(jobs, smokeJobId, policyJobId));
assert.ok(dependsOn(jobs, smokeJobId, proofJobId));
assertExpression(smokeJob["runs-on"], "matrix.os");
assert.equal(smokeJob.strategy["fail-fast"], false);
assert.deepEqual(
  [...smokeJob.strategy.matrix.include].sort((left, right) => left.os.localeCompare(right.os)),
  [
    { os: "macos-latest", update: false },
    { os: "ubuntu-latest", update: true },
  ],
);
assert.equal(smokeJob.environment, "${{ inputs.artifact }}-verification");
assertExpression(smokeStep.env.ARTIFACT, "inputs.artifact");
assertExpression(smokeStep.env.TAGGED_SHA, "inputs.sha");
assert.equal(smokeStep.env.STAGED_DIRECTORY, "${{ runner.temp }}/staged-marketplace");
assertExpression(smokeStep.env.UPDATE, "matrix.update");
assertExpression(
  smokeStep.env.SMOKE_ANTHROPIC_API_KEY,
  "inputs.artifact == 'claude' && secrets.SMOKE_ANTHROPIC_API_KEY || ''",
);
assertExpression(
  smokeStep.env.SMOKE_OPENAI_API_KEY,
  "inputs.artifact == 'codex' && secrets.SMOKE_OPENAI_API_KEY || ''",
);
const smokeCommand = compactShell(smokeStep.run);
for (const argument of [
  "--artifact \"$ARTIFACT\"",
  "--sha \"$TAGGED_SHA\"",
  "--staged \"$STAGED_DIRECTORY\"",
  "--update \"$UPDATE\"",
]) {
  assert.ok(smokeCommand.includes(argument), `smoke command must contain ${argument}`);
}
assertSetupBefore(smokeJob, smokeStep, "actions/checkout", {
  ref: "${{ inputs.sha }}",
});
assertSetupBefore(smokeJob, smokeStep, "actions/setup-node", { "node-version": "24" });
assertSetupBefore(smokeJob, smokeStep, "./.github/actions/setup-tmux", { version: "current" });

const downloads = actionSteps(shared, "actions/download-artifact");
assert.equal(downloads.length, 1, "both matrix lanes must use the same download definition");
assert.equal(downloads[0].jobId, smokeJobId);
assert.ok(
  steps(smokeJob).indexOf(downloads[0].step) < steps(smokeJob).indexOf(smokeStep),
  "artifact download must precede production marketplace smoke",
);
assert.equal(downloads[0].step.with.name, uploads[0].step.with.name);
assert.equal(downloads[0].step.with.path, uploads[0].step.with.path);
assert.equal(uploads[0].step.with.path, "${{ runner.temp }}/staged-marketplace");

const environmentJobs = jobEntries(shared).filter(([, job]) => job.environment !== undefined);
assert.deepEqual(environmentJobs.map(([jobId]) => jobId), [smokeJobId]);
const serializedShared = JSON.stringify(shared);
assert.deepEqual(
  [...serializedShared.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort(),
  ["SMOKE_ANTHROPIC_API_KEY", "SMOKE_OPENAI_API_KEY"],
);
for (const forbidden of [
  ".claude-plugin",
  ".agents/plugins",
  "@anthropic-ai/claude-code",
  "@openai/codex",
  "smoke-claude",
  "smoke-codex",
  "TAS_CODEX_HOOK",
  "claude-haiku",
  "gpt-",
]) {
  assert.equal(serializedShared.includes(forbidden), false, `shared workflow must hide ${forbidden}`);
}
assert.doesNotMatch(serializedShared, /continue-on-error/);
assert.doesNotMatch(serializedShared, /always\s*\(/);
assert.doesNotMatch(serializedShared, /(?:git push|git tag|npm publish)/);

console.log("ok - semantic marketplace verification workflow contract");
