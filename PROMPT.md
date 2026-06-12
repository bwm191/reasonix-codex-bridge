Goal: 实现 Codex → Reasonix MCP Bridge，严格按照 PLAN.md 从 Phase 0 一口气做到 Phase 5。

## 参考文档
- 总计划：PLAN.md（项目根目录，请先全文阅读）
- 项目记忆：codex-reasonix-bridge-master-plan（Reasonix 记忆）

## 执行规则

### Phase 推进
按 PLAN.md 顺序执行 Phase 0 → 0.5 → 1 → 2 → 3 → 4 → 5，不中断，不停下等人类确认。

每个 Phase 完成后两步：
1. `complete_step` 标记该 Phase 完成，附验证证据
2. **调 review 子 agent 严格审查当前 Phase 产出**
3. review 通过 → 立即进入下一 Phase
4. review 发现 blocking 问题 → 修复 → 重新 review → 通过后继续

### Review 规则（每个 Phase 完成后的子 agent review）
- **正确性**：代码逻辑与 PLAN.md 设计决策一致，状态机转换无遗漏
- **完整性**：该 Phase 所有子任务已实现，无 TODO 残留
- **安全性**：无路径穿越、命令注入、敏感信息泄露
- **契约符合度**：POST 带 Content-Type；SSE parser 正确处理 ping keepalive；错误类型使用 10 种分层
- 非关键 style/nit 标记为 optional，不阻塞

### 决策原则
- PLAN.md 有明确定义的，直接照做，不重新讨论
- "开工前确认"的 5 项在 Phase 0 中完成并记录到 `contracts/mcp-sdk-decision.md`
- PLAN.md 未覆盖的实现细节，选最保守方案并记入 `DESIGN-NOTES.md`

### 关键提醒
- `reasonix serve` 不是 `reasonix run`（Phase 0）
- 先连 SSE 再 POST /submit（Phase 2/3）
- `timed_out` 不是终态，必须有退出路径（Phase 2）
- approve/answer 默认 waitForTurn=true（Phase 3）
- MCP initialize 不因 Reasonix 不可达而失败（Phase 1）
- Codex 配置用 TOML：`.codex/config.toml`（Phase 4）
- MCP SDK 路线在 Phase 0 固定，后续不换

### 最终产出
- 完整的 `reasonix-codex-bridge/` 项目（10 个 MCP 工具、TurnCoordinator、SSE listener）
- `contracts/` 目录（SDK 决策 + HTTP API 契约）
- `PLAN.md` / `README.md` / `DESIGN-NOTES.md`
- `test/` 测试脚本
- 所有 Phase 的 review 报告
