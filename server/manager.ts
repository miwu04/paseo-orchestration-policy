import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TaskInputSchema, type Config } from "../shared/contracts.ts";
import { CoordinatorLock, digest, readJson, saveJson } from "./store.ts";

const phases = ["queued", "launching", "running", "waiting_permission", "collecting_report", "awaiting_review", "blocked", "failed", "canceled", "accepted"] as const;
const TaskSchema = TaskInputSchema.extend({
  id: z.string().uuid(), cwd: z.string(), agentId: z.string().nullable(), attemptId: z.string().uuid(),
  generation: z.number().int().positive(), phase: z.enum(phases), createdAt: z.number(), deadlineAt: z.number(),
  turnId: z.string().nullable(), lastFinishedTurnId: z.string().nullable(), subjectGeneration: z.number().nullable(),
  reportPath: z.string().nullable(), error: z.string().nullable(),
  review: z.object({ reviewerTaskId: z.string().uuid(), generation: z.number(), verdict: z.enum(["pass", "block"]), note: z.string() }).nullable(),
});
export type Task = z.infer<typeof TaskSchema>;
const MessageSchema = z.object({
  id: z.string().uuid(), key: z.string(), taskId: z.string().uuid(), attemptId: z.string().uuid(),
  recipientId: z.string().nullable(), body: z.string(), attempts: z.number().int().nonnegative(),
  status: z.enum(["pending", "sent", "acknowledged", "blocked", "superseded", "awaiting_operator"]),
  nextAttemptAt: z.number(), deadlineAt: z.number(), error: z.string().nullable(),
});
export type Notification = z.infer<typeof MessageSchema>;
const StateSchema = z.object({ schemaVersion: z.literal(1), tasks: z.record(z.string(), TaskSchema), messages: z.record(z.string(), MessageSchema), seen: z.array(z.string()) });
type State = z.infer<typeof StateSchema>;
export interface AgentSnapshot { id: string; cwd: string; provider: string; model?: string | null; status: string; archived: boolean; pendingPermissions: number; }
export interface Transport {
  workspace(id: string): Promise<{ cwd: string } | null>;
  create(task: Task, env: Record<string, string>): Promise<string>;
  snapshot(id: string): Promise<AgentSnapshot | null>;
  send(id: string, text: string, messageId: string, sourceAgentId?: string): Promise<void>;
  report(id: string): Promise<unknown[]>;
}

export class Manager {
  readonly root: string;
  readonly config: Config;
  readonly transport: Transport;
  readonly state: State;
  private lock: CoordinatorLock;
  private now: () => number;
  private disposed = false;
  private ticking: Promise<void> | null = null;
  private draining: Promise<void> | null = null;

  constructor(root: string, config: Config, transport: Transport, now = Date.now) {
    this.root = root;
    this.config = config;
    this.transport = transport;
    this.now = now;
    this.lock = new CoordinatorLock(root);
    this.lock.acquire();
    try { this.state = StateSchema.parse(readJson(join(root, "orchestration.json")) ?? { schemaVersion: 1, tasks: {}, messages: {}, seen: [] }); }
    catch (error) { this.lock.release(); throw error; }
  }
  private save(): void { if (!this.disposed) saveJson(join(this.root, "orchestration.json"), this.state); }
  private task(id: string): Task {
    const task = this.state.tasks[id];
    if (!task) throw new Error("任务不存在");
    return task;
  }
  private current(task: Task, attemptId: string): boolean { return !this.disposed && task.attemptId === attemptId; }
  private find(agentId: string): Task | undefined { return Object.values(this.state.tasks).find(task => task.agentId === agentId); }
  private active(task: Task): boolean { return ["launching", "running", "waiting_permission", "collecting_report"].includes(task.phase); }
  private allowed(provider: string): boolean { return this.config.allowedProviders.some(value => value === provider || value === provider.split("/")[0]); }

  async create(input: unknown): Promise<Task> {
    const spec = TaskInputSchema.parse(input);
    if (!this.allowed(spec.provider)) throw new Error("提供方不在明确允许的列表中；不自动替换提供方或模型");
    for (const id of spec.dependsOn) this.task(id);
    let subjectGeneration: number | null = null;
    if (spec.role === "reviewer") {
      if (!spec.subjectTaskId) throw new Error("审查任务必须绑定被审查任务");
      const subject = this.task(spec.subjectTaskId);
      if (subject.phase !== "awaiting_review") throw new Error("被审查任务尚未进入审查阶段");
      if (subject.workspaceId !== spec.workspaceId) throw new Error("审查任务必须绑定同一工作目录");
      subjectGeneration = subject.generation;
    }
    const workspace = await this.transport.workspace(spec.workspaceId);
    if (!workspace) throw new Error("工作目录不存在或已经归档");
    if (this.disposed) throw new Error("插件正在停止");
    const task: Task = { ...spec, id: randomUUID(), cwd: realpathSync(workspace.cwd), agentId: null, attemptId: randomUUID(), generation: 1, phase: "queued", createdAt: this.now(), deadlineAt: this.now() + spec.timeoutMs, turnId: null, lastFinishedTurnId: null, subjectGeneration, reportPath: null, error: null, review: null };
    this.state.tasks[task.id] = task;
    this.save();
    return task;
  }

  environment(task: Task): Record<string, string> {
    return { AGENT_POLICY_MANAGED: "1", AGENT_POLICY_STATE_DIR: this.root, AGENT_POLICY_TASK_ID: task.id, AGENT_POLICY_ATTEMPT_ID: task.attemptId, AGENT_POLICY_ROLE: task.role, ...(this.config.piConfigPath ? { PI_EXECUTION_POLICY_CONFIG: this.config.piConfigPath } : {}) };
  }
  private bind(task: Task): void {
    if (task.agentId) saveJson(join(this.root, "bindings", `${digest(task.agentId)}.json`), { taskId: task.id, attemptId: task.attemptId, generation: task.generation, role: task.role });
  }

  private async launchReady(): Promise<void> {
    for (const task of Object.values(this.state.tasks)) {
      if (this.disposed || task.phase !== "queued") continue;
      if (task.dependsOn.some(id => this.task(id).phase !== "accepted")) continue;
      const all = Object.values(this.state.tasks);
      if (all.filter(value => this.active(value)).length >= this.config.maxActive) break;
      if (task.role === "worker" && all.some(other => other.id !== task.id && other.cwd === task.cwd && other.role === "worker" && other.phase !== "accepted" && other.phase !== "queued")) continue;
      if (task.role === "reviewer" && task.subjectTaskId && this.task(task.subjectTaskId).generation !== task.subjectGeneration) { task.phase = "blocked"; task.error = "被审查内容所属阶段已经变化"; this.save(); continue; }
      if (task.role === "reviewer") {
        const freeze = join(this.root, "freezes", `${digest(task.cwd)}.json`);
        if (existsSync(freeze)) { task.phase = "blocked"; task.error = "该目录已有独立审查，不重复创建审查者"; this.save(); continue; }
        saveJson(freeze, { taskId: task.subjectTaskId, reviewerTaskId: task.id, generation: task.subjectGeneration });
      }
      task.phase = "launching";
      task.deadlineAt = this.now() + task.timeoutMs;
      task.agentId = randomUUID();
      this.bind(task);
      this.save();
      const attempt = task.attemptId;
      try {
        const actual = await this.transport.create(task, this.environment(task));
        if (!this.current(task, attempt)) continue;
        if (actual !== task.agentId) throw new Error("创建结果与持久记录的 agent 编号不一致");
      } catch (error) {
        if (!this.current(task, attempt)) continue;
        task.phase = "blocked"; task.error = `创建未确认，不重复派发：${error}`;
        this.notify(task, "launch-failed", task.error);
        this.save();
      }
    }
  }

  started(agentId: string, turnId: string | null): void {
    const task = this.find(agentId);
    if (!task || this.disposed) return;
    if (task.phase === "accepted") return;
    if (task.phase === "running" && task.turnId === turnId) return;
    if (task.phase !== "launching" || (task.generation > 1 && turnId === task.lastFinishedTurnId)) {
      task.phase = "blocked"; task.error = "收到无法对应当前执行阶段的开始事件，需要核对实际状态"; this.save(); return;
    }
    task.turnId = turnId;
    task.phase = "running";
    this.save();
  }

  async ended(agentId: string, turnId: string | null, outcome: { kind: "completed" | "failed" | "canceled"; error?: { message: string } }): Promise<void> {
    const task = this.find(agentId);
    if (!task || this.disposed || task.phase === "accepted") return;
    const key = `${task.id}:${task.attemptId}:ended:${turnId ?? "none"}`;
    if (this.state.seen.includes(key)) return;
    if (!["running", "waiting_permission"].includes(task.phase) || task.turnId !== turnId) return;
    this.state.seen.push(key);
    task.lastFinishedTurnId = turnId;
    const attempt = task.attemptId;
    if (outcome.kind !== "completed") {
      task.phase = outcome.kind === "failed" ? "failed" : "canceled";
      task.error = outcome.error?.message ?? "执行已取消；未验收的改动仍需保留";
      this.notify(task, "ended", task.error);
      this.save();
      return;
    }
    task.phase = "collecting_report";
    this.save();
    try {
      const report = await this.transport.report(agentId);
      if (!this.current(task, attempt)) return;
      if (!report.length) throw new Error("执行历史为空，不能按完成处理");
      task.reportPath = join(this.root, "reports", task.id, `${attempt}.json`);
      saveJson(task.reportPath, { taskId: task.id, attemptId: attempt, generation: task.generation, entries: report });
      task.phase = "awaiting_review";
      task.error = null;
      this.notify(task, "ended", `任务 ${task.title} 的回合已结束，等待审查和用户验收；报告：${task.reportPath}`);
    } catch (error) {
      if (!this.current(task, attempt)) return;
      task.phase = "blocked"; task.error = `报告未取得：${error}`;
      this.notify(task, "report-failed", task.error);
    }
    this.save();
  }

  permission(agentId: string, requestId: string, resolved = false): void {
    const task = this.find(agentId);
    if (!task || this.disposed || !["running", "waiting_permission"].includes(task.phase)) return;
    if (resolved) { task.phase = "running"; this.save(); return; }
    task.phase = "waiting_permission";
    this.notify(task, `permission:${requestId}`, `任务 ${task.title} 等待审批 ${requestId}；请在 Paseo 原有审批界面处理，通知不是批准。`);
    this.save();
  }

  private notify(task: Task, suffix: string, body: string, id: string = randomUUID()): void {
    const key = `${task.id}:${task.attemptId}:${suffix}`;
    if (Object.values(this.state.messages).some(message => message.key === key)) return;
    this.state.messages[id] = { id, key, taskId: task.id, attemptId: task.attemptId, recipientId: task.parentAgentId ?? null, body, attempts: 0, status: task.parentAgentId ? "pending" : "awaiting_operator", nextAttemptAt: this.now(), deadlineAt: this.now() + this.config.notificationTimeoutMs, error: null };
  }

  private ingestRequests(): void {
    const directory = join(this.root, "requests");
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
      const request = z.object({ id: z.string().uuid(), taskId: z.string().uuid(), actorId: z.string(), attemptId: z.string().uuid(), message: z.string().min(1).max(16384) }).safeParse(readJson(join(directory, name)));
      if (!request.success) continue;
      const task = this.state.tasks[request.data.taskId];
      if (!task || ["accepted", "canceled"].includes(task.phase) || task.agentId !== request.data.actorId || task.attemptId !== request.data.attemptId) continue;
      this.notify(task, `decision:${request.data.id}`, request.data.message, request.data.id);
    }
    this.save();
  }

  async drain(): Promise<void> {
    if (this.disposed) return;
    if (this.draining) return this.draining;
    this.draining = this.drainPending();
    try { await this.draining; } finally { this.draining = null; }
  }

  private async drainPending(): Promise<void> {
    for (const message of Object.values(this.state.messages)) {
      if (this.disposed || !["pending", "sent"].includes(message.status)) continue;
      const task = this.task(message.taskId);
      if (message.attemptId !== task.attemptId) { message.status = "superseded"; this.save(); continue; }
      const ack = readJson<{ recipientId: string }>(join(this.root, "acks", `${message.id}.json`));
      if (ack?.recipientId === message.recipientId) { message.status = "acknowledged"; this.save(); continue; }
      if (this.now() >= message.deadlineAt) { message.status = "blocked"; message.error = "通知已超过截止时间，尚未收到回执"; this.save(); continue; }
      if (message.nextAttemptAt > this.now() || !message.recipientId) continue;
      if (message.attempts >= this.config.maxNotificationAttempts) { message.status = "blocked"; message.error = "已达到发送次数上限，尚未收到回执"; this.save(); continue; }
      let recipient;
      try { recipient = await this.transport.snapshot(message.recipientId); }
      catch (error) { message.error = String(error); message.nextAttemptAt = this.now() + this.config.retryDelaysMs[0]; this.save(); continue; }
      if (this.disposed || message.attemptId !== task.attemptId) continue;
      if (!recipient || recipient.archived) { message.status = "blocked"; message.error = "上游不存在或已经归档，不唤醒或恢复归档对象"; this.save(); continue; }
      if (recipient.pendingPermissions || recipient.status === "running") {
        message.nextAttemptAt = this.now() + this.config.retryDelaysMs[0]; this.save(); continue;
      }
      saveJson(join(this.root, "inbox", digest(message.recipientId), `${message.id}.json`), { id: message.id, recipientId: message.recipientId, body: message.body, taskId: message.taskId, attemptId: message.attemptId });
      message.attempts++;
      message.status = "sent";
      message.nextAttemptAt = this.now() + this.config.retryDelaysMs[Math.min(message.attempts - 1, this.config.retryDelaysMs.length - 1)];
      this.save();
      try {
        await this.transport.send(message.recipientId, `<agent-message>\nmessageId=${message.id}\n${message.body}\n收到后调用 policy_ack 登记回执；回执不代表批准或验收。\n</agent-message>`, message.id, task.agentId ?? undefined);
        message.error = null;
      } catch (error) { message.error = `发送未确认：${error}`; }
      this.save();
    }
  }

  async reconcile(): Promise<void> {
    for (const task of Object.values(this.state.tasks)) {
      if (this.disposed || !this.active(task) || !task.agentId) continue;
      const attempt = task.attemptId;
      try {
        const snapshot = await this.transport.snapshot(task.agentId);
        if (!this.current(task, attempt)) continue;
        if (!snapshot || snapshot.archived) throw new Error("执行对象不存在或已经归档");
        if (realpathSync(snapshot.cwd) !== task.cwd || snapshot.provider.split("/")[0] !== task.provider.split("/")[0]) throw new Error("执行目录或提供方与任务不一致");
        const expectedModel = task.provider.includes("/") ? task.provider.slice(task.provider.indexOf("/") + 1) : null;
        if (expectedModel && snapshot.model !== expectedModel) throw new Error("运行模型与任务指定模型不一致");
        if (this.now() >= task.deadlineAt) throw new Error("执行超过截止时间；没有终止或归档 agent，仍需检查其实际运行情况");
        if (task.phase === "launching") throw new Error("开始事件缺失；不自动接受无法对应阶段的结果");
        if (task.phase === "collecting_report") throw new Error("报告收集被中断；需要核对报告，不重新派发任务");
        if (snapshot.pendingPermissions) task.phase = "waiting_permission";
        else if (snapshot.status !== "running") throw new Error("完成事件缺失；请核对报告后显式处理，不重新派发任务");
      } catch (error) {
        if (!this.current(task, attempt)) continue;
        task.phase = "blocked"; task.error = String(error);
        this.notify(task, "reconcile-blocked", task.error);
      }
      this.save();
    }
  }

  async tick(): Promise<void> {
    if (this.disposed) return;
    if (this.ticking) return this.ticking;
    this.ticking = (async () => { this.ingestRequests(); await this.reconcile(); await this.launchReady(); await this.drain(); })();
    try { await this.ticking; } finally { this.ticking = null; }
  }

  async continueTask(id: string, prompt: string): Promise<void> {
    const task = this.task(id);
    if (!task.agentId || this.active(task) || ["queued", "accepted", "canceled"].includes(task.phase)) throw new Error("当前阶段不能继续同一执行者");
    const previousAttempt = task.attemptId;
    const snapshot = await this.transport.snapshot(task.agentId);
    if (!this.current(task, previousAttempt)) throw new Error("任务阶段已经变化");
    if (!snapshot || snapshot.archived || snapshot.status === "running" || snapshot.pendingPermissions) throw new Error("必须先确认原执行者已经空闲且没有待处理审批");
    if (task.role === "worker" && existsSync(join(this.root, "freezes", `${digest(task.cwd)}.json`))) throw new Error("独立审查尚未登记处理结果，不能恢复写入");
    task.attemptId = randomUUID(); task.generation++; task.phase = "launching"; task.turnId = null;
    task.review = null; task.reportPath = null; task.error = null; task.deadlineAt = this.now() + task.timeoutMs;
    this.bind(task); this.save();
    const attempt = task.attemptId;
    try { await this.transport.send(task.agentId, `[执行阶段 ${attempt}]\n${prompt}`, attempt); }
    catch (error) {
      if (!this.current(task, attempt) || task.phase !== "launching") return;
      task.phase = "blocked"; task.error = `继续执行未确认，不重复发送任务：${error}`; this.save();
    }
  }

  recordReview(id: string, reviewerId: string, verdict: "pass" | "block", note: string): void {
    const task = this.task(id);
    const reviewer = this.task(reviewerId);
    if (task.phase !== "awaiting_review" || reviewer.phase !== "awaiting_review" || !reviewer.reportPath || !existsSync(reviewer.reportPath)) throw new Error("实现或独立审查报告尚未取得");
    if (reviewer.role !== "reviewer" || reviewer.subjectTaskId !== id || reviewer.subjectGeneration !== task.generation || reviewer.agentId === task.agentId) throw new Error("审查者不独立或审查对应的执行阶段已经过期");
    const freezePath = join(this.root, "freezes", `${digest(task.cwd)}.json`);
    const freeze = readJson<{ taskId: string; reviewerTaskId: string; generation: number }>(freezePath);
    if (freeze?.taskId !== task.id || freeze.reviewerTaskId !== reviewerId || freeze.generation !== task.generation) throw new Error("审查归属与当前目录记录不一致，需要先核对");
    task.review = { reviewerTaskId: reviewerId, generation: task.generation, verdict, note };
    this.save();
    unlinkSync(freezePath);
  }

  accept(id: string): void {
    const task = this.task(id);
    if (task.phase !== "awaiting_review" || !task.reportPath || !existsSync(task.reportPath)) throw new Error("缺少当前阶段的报告，不能验收");
    if (task.role === "worker" && (!task.review || task.review.verdict !== "pass" || task.review.generation !== task.generation)) throw new Error("实现任务尚未登记通过的独立审查");
    task.phase = "accepted";
    this.save();
  }

  acknowledge(id: string): void {
    const message = this.state.messages[id];
    if (!message) throw new Error("消息不存在");
    message.status = "acknowledged";
    if (message.recipientId) saveJson(join(this.root, "acks", `${id}.json`), { recipientId: message.recipientId, acknowledgedAt: new Date(this.now()).toISOString() });
    this.save();
  }
  status(): string { return JSON.stringify({ collectedAt: new Date(this.now()).toISOString(), ...this.state }, null, 2); }
  close(): void { this.disposed = true; this.lock.release(); }
}
