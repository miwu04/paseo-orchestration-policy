# Paseo Orchestration Policy

配置示例见 `orchestration-policy.example.json`，通过 `PASEO_ORCHESTRATION_POLICY_CONFIG` 指定配置，通过 `AGENT_POLICY_STATE_DIR` 指定共享状态目录，未指定时使用 `~/.local/state/agent-policy`；在 Command Center 打开“编排管理”，按 `actions.example.json` 填写操作，首次生命周期事件或面板请求取得连接后启动定时核对，重新加载后保留记录，异常退出遗留的 `coordinator.lock` 必须先人工核对旧进程与未完成操作再移走。

通知可能重复但使用稳定编号，发送成功不等于收到回执，观察到上游运行或等待审批时会延后发送；状态核对与发送不是原子操作，状态随后变化时按提供方的 `steer` 语义处理，不使用默认的 `interrupt`；验收操作不释放 Pi 写入归属，转交写入前须在原会话执行 `/policy revoke`，归档和独立终端不属于本插件的执行前拦截范围，项目源码未安装启用时不会管理任何 agent。
