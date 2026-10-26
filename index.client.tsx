import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PolicyPanel } from "./client/panel.tsx";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({ id: "policy", title: "编排管理", icon: "ShieldCheck", context: "workspace", Component: PolicyPanel });
  const removeCommand = client.addCommandCenterItem({ id: "open-policy", title: "打开编排管理", icon: "ShieldCheck", context: "workspace", onSelect({ openPanel }) { openPanel("policy"); } });
  return () => { removeCommand(); removePanel(); };
}
