import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, type AgentSnapshot, type Task, type Transport } from "../server/manager.ts";
import { ConfigSchema as OrchestrationConfig } from "../shared/contracts.ts";
import { PolicyController } from "../../pi-execution-policy/src/controller.ts";
import { ConfigSchema as ExecutionConfig } from "../../pi-execution-policy/src/config.ts";
import { git } from "../../pi-execution-policy/src/process.ts";
import { revision } from "../../pi-execution-policy/src/repository.ts";
import { readJson } from "../server/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.test-work/pair");
const KEYS = ["AGENT_POLICY_TASK_ID", "AGENT_POLICY_ATTEMPT_ID", "AGENT_POLICY_ROLE", "PASEO_AGENT_ID"] as const;

test("a dispatched worker stays inside its paths and commits only the reviewed, approved content", async t => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  const cwd = realpathSync(mkdtempSync(join(directory, "repo-")));
  const state = join(directory, "state");
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  const restore = () => { for (const key of KEYS) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  let manager: Manager | undefined;
  const sessions: PolicyController[] = [];
  t.after(() => { for (const session of sessions) session.shutdown(); manager?.close(); restore(); rmSync(directory, { recursive: true, force: true }); });
  await git(cwd, ["init", "--quiet"]);
  writeFileSync(join(cwd, "app.txt"), "before\n");
  await git(cwd, ["add", "--", "app.txt"]);
  await git(cwd, ["commit", "--quiet", "-m", "Initial test content"]);

  const agents = new Map<string, AgentSnapshot>();
  const api: Transport = {
    async workspace() { return { cwd }; },
    async create(task) {
      agents.set(task.agentId!, { id: task.agentId!, cwd, provider: "pi", status: "running", archived: false, pendingPermissions: 0 });
      manager!.started(task.agentId!, `turn-${task.generation}`);
      return task.agentId!;
    },
    async snapshot(id) { return agents.get(id) ?? null; },
    async send() {},
    async report() { return [{ item: { type: "assistant_message", text: "Reviewed the patch; no blockers." } }]; },
  };
  manager = new Manager(state, OrchestrationConfig.parse({}), api);

  restore();
  const top = new PolicyController({ cwd, stateRoot: state, config: ExecutionConfig.parse({}), sessionId: "top", actorId: "agent-top" });
  sessions.push(top);
  const request = top.orchestrate(JSON.stringify({ action: "create", task: { workspaceId: "workspace", title: "Implement", prompt: "Change app.txt only", provider: "pi", role: "worker", paths: ["app.txt"], allowCommit: true } }));
  await manager.tick();
  const created = JSON.parse(readJson<{ text: string }>(join(state, "results", `${request}.json`))!.text) as Task;
  assert.deepEqual(created.paths, ["app.txt"]);
  assert.equal(created.parentAgentId, "agent-top");
  const launched = manager.state.tasks[created.id];
  assert.equal(launched.phase, "running");

  process.env.PASEO_AGENT_ID = launched.agentId!;
  process.env.AGENT_POLICY_TASK_ID = created.id;
  process.env.AGENT_POLICY_ATTEMPT_ID = launched.attemptId;
  process.env.AGENT_POLICY_ROLE = "worker";
  const worker = new PolicyController({ cwd, stateRoot: state, config: ExecutionConfig.parse({}), sessionId: "worker", actorId: launched.agentId! });
  sessions.push(worker);
  assert.equal(worker.mode, "managed");
  assert.throws(() => worker.gate("x", "write", { path: "../outside" }), /授权目录之外/);
  worker.gate("w", "write", { path: "app.txt" });
  writeFileSync(join(cwd, "app.txt"), "implemented\n");
  worker.finishTool("w");
  agents.get(launched.agentId!)!.status = "idle";
  await manager.ended(launched.agentId!, launched.turnId, { kind: "completed" });
  assert.equal(launched.phase, "awaiting_review");

  const reviewer = await manager.create({ workspaceId: "workspace", parentAgentId: "agent-top", title: "Review", prompt: "Review the patch", provider: "pi", role: "reviewer", subjectTaskId: created.id });
  await manager.tick();
  const report = join(directory, "report.md");
  writeFileSync(report, "Reviewed the patch; no blockers.\n");
  process.env.PASEO_AGENT_ID = reviewer.agentId!;
  process.env.AGENT_POLICY_TASK_ID = reviewer.id;
  process.env.AGENT_POLICY_ATTEMPT_ID = reviewer.attemptId;
  process.env.AGENT_POLICY_ROLE = "reviewer";
  const reviewSession = new PolicyController({ cwd, stateRoot: state, config: ExecutionConfig.parse({}), sessionId: "reviewer", actorId: reviewer.agentId! });
  sessions.push(reviewSession);
  assert.throws(() => reviewSession.gate("bad", "write", { path: "app.txt" }), /reviewer 不允许写入/);
  agents.get(reviewer.agentId!)!.status = "idle";
  await manager.ended(reviewer.agentId!, reviewer.turnId, { kind: "completed" });
  assert.throws(() => manager.recordReview(created.id, reviewer.id, "pass", "Parent-only verdict"), /没有留下针对本任务的审查记录/);
  await reviewSession.recordReview({ reviewerId: "reviewer-session", reportPath: report, verdict: "pass" });
  const verdict = readJson<{ verdict: string; reviewerAgentId: string }>(join(state, "reviews", `${created.id}.json`));
  assert.equal(verdict?.verdict, "pass");
  assert.equal(verdict?.reviewerAgentId, reviewer.agentId);
  manager.recordReview(created.id, reviewer.id, "pass", "Independent report reviewed");

  restore();
  process.env.PASEO_AGENT_ID = "agent-top";
  const approval = top.orchestrate(JSON.stringify({ action: "approveCommit", taskId: created.id, revision: await revision(cwd, ExecutionConfig.parse({})), paths: ["app.txt"] }));
  await manager.tick();
  assert.equal(readJson<{ error?: string }>(join(state, "results", `${approval}.json`))?.error, undefined);
  assert.ok(existsSync(join(state, "approvals", `${created.id}.json`)));

  process.env.PASEO_AGENT_ID = launched.agentId!;
  process.env.AGENT_POLICY_TASK_ID = created.id;
  process.env.AGENT_POLICY_ATTEMPT_ID = launched.attemptId;
  process.env.AGENT_POLICY_ROLE = "worker";
  const commit = await worker.commit(["app.txt"], "Implement reviewed change");
  assert.equal((await git(cwd, ["show", `${commit}:app.txt`])).trim(), "implemented");
  assert.equal(readFileSync(join(cwd, "app.txt"), "utf8"), "implemented\n");
});
