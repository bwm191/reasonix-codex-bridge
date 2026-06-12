# Codex → Reasonix MCP Bridge — 分 Session 执行提示词

总计划见 PLAN.md。分 3 个 goal session 执行，每段完成后**人工验收**再启动下一段。

---

## Session 1：Phase 0 + 0.5（契约验证 + SDK 决策 + 独立原型）

### Goal
完成 Reasonix HTTP/SSE 契约验证，做出 MCP SDK 路线决策，实现不接 MCP 的独立原型并通过三条路径验证。

### 具体任务

**Phase 0 — 契约验证**
1. 运行 `npm info @modelcontextprotocol/server` 和 `npm info @modelcontextprotocol/sdk`，记录版本和 import path
2. 二选一决策：v2 用 `@modelcontextprotocol/server`，v1 用 `@modelcontextprotocol/sdk`，固定版本
3. 产出 `contracts/mcp-sdk-decision.md`（选择 + 理由）
4. 启动 `reasonix serve --addr 127.0.0.1:8787`（不是 `reasonix run`）
5. **先** 连 `GET /events`，**再** `POST /submit {"input":"echo hello"}` — 确保不丢第一个事件
6. 抓完整 SSE 流直到 `turn_done`，记录所有 `kind` 枚举值和字段
7. 逐项探测 endpoint shape、响应码、错误格式：`/status` `/context` `/history` `/submit` `/cancel` `/approve` `/answer` `/plan` `/new`
8. 产出 `contracts/reasonix-http-api.md`

**Phase 0.5 — 独立原型**
1. 实现 `src/sse.ts`：`fetch` + `ReadableStream` 手工解析 SSE，忽略 `: ping`，输出 `AsyncIterable<ReasonixEvent>`
2. 实现 `src/reasonix-client.ts`：typed HTTP client，封装所有 endpoint，所有 POST 强制 `Content-Type: application/json`
3. 编写独立 node 脚本（测试用，不接 MCP）验证三条路径：
   - submit → `turn_done` → history
   - submit → `approval_request` → approve → `turn_done`
   - submit → `ask_request` → answer → `turn_done`
4. 不要使用 Node 原生 `EventSource`

**完成后**：`complete_step` 标记 → 调 review 子 agent → 通过后停止，不要进入 Phase 1。

### 关键提醒
- 不要用 `reasonix run` 抓 SSE，SSE 来自 `reasonix serve` 的 `/events`
- SDK 版本固定后提交 `package-lock.json`
- 测试脚本中不用 `EventSource`

---

## Session 2：Phase 1 + 2（MCP bridge + TurnCoordinator + 同步 submit）

### Goal
实现 MCP stdio server，注册核心工具，构建完整 TurnCoordinator 状态机，实现同步 submit 和 SSE 生命周期管理。

### 具体任务

**Phase 1 — 最小 MCP bridge**
1. 初始化项目：`package.json`（`"type": "module"`）、`tsconfig.json`（ES2022/Node16）、安装 Session 1 选定的 MCP SDK
2. 实现 minimal `TurnCoordinator`：connected/busy 检查、active turn 标记、submit mutex、cancel 后状态清理
3. 实现 MCP stdio server，注册 4 个核心工具：
   - `reasonix_status` — Reasonix 不可达时返回 `connected: false` + 诊断，**不抛错**
   - `reasonix_submit_async` — 通过 TurnCoordinator 避免并发
   - `reasonix_history` — `limit?` / `includeToolCalls?` / `includeReasoning?`
   - `reasonix_cancel`
4. MCP `initialize` 不因 Reasonix 不可达而失败
5. bridge 启动时若 Reasonix 已 `running=true`，TurnCoordinator 标记 `running_unknown`

**Phase 2 — 完整 TurnCoordinator + 同步 submit**
1. 扩展状态机到 8 个状态：`idle / submitting / running / pending_approval / pending_ask / timed_out / running_unknown / disconnected`
2. 实现 `timed_out` 四种退出路径：SSE 收 `turn_done` → completed/idle；status `running=false` → idle；cancel → idle；SSE 断线仍 running → `running_unknown`
3. 实现 event buffer cursor 机制：递增 seq；waiter cursor；pending 后 buffer 保留；approve/answer 新 waiter 只消费新事件
4. 单例 SSE listener：先连 SSE 再 POST /submit；断线重连指数退避最多 3 次
5. 实现 `reasonix_submit`：参数 `input` / `timeoutMs?`(300s) / `includeEvents?` / `includeReasoning?`
6. `completed` 返回固定结构：`{ status, response, activeTurnId, historyMessageCount, eventsIncluded, events, usage }`
7. timeout 后不 cancel Reasonix；返回 `isError: true`

**完成后**：`complete_step` 标记 → 调 review 子 agent → 通过后停止，不要进入 Phase 3。

---

## Session 3：Phase 3 + 4 + 5（交互式控制 + 运维安全 + 测试）

### Goal
实现所有交互式控制工具，完成运维加固、文档编写和全面测试。

### 具体任务

**Phase 3 — 交互式控制**
1. `reasonix_approve`：`waitForTurn=true` 默认；approve 后继续等 turn 结果；`waitForTurn=false` 返回 `approval_sent`
2. `reasonix_answer`：同上
3. `reasonix_plan_mode`
4. `reasonix_new_session`：`force=false` 默认；active turn 拒绝；`force=true` 先 cancel 再 new
5. `reasonix_cancel`：idle 优雅返回；active 清空 pending + 标记 waiter
6. `reasonix_context`

**Phase 4 — 运维安全**
1. auto-launch（默认关闭）；环境变量：`REASONIX_SERVE_URL` / `REASONIX_COMMAND` / `REASONIX_ARGS` / `REASONIX_CWD` / `REASONIX_DEFAULT_TIMEOUT_MS`
2. 安全：默认 127.0.0.1；README 警告不暴露公网
3. 10 种错误分层
4. Codex `.codex/config.toml` 配置片段（TOML 格式，`tool_timeout_sec` 315-330）
5. README：架构图、环境变量表、工具清单、配置示例、端到端示例

**Phase 5 — 测试矩阵**
按 PLAN.md Phase 5 的完整测试矩阵执行，覆盖：基础、同步 turn、状态机、pending、cursor、返回结构、并发、cancel/new session、SSE、HTTP contract。

**完成后**：`complete_step` 标记 → 调 review 子 agent → 最终验收。
