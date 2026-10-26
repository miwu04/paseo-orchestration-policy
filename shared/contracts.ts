import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const TaskInputSchema = z.object({
  workspaceId: z.string().min(1), parentAgentId: z.string().min(1).optional(),
  title: z.string().min(1).max(200), prompt: z.string().min(1).max(65_536),
  provider: z.string().min(1), role: z.enum(["worker", "reviewer", "scout", "researcher", "oracle", "evidence-auditor"]),
  subjectTaskId: z.string().uuid().optional(), dependsOn: z.array(z.string().uuid()).default([]),
  timeoutMs: z.number().int().positive().max(86_400_000).default(1_800_000),
}).strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("create"), task: TaskInputSchema }),
  z.object({ action: z.literal("continue"), taskId: z.string().uuid(), prompt: z.string().min(1).max(65_536) }),
  z.object({ action: z.literal("review"), taskId: z.string().uuid(), reviewerTaskId: z.string().uuid(), verdict: z.enum(["pass", "block"]), note: z.string().min(1) }),
  z.object({ action: z.literal("accept"), taskId: z.string().uuid() }),
  z.object({ action: z.literal("ack"), messageId: z.string().uuid() }),
  z.object({ action: z.literal("reconcile") }),
]);
export const control = defineRpc({ name: "orchestration-policy.control", input: ActionSchema, output: z.object({ text: z.string() }) });

export const ConfigSchema = z.object({
  allowedProviders: z.array(z.string().min(1)).min(1).default(["pi"]),
  maxActive: z.number().int().positive().max(20).default(5),
  maxNotificationAttempts: z.number().int().positive().max(10).default(3),
  retryDelaysMs: z.array(z.number().int().positive()).min(1).default([5000, 30000, 120000]),
  notificationTimeoutMs: z.number().int().positive().default(600000),
  reconcileIntervalMs: z.number().int().min(1000).default(5000),
  enforceWorktreeCreation: z.boolean().default(false),
  piConfigPath: z.string().optional(),
}).strict();
export type Config = z.infer<typeof ConfigSchema>;
