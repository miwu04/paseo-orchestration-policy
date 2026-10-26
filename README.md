# Paseo Orchestration Policy

配置示例见 `orchestration-policy.example.json`，通过 `PASEO_ORCHESTRATION_POLICY_CONFIG` 指定配置，通过 `AGENT_POLICY_STATE_DIR` 指定共享状态目录，未指定时使用 `~/.local/state/agent-policy`；在 Command Center 打开“编排管理”，按 `actions.example.json` 填写操作，首次生命周期事件或面板请求取得连接后启动定时核对，重新加载后保留记录。异常退出遗留的 `coordinator.lock` 在登记进程确实不存在时自动回收，回收过程用 `coordinator.lock.recovering` 串行化；登记进程仍存活、记录损坏或无法确认时拒绝启动并保留现场。

派发任务时声明角色和写入边界：`worker` 需要 `paths`（可写路径）和 `allowCommit`（是否允许提交），Pi 据此拒绝越界写入；未声明路径的 worker 无法写入。审查登记不接受父级口头的结论，必须存在审查者自己留下的记录（`reviews/<被审任务>.json`，含审查者 agent、执行阶段、结论和报告摘要），报告内容变化即失效。提交批准写入 `approvals/<任务>.json`，绑定单一 attempt、确切内容版本和路径集合。

通知可能重复但使用稳定编号，发送成功不等于收到回执，观察到上游运行或等待审批时会延后发送；没有父级 agent 的消息直接标记为等待人工查看，不假装已投递。状态核对与发送不是原子操作，状态随后变化时按提供方的 `steer` 语义处理，不使用默认的 `interrupt`；项目源码未安装启用时不会管理任何 agent，通过原生接口创建的 agent 记为未纳管，不注入角色也不受角色约束。
