import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, type AgentSnapshot, type Transport } from "../server/manager.ts";
import { ConfigSchema as OrchestrationConfig } from "../shared/contracts.ts";
import { PolicyController } from "../../pi-execution-policy/src/controller.ts";
import { ConfigSchema as ExecutionConfig } from "../../pi-execution-policy/src/config.ts";
import { git } from "../../pi-execution-policy/src/process.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.test-work/pair");

test("both plugins share review freezing, receipt records and exact local commit approval", async t => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  const stateRoot = join(directory, "state");
  let child: PolicyController | undefined;
  let parent: PolicyController | undefined;
  let manager: Manager | undefined;
  t.after(() => { child?.shutdown(); parent?.shutdown(); manager?.close(); rmSync(directory, { recursive: true, force: true }); });
  await git(cwd, ["init", "--quiet"]);
  writeFileSync(join(cwd, "app.txt"), "before\n");
  await git(cwd, ["add", "--", "app.txt"]);
  await git(cwd, ["commit", "--quiet", "-m", "Initial test content"]);
  const agents = new Map<string, AgentSnapshot>();
  agents.set("parent", { id: "parent", cwd, provider: "pi", status: "idle", archived: false, pendingPermissions: 0 });
  const api: Transport = {
    async workspace() { return { cwd }; },
    async create(task) {
      agents.set(task.agentId!, { id: task.agentId!, cwd, provider: "pi", status: "running", archived: false, pendingPermissions: 0 });
      manager!.started(task.agentId!, `turn-${task.generation}`);
      return task.agentId!;
    },
    async snapshot(id) { return agents.get(id) ?? null; },
    async send(id) {
      const current = Object.values(manager!.state.tasks).find(task => task.agentId === id);
      if (current) { agents.get(id)!.status = "running"; manager!.started(id, `turn-${current.generation}`); }
    },
    async report() { return [{ item: { type: "assistant_message", text: "Reviewed actual behavior and required checks; no blocking findings." } }]; },
  };
  manager = new Manager(stateRoot, OrchestrationConfig.parse({}), api);
  const task = await manager.create({ workspaceId: "workspace", parentAgentId: "parent", title: "Implement", provider: "pi", role: "worker", prompt: "Change app.txt only" });
  await manager.tick();
  const config = ExecutionConfig.parse({ checks: { test: { command: process.execPath, args: ["-e", "process.exit(0)"] } }, requiredChecks: ["test"] });
  child = new PolicyController({ cwd, stateRoot, config, sessionId: "child-session", actorId: task.agentId! });
  parent = new PolicyController({ cwd, stateRoot, config, sessionId: "parent-session", actorId: "parent" });
  await child.grant({ paths: ["app.txt"], allowCommit: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  child.gate("write", "edit", { path: "app.txt" });
  writeFileSync(join(cwd, "app.txt"), "implemented\n"); child.finishTool("write");
  agents.get(task.agentId!)!.status = "idle";
  await manager.ended(task.agentId!, task.turnId, { kind: "completed" });
  const review = await manager.create({ workspaceId: "workspace", parentAgentId: "parent", title: "Independent review", provider: "pi", role: "reviewer", subjectTaskId: task.id, prompt: "Review the exact change" });
  await manager.tick();
  assert.throws(() => child!.gate("late-write", "edit", { path: "app.txt" }), /独立审查/);
  await assert.rejects(manager.continueTask(task.id, "Do not write during review"), /独立审查/);
  const inbox = parent.inbox();
  assert.equal(inbox.length, 1);
  parent.acknowledge(inbox[0].id);
  await manager.drain();
  assert.equal(manager.state.messages[inbox[0].id].status, "acknowledged");
  agents.get(review.agentId!)!.status = "idle";
  await manager.ended(review.agentId!, review.turnId, { kind: "completed" });
  manager.recordReview(task.id, review.id, "pass", "User inspected the independent report");
  await child.recordReview({ reviewerId: review.agentId!, reportPath: review.reportPath!, verdict: "pass" });
  await child.check("test");
  await child.approve();
  const commit = await child.commit(["app.txt"], "Implement reviewed change");
  assert.equal((await git(cwd, ["show", `${commit}:app.txt`])).trim(), "implemented");
  assert.equal(readFileSync(join(cwd, "app.txt"), "utf8"), "implemented\n");
  const request = child.requestDecision("Clarify the next authorized action");
  await manager.tick();
  const notification = manager.state.messages[request];
  assert.equal(notification.taskId, task.id);
  assert.equal(notification.attemptId, task.attemptId);
  manager.accept(task.id);
  assert.equal(task.phase, "accepted");
  assert.throws(() => child!.requestDecision("Do not revive an accepted task"), /任务已结束/);
});
