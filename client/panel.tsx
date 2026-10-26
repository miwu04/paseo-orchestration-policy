import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ActionSchema, control } from "../shared/contracts.ts";

export function PolicyPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const invoke = useRpc(control);
  const [input, setInput] = useState('{"action":"status"}');
  const [output, setOutput] = useState("尚未读取编排状态");
  const [busy, setBusy] = useState(false);
  const foreground = { color: theme.colors.foreground };
  const fill = (action: string) => {
    if (action === "create") setInput(JSON.stringify({ action, task: { workspaceId, title: "任务标题", provider: "pi", role: "worker", prompt: "填写完整的目标、允许路径、具体设计、验证要求和权限边界" } }, null, 2));
    else setInput(JSON.stringify({ action }, null, 2));
  };
  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const action = ActionSchema.parse(JSON.parse(input));
      const result = await invoke(action);
      setOutput(result.text);
    } catch (error) { setOutput(String(error)); }
    finally { setBusy(false); }
  }
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 12 }}>
    <Text style={foreground}>编排管理</Text>
    <Text style={foreground}>新建任务会创建并启动 agent；审查登记和验收均为用户操作，不会推送、归档或自动重试实现任务。</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {[["status", "读取状态"], ["create", "填写新任务"], ["reconcile", "核对运行状态"]].map(([action, label]) =>
        <Pressable key={action} disabled={busy} onPress={() => fill(action)} accessibilityRole="button" style={{ padding: 10, backgroundColor: theme.colors.surface1 }}>
          <Text style={foreground}>{label}</Text>
        </Pressable>)}
    </View>
    <TextInput value={input} onChangeText={setInput} editable={!busy} multiline autoCapitalize="none" autoCorrect={false}
      accessibilityLabel="编排操作 JSON" style={{ ...foreground, backgroundColor: theme.colors.surface1, minHeight: 160, padding: 12, textAlignVertical: "top" }} />
    <Pressable disabled={busy} onPress={() => void run()} accessibilityRole="button" style={{ padding: 12, backgroundColor: theme.colors.surface1 }}>
      <Text style={foreground}>{busy ? "正在执行" : "执行已填写的操作"}</Text>
    </Pressable>
    <Text selectable style={foreground}>{output}</Text>
  </ScrollView>;
}
