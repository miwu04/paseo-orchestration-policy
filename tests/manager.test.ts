import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../shared/contracts.ts";
import { Manager, type AgentSnapshot, type Task, type Transport } from "../server/manager.ts";
import { saveJson } from "../server/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.test-work/manager");
after(() => rmSync(root, { recursive: true, force: true }));
function setup(t: TestContext, options: Record<string, unknown> = {}) {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  const cwd = join(directory, "repo");
  mkdirSync(cwd);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_000_000;
  const snapshots = new Map<string, AgentSnapshot>();
  snapshots.set("parent", { id: "parent", cwd, provider: "pi", status: "idle", archived: false, pendingPermissions: 0 });
  const deliveries: Array<{ id: string; text: string; messageId: string }> = [];
  const launched = new Set<string>();
  let failCreate = false;
  let instance: Manager;
  const api: Transport = {
    async workspace() { return { cwd }; },
    async create(task) {
      launched.add(task.id);
      snapshots.set(task.agentId!, { id: task.agentId!, cwd, provider: "pi", status: "running", archived: false, pendingPermissions: 0 });
      if (failCreate) throw new Error("provider unavailable");
      instance.started(task.agentId!, `turn-${task.generation}`);
      return task.agentId!;
    },
    async snapshot(id) { return snapshots.get(id) ?? null; },
    async send(id, text, messageId) {
      deliveries.push({ id, text, messageId });
      const task = Object.values(instance.state.tasks).find(task => task.agentId === id);
      if (task) {
        snapshots.get(id)!.status = "running";
        instance.started(id, `turn-${task.generation}`);
      }
    },
    async report() { return [{ item: { type: "assistant_message", text: "Actual completed report" } }]; },
  };
  const config = ConfigSchema.parse({ retryDelaysMs: [10, 20, 30], notificationTimeoutMs: 1000, ...options });
  const open = () => { instance = new Manager(join(directory, "state"), config, api, () => now); t.after(() => instance.close()); return instance; };
  const manager = open();
  const create = (extra: Record<string, unknown> = {}) => instance.create({ workspaceId: "workspace", parentAgentId: "parent", title: "Task", prompt: "Exact bounded task", provider: "pi", role: "worker", ...extra });
  const complete = async (task: Task) => {
    snapshots.get(task.agentId!)!.status = "idle";
    await instance.ended(task.agentId!, task.turnId, { kind: "completed" });
  };
  return { directory, cwd, manager, create, complete, api, snapshots, deliveries, launched, open, advance: (ms: number) => { now += ms; }, failCreation: () => { failCreate = true; } };
}

test("new tasks wait for explicit scheduling and a completed turn is not user acceptance", async t => {
  const s = setup(t);
  const task = await s.create();
  assert.equal(task.phase, "queued");
  assert.equal(s.launched.size, 0);
  await s.manager.tick();
  assert.equal(task.phase, "running");
  await s.complete(task);
  assert.equal(task.phase, "awaiting_review");
  assert.throws(() => s.manager.accept(task.id), /独立审查/);
});

test("same-directory writers serialize while independent read-only work can run", async t => {
  const s = setup(t, { maxActive: 2 });
  const first = await s.create();
  const second = await s.create();
  const scout = await s.create({ role: "scout" });
  await Promise.all([s.manager.tick(), s.manager.tick()]);
  assert.equal(first.phase, "running");
  assert.equal(second.phase, "queued");
  assert.equal(scout.phase, "running");
});

test("dependencies release only after explicit acceptance, not on turn completion", async t => {
  const s = setup(t);
  const source = await s.create({ role: "scout" });
  const dependent = await s.create({ role: "scout", dependsOn: [source.id] });
  await s.manager.tick();
  await s.complete(source);
  await s.manager.tick();
  assert.equal(dependent.phase, "queued");
  s.manager.accept(source.id);
  await s.manager.tick();
  assert.equal(dependent.phase, "running");
});

test("notifications retry three times with one stable message id, then stop", async t => {
  const s = setup(t);
  const task = await s.create();
  await s.manager.tick(); await s.complete(task);
  await Promise.all([s.manager.drain(), s.manager.drain()]);
  s.advance(10); await s.manager.drain();
  s.advance(20); await s.manager.drain();
  s.advance(30); await s.manager.drain();
  const message = Object.values(s.manager.state.messages)[0];
  assert.equal(s.deliveries.length, 3);
  assert.equal(new Set(s.deliveries.map(delivery => delivery.messageId)).size, 1);
  assert.equal(message.status, "blocked");
  s.advance(100); await s.manager.drain();
  assert.equal(s.deliveries.length, 3);
});

test("a pending parent approval is never interrupted by a child notification", async t => {
  const s = setup(t);
  const task = await s.create();
  await s.manager.tick(); await s.complete(task);
  s.snapshots.get("parent")!.pendingPermissions = 1;
  await s.manager.drain();
  assert.equal(s.deliveries.length, 0);
  assert.equal(Object.values(s.manager.state.messages)[0].attempts, 0);
  s.advance(1001); await s.manager.drain();
  assert.equal(Object.values(s.manager.state.messages)[0].status, "blocked");
});

test("notifications and acknowledgement survive a clean plugin restart", async t => {
  const s = setup(t);
  const task = await s.create();
  await s.manager.tick(); await s.complete(task); await s.manager.drain();
  const id = Object.keys(s.manager.state.messages)[0];
  s.manager.close();
  const restored = s.open();
  assert.equal(restored.state.messages[id].attempts, 1);
  saveJson(join(s.directory, "state", "acks", `${id}.json`), { recipientId: "parent", acknowledgedAt: "now" });
  await restored.drain();
  assert.equal(restored.state.messages[id].status, "acknowledged");
  assert.equal(s.deliveries.length, 1);
});

test("duplicate completion events do not duplicate reports or notifications", async t => {
  const s = setup(t);
  const task = await s.create(); await s.manager.tick();
  await Promise.all([s.complete(task), s.complete(task)]);
  await s.manager.drain();
  assert.equal(Object.values(s.manager.state.messages).length, 1);
  assert.equal(task.phase, "awaiting_review");
  assert.equal(s.deliveries.length, 1);
});

test("late results from the old turn cannot advance a continued task", async t => {
  const s = setup(t);
  const task = await s.create(); await s.manager.tick();
  const oldTurn = task.turnId;
  await s.complete(task);
  await s.manager.continueTask(task.id, "Fix only the named findings");
  assert.equal(task.generation, 2);
  assert.equal(task.phase, "running");
  await s.manager.ended(task.agentId!, oldTurn, { kind: "completed" });
  assert.equal(task.phase, "running");
  assert.equal(task.reportPath, null);
});

test("provider turn ids reused across attempts block rather than accepting an ambiguous result", async t => {
  const s = setup(t);
  const task = await s.create(); await s.manager.tick(); await s.complete(task);
  s.api.send = async () => { s.manager.started(task.agentId!, "turn-1"); };
  await s.manager.continueTask(task.id, "Next explicit phase");
  assert.equal(task.phase, "blocked");
});

test("a creation failure preserves its task and never automatically creates a replacement", async t => {
  const s = setup(t); s.failCreation();
  const task = await s.create();
  await s.manager.tick();
  assert.equal(task.phase, "blocked");
  const actor = task.agentId;
  await s.manager.tick(); await s.manager.tick();
  assert.equal(task.agentId, actor);
  assert.equal(s.launched.size, 1);
});

test("deadline expiration reports a blocker without stopping or archiving the agent", async t => {
  const s = setup(t);
  const task = await s.create({ timeoutMs: 100 }); await s.manager.tick();
  s.advance(101); await s.manager.tick();
  assert.equal(task.phase, "blocked");
  assert.equal(s.snapshots.get(task.agentId!)!.status, "running");
  assert.match(task.error!, /没有终止或归档/);
});

test("missing lifecycle events do not count as completion", async t => {
  const s = setup(t);
  const task = await s.create(); await s.manager.tick();
  s.snapshots.get(task.agentId!)!.status = "idle";
  await s.manager.tick();
  assert.equal(task.phase, "blocked");
  assert.match(task.error!, /完成事件缺失/);
  assert.equal(task.reportPath, null);
});

test("only the current task owner and attempt can submit an upstream decision request", async t => {
  const s = setup(t);
  const task = await s.create(); await s.manager.tick();
  for (const attemptId of [randomUUID(), task.attemptId]) {
    const id = randomUUID();
    saveJson(join(s.directory, "state", "requests", `${id}.json`), { id, taskId: task.id, actorId: task.agentId, attemptId, message: "Need a scope decision" });
  }
  await s.manager.tick();
  assert.equal(Object.values(s.manager.state.messages).filter(message => message.key.includes("decision:")).length, 1);
});

test("a worker requires a distinct reviewer bound to the current generation before acceptance", async t => {
  const s = setup(t);
  const worker = await s.create(); await s.manager.tick(); await s.complete(worker);
  const reviewer = await s.create({ role: "reviewer", subjectTaskId: worker.id });
  await s.manager.tick(); await s.complete(reviewer);
  s.manager.recordReview(worker.id, reviewer.id, "pass", "Read the actual report and accepted it");
  await s.manager.continueTask(worker.id, "Fix a newly identified defect");
  await s.complete(worker);
  assert.throws(() => s.manager.recordReview(worker.id, reviewer.id, "pass", "Old review"), /过期/);
  const fresh = await s.create({ role: "reviewer", subjectTaskId: worker.id });
  await s.manager.tick(); await s.complete(fresh);
  s.manager.recordReview(worker.id, fresh.id, "pass", "Current generation reviewed");
  s.manager.accept(worker.id);
  assert.equal(worker.phase, "accepted");
});

test("archived parents are not resurrected to deliver a notification", async t => {
  const s = setup(t);
  const task = await s.create(); await s.manager.tick(); await s.complete(task);
  s.snapshots.get("parent")!.archived = true;
  await s.manager.drain();
  assert.equal(Object.values(s.manager.state.messages)[0].status, "blocked");
  assert.equal(s.deliveries.length, 0);
});

test("a second coordinator and invalid persisted state both fail closed", async t => {
  const s = setup(t);
  assert.throws(() => new Manager(join(s.directory, "state"), s.manager.config, s.api), /状态目录仍登记/);
  s.manager.close();
  saveJson(join(s.directory, "state", "orchestration.json"), { schemaVersion: 99 });
  assert.throws(() => new Manager(join(s.directory, "state"), s.manager.config, s.api));
});
