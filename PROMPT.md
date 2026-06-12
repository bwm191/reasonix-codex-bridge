Goal: 实现 Codex → Reasonix MCP Bridge，严格按照 PLAN.md 逐 Phase 执行。

## 参考文档
- 总计划：PLAN.md（项目根目录，请先全文阅读）
- 项目记忆：codex-reasonix-bridge-master-plan（Reasonix 记忆，含完整设计决策）

## 执行规则

### Phase 推进
按 PLAN.md 的 Phase 0 → 0.5 → 1 → 2 → 3 → 4 → 5 顺序执行。每个 Phase 完成后：
1. 用 `complete_step` 标记该 Phase 完成，附验证证据
2. **立即调用子 agent 做严格 review**（见下方 review 规则）
3. review 通过后才能进入下一 Phase

### Review 规则（每个 Phase 完成后强制执行）
对当前 Phase 的产出调用 review 子 agent，review 必须覆盖：
- **正确性**：代码逻辑与 PLAN.md 中的设计决策一致，状态机转换无遗漏
- **完整性**：该 Phase 所有子任务都已实现，无 TODO 残留
- **安全性**：无路径穿越、命令注入、敏感信息泄露风险
- **契约符合度**：所有 POST 带 Content-Type；SSE parser 正确处理 ping keepalive；错误类型使用 PLAN.md 定义的 10 种分层
- 非关键的 style/nit 建议可以标记为 optional，不必阻塞

### 决策原则
- PLAN.md 中有明确定义的，直接照做，不重新讨论
- PLAN.md 中标记为"开工前确认"的 5 项决策，在 Phase 0 中完成确认并记录到 `contracts/mcp-sdk-decision.md`
- 遇到 PLAN.md 未覆盖的实现细节，选择最保守方案并记录到 `DESIGN-NOTES.md`

### 关键提醒
- `reasonix serve` 不是 `reasonix run`（Phase 0 验证时）
- 先连 SSE 再 POST /submit（Phase 2/3）
- `timed_out` 不是终态，必须有退出路径（Phase 2）
- approve/answer 默认 waitForTurn=true，批准后继续等 turn_done（Phase 3）
- MCP initialize 不因 Reasonix 不可达而失败（Phase 1）
- Codex 配置用 TOML 格式的 `.codex/config.toml`，不是 JSON

### 停止条件
- 任一 Phase 的 review 发现 blocking 问题，修复后重新 review，通过后再继续
- 遇到 PLAN.md 自身矛盾或无法按计划执行的情况，停止并报告
