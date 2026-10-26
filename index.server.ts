import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ConfigSchema, control } from "./shared/contracts.ts";
import { Manager } from "./server/manager.ts";
import { transport } from "./server/transport.ts";

export default function contribute(server: PluginServerContext) {
  const root = resolve(process.env.AGENT_POLICY_STATE_DIR ?? join(homedir(), ".local", "state", "agent-policy"));
  const configPath = process.env.PASEO_ORCHESTRATION_POLICY_CONFIG ?? join(root, "config.json");
  const config = (() => {
    try { return ConfigSchema.parse(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}); }
    catch (error) { throw new Error("编排配置无效，插件未启用任何自动操作", { cause: error }); }
  })();
  let manager: Manager | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const ensure = (paseo: PaseoApi) => {
    if (stopped) throw new Error("插件正在停止");
    if (!manager) {
      manager = new Manager(root, config, transport(paseo));
      timer = setInterval(() => { void manager?.tick().catch(error => console.error("编排状态核对失败：", String(error))); }, config.reconcileIntervalMs);
      timer.unref();
    }
    return manager;
  };

  const off = [
    server.before("agent.create", ({ request }, { paseo }) => {
      if (request.env?.AGENT_POLICY_MANAGED !== "1") return;
      const current = ensure(paseo);
      const task = current.state.tasks[request.env.AGENT_POLICY_TASK_ID ?? ""];
      if (!task || task.phase !== "launching" || task.attemptId !== request.env.AGENT_POLICY_ATTEMPT_ID) throw new Error("创建请求未对应已授权的任务阶段");
      const provider = task.provider.split("/")[0];
      const model = task.provider.includes("/") ? task.provider.slice(provider.length + 1) : null;
      if (request.config.provider !== provider || (model && request.config.model !== model)) throw new Error("创建请求改变了指定的提供方或模型");
      const role = task.role === "worker" ? "实现者：只在用户登记的路径和阶段内工作，不得自行批准或推送。" : "只读角色：不修改业务文件，不提交，不创建下级 agent。";
      return { ...request, config: { ...request.config, systemPrompt: [request.config.systemPrompt, role, "预算、次数和状态以插件记录为准；不能为节省调用省略必要核验。"].filter(Boolean).join("\n") }, env: { ...request.env, ...current.environment(task) } };
    }),
    server.before("agent.session_open", ({ request }, { paseo }) => {
      const current = ensure(paseo);
      const task = Object.values(current.state.tasks).find(task => task.agentId === request.agentId);
      if (!task) return;
      if (resolve(request.cwd) !== task.cwd || request.provider !== task.provider.split("/")[0]) throw new Error("恢复请求与任务目录或提供方不一致");
      return { ...request, env: { ...request.env, ...current.environment(task) } };
    }),
    server.before("workspace.create", ({ request }) => {
      if (!config.enforceWorktreeCreation || request.source.kind !== "directory") return;
      return { ...request, source: { kind: "worktree" as const, cwd: request.source.path, action: "branch-off" as const } };
    }),
    server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => { ensure(paseo).started(agent.id, turnId); }),
    server.on("agent.turn_ended", async ({ agent, turnId, outcome }, { paseo }) => { await ensure(paseo).ended(agent.id, turnId, outcome); }),
    server.on("agent.permission_requested", ({ agent, request }, { paseo }) => { ensure(paseo).permission(agent.id, request.id); }),
    server.on("agent.permission_resolved", ({ agent, requestId }, { paseo }) => { ensure(paseo).permission(agent.id, requestId, true); }),
  ];

  server.handle(control, async (input, { paseo }) => {
    const current = ensure(paseo);
    if (input.action === "create") await current.create(input.task);
    else if (input.action === "continue") await current.continueTask(input.taskId, input.prompt);
    else if (input.action === "review") current.recordReview(input.taskId, input.reviewerTaskId, input.verdict, input.note);
    else if (input.action === "accept") current.accept(input.taskId);
    else if (input.action === "ack") current.acknowledge(input.messageId);
    if (input.action !== "status") await current.tick();
    return { text: current.status() };
  });

  return () => {
    stopped = true;
    clearInterval(timer);
    for (const remove of off) remove();
    manager?.close();
  };
}
