import type { PaseoApi } from "@getpaseo/client";
import type { AgentSnapshot, Task, Transport } from "./manager.ts";

export function transport(paseo: PaseoApi): Transport {
  return {
    async workspace(id) {
      const value = await paseo.workspaces.ref(id).refresh();
      if (!value || value.archivingAt) return null;
      return { cwd: value.workspaceDirectory };
    },
    async create(task: Task, env) {
      const agent = await paseo.workspaces.ref(task.workspaceId).agents.create({
        config: { provider: task.provider }, agentId: task.agentId!, idempotencyKey: task.attemptId,
        parent: task.parentAgentId, title: task.title, env,
        labels: { "orchestration-policy.task-id": task.id, "orchestration-policy.role": task.role, "subagent-notifications": "off" },
      });
      if (task.provider.split("/")[0] === "pi") {
        const commands = await agent.commands();
        if (commands.error || !commands.commands.some(command => command.name === "policy")) {
          throw new Error("Pi 执行约束扩展尚未加载；已创建的空闲 agent 保留，不发送实现任务");
        }
      }
      await agent.send(`[任务 ${task.id}；执行阶段 ${task.attemptId}；角色 ${task.role}]\n${task.prompt}`, { messageId: task.attemptId, activeTurnBehavior: "steer" });
      return agent.id;
    },
    async snapshot(id): Promise<AgentSnapshot | null> {
      const value = (await paseo.agents.ref(id).refresh())?.agent;
      if (!value) return null;
      return { id: value.id, cwd: value.cwd, provider: value.provider, model: value.model, status: value.status, archived: Boolean(value.archivedAt), pendingPermissions: value.pendingPermissions.length };
    },
    async send(id, text, messageId, sourceAgentId) {
      // Avoid default interruption if the target starts a turn after inspection.
      await paseo.agents.ref(id).send(text, { messageId, sourceAgentId, activeTurnBehavior: "steer" });
    },
    async report(id) {
      const entries: unknown[] = [];
      let cursor: { epoch: string; seq: number } | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await paseo.agents.ref(id).timeline.refetch({ direction: cursor ? "before" : "tail", limit: 100, ...(cursor ? { cursor } : {}) });
        if (cursor && (!result.startCursor || result.startCursor.epoch !== cursor.epoch || result.startCursor.seq >= cursor.seq)) {
          throw new Error("执行历史的分页位置变化，不能把不完整报告当作完成");
        }
        entries.unshift(...result.entries);
        if (!result.hasOlder) return entries;
        if (!result.startCursor) throw new Error("执行历史缺少下一页位置，报告未完整取得");
        cursor = result.startCursor;
      }
      throw new Error("执行历史超过单次收集范围；报告未完整取得，不按完成处理");
    },
  };
}
