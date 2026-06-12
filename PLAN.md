# Codex → Reasonix MCP Bridge 总计划

## 架构

```
Codex (MCP client) ──stdio──► reasonix-codex-bridge ──HTTP/SSE──► reasonix serve (127.0.0.1:8787)
```

bridge 本质上是一个 **Reasonix turn lifecycle manager + MCP adapter**，不只是 endpoint wrapper。核心模块是 `TurnCoordinator`：它管理 active turn、状态机、event buffer cursor、waiter、SSE 生命周期和并发控制。

---

## 核心设计决策（开工前锁定）

- MCP SDK 路线在 Phase 0 固定：验证 `@modelcontextprotocol/server`（v2）和 `@modelcontextprotocol/sdk`（v1）后二选一，产出 `contracts/mcp-sdk-decision.md`，固定具体版本并提交 lockfile，绝不混用两套 API
- `TurnCoordinator` 维护本地 `activeTurnId`（Reasonix 的 `/submit` 不保证返回 turn id）
- `TurnCoordinator` 维护 `eventBuffer` + `eventSeq` + `waiter.cursor`：approve/answer 后新 waiter 只消费 cursor 之后的事件，不重复消费已触发 pending 的旧事件
- `timed_out` 不是终态：后续收到 `turn_done`、确认 Reasonix idle、或 cancel 成功后必须退出
- `completed` 返回结构固定（含 `status`、`response`、`activeTurnId`、`historyMessageCount`、`events`、`usage`），不返回自由文本
- `reasonix_new_session` 默认不允许在 active turn 期间执行；`force=true` 时先 cancel 再 new
- bridge 启动时 Reasonix 已 `running=true` → 进入 `running_unknown`，不假装可恢复已错过的 SSE 事件

---

## Phase 0 — 契约验证 + SDK 路线决策

- 运行 `npm info @modelcontextprotocol/server` 和 `npm info @modelcontextprotocol/sdk`，记录版本、发布时间、文档入口和 import path
- 二选一决策并产出 `contracts/mcp-sdk-decision.md`：v2 用 `@modelcontextprotocol/server`，或稳定路线用 `@modelcontextprotocol/sdk` v1.x；固定版本，后续提交 `package-lock.json`
- 启动 `reasonix serve --addr 127.0.0.1:8787`（**不是** `reasonix run`）
- 先建立 `GET /events` SSE 连接，再 `POST /submit {"input":"echo hello"}`——确保不丢事件
- 逐项探测每个 endpoint 的 method、body、成功/错误响应码和 shape：`/status`、`/context`、`/history`、`/submit`、`/cancel`、`/approve`、`/answer`、`/plan`、`/new`
- 抓完整 SSE 流直到 `turn_done`，记录所有 `kind` 枚举值、事件顺序、每个事件的字段
- 编写 `test/smoke.mjs`：用 `fetch` + `ReadableStream` 手工解析 SSE（不用 `EventSource`），验证 submit → 等 `turn_done` → 读 `/history`
- 产出 `contracts/reasonix-http-api.md`、`test/smoke.mjs`、`contracts/mcp-sdk-decision.md`

---

## Phase 0.5 — HTTP client + SSE parser 独立原型（接 MCP 前的必要步骤）

- 实现 `src/sse.ts`：`fetch` + `ReadableStream` 手工解析 `data:` frame，忽略 `: ping`，输出 `AsyncIterable<ReasonixEvent>`
- 实现 `src/reasonix-client.ts`：typed HTTP client，封装所有 endpoint，所有 POST 强制 `Content-Type: application/json`
- 独立 node 脚本验证三条路径（不用 `EventSource`）：
  - submit → `turn_done` → history
  - submit → `approval_request` → approve → `turn_done`
  - submit → `ask_request` → answer → `turn_done`

---

## Phase 1 — 最小 MCP bridge + minimal TurnCoordinator

- 初始化项目：`package.json`（`"type": "module"`）、`tsconfig.json`（ES2022/Node16）、安装选定的 MCP SDK 固定版本
- 实现 minimal `TurnCoordinator`：connected/busy 检查、active turn 标记、submit mutex、cancel 后状态清理（event buffer/waiter 留到 Phase 2）
- 实现 MCP stdio server，注册 4 个核心工具（均通过 TurnCoordinator）：
  - `reasonix_status` — Reasonix 不可达时仍返回 `connected: false` + 诊断，不抛错
  - `reasonix_submit_async` — 通过 TurnCoordinator 避免并发 submit，POST 后立即返回 `{ accepted, running, hint }`
  - `reasonix_history` — 参数 `limit?` / `includeToolCalls?` / `includeReasoning?`
  - `reasonix_cancel`
- MCP `initialize` 不因 Reasonix 不可达而失败；`reasonix_status` 负责诊断
- bridge 启动时若 Reasonix 已 `running=true`：TurnCoordinator 标记 `running_unknown`，新 submit 返回 `reasonix_busy`，提示用户用 `reasonix_history` 或 `reasonix_cancel` 恢复

---

## Phase 2 — 完整 TurnCoordinator + 同步 submit + SSE 生命周期

- 扩展 TurnCoordinator 状态机：

```ts
type TurnState =
  | { kind: "idle" }
  | { kind: "submitting"; activeTurnId: string }
  | { kind: "running"; activeTurnId: string; startedAt: number }
  | { kind: "pending_approval"; activeTurnId: string; approvalId: string }
  | { kind: "pending_ask"; activeTurnId: string; askId: string }
  | { kind: "timed_out"; activeTurnId: string; runningMayContinue: true }
  | { kind: "running_unknown"; reason: string }
  | { kind: "disconnected"; runningUnknown: true }
```

- `timed_out` 退出路径：
  - SSE 收到 `turn_done` → completed/idle
  - status 显示 `running=false` → idle
  - cancel 成功 → idle
  - SSE 断线且仍 running → `running_unknown`
- event buffer cursor 机制：
  - 每收到 SSE event 分配递增 `seq`
  - `reasonix_submit` 创建 waiter 时 `cursor = currentSeq`
  - pending 后当前 waiter 返回但 buffer 保留
  - approve/answer 创建新 waiter，`cursor = currentSeq`，只消费新事件
  - `includeEvents=true` 时可返回整个 turn buffer；默认不返回完整事件
- 单例 SSE listener：
  - 先连 SSE 再 POST /submit（确保不丢事件）
  - 支持断线重连（指数退避，最多 3 次）
  - 重连失败时等待者收到 `sse_reconnect_failed` 错误
- `reasonix_submit`：
  - 参数 `input`、`timeoutMs?`（默认 300s）、`includeEvents?`、`includeReasoning?`
  - 等待 completed / pending_approval / pending_ask / timeout / disconnected
  - `turn_done.err` 时返回 `isError: true`
- `completed` 返回结构：

```json
{
  "status": "completed",
  "response": "final assistant message text",
  "activeTurnId": "local-uuid",
  "historyMessageCount": 12,
  "eventsIncluded": false,
  "events": [],
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  }
}
```

- `response` 默认取 `/history` 最后一条 assistant content；fallback 用本 turn text/message 事件拼接
- `events` 仅在 `includeEvents=true` 时返回；reasoning 仅 `includeReasoning=true` 时返回
- timeout 后不 cancel Reasonix；返回 `isError: true`，提示用 `reasonix_status`/`reasonix_history`/`reasonix_cancel` 恢复

---

## Phase 3 — 交互式控制工具

- `reasonix_approve`：
  - 参数 `id`、`allow`、`session?`、`persist?`、`waitForTurn?`（默认 `true`）、`timeoutMs?`
  - `waitForTurn=true` 时 POST /approve 后继续等待 `turn_done` / 新 `approval_request` / 新 `ask_request` / timeout
  - `waitForTurn=false` 返回 `{ status: "approval_sent", hint: "Use reasonix_status or reasonix_history to inspect the result." }`
- `reasonix_answer`：
  - 参数 `id`、`answers`、`waitForTurn?`（默认 `true`）、`timeoutMs?`
  - 同上逻辑，POST /answer
  - `waitForTurn=false` 返回 `{ status: "answer_sent", hint: "..." }`
- `reasonix_plan_mode`：参数 `on`，POST /plan
- `reasonix_new_session`：
  - 默认 `force=false`
  - active turn 期间拒绝返回 `reasonix_busy`
  - `force=true` 时：POST /cancel → 轮询 status → POST /new → 清空 TurnCoordinator → 验证 history
- `reasonix_cancel`：
  - idle 时优雅返回 `{ status: "idle", cancelled: false, message: "No active Reasonix turn." }`
  - active turn 时 POST /cancel → 清空 pending → 标记 waiter cancelled → 轮询 status
  - 短时间仍 running 返回 `{ status: "cancel_requested", running: true }`
- `reasonix_context`：GET /context
- 暂不暴露高级 endpoint（`/rewind`、`/fork`、`/summarize`、`/tool-approval-mode`）

---

## Phase 4 — 运维、安全与文档

- auto-launch **默认关闭**；`REASONIX_AUTO_LAUNCH=true` 时 spawn `reasonix serve --addr 127.0.0.1:${PORT}`，退出时 SIGTERM
- 环境变量：`REASONIX_SERVE_URL`（默认 `http://127.0.0.1:8787`）、`REASONIX_COMMAND`、`REASONIX_ARGS`、`REASONIX_CWD`、`REASONIX_DEFAULT_TIMEOUT_MS`（300000）
- 安全边界：默认只连 127.0.0.1；README 明确禁止暴露到公网/局域网；所有 POST 强制 `Content-Type: application/json`（Reasonix serve 本身无 auth，仅靠 localhost + CSRF guard）
- 错误分层：`connection_refused` / `timeout` / `reasonix_busy` / `pending_approval` / `pending_ask` / `sse_disconnected` / `sse_reconnect_failed` / `contract_mismatch` / `missing_field` / `turn_done_error`
- Codex `.codex/config.toml` 配置片段：
  ```toml
  [mcp_servers.reasonix]
  command = "node"
  args = ["/absolute/path/to/reasonix-codex-bridge/build/index.js"]
  startup_timeout_sec = 10
  tool_timeout_sec = 330
  enabled = true
  ```
  `tool_timeout_sec` 比 bridge 默认 timeout（300s）多 10–30s
- 可选 progress notifications：如果 MCP request `_meta` 含 `progressToken`，节流转发 SSE 事件为 `notifications/progress`；不伪造百分比
- README：架构图、环境变量表、完整工具清单（含参数 schema）、Codex TOML 配置示例、完整端到端示例

---

## Phase 5 — 测试矩阵

### 基础测试
- `reasonix_status` 在 Reasonix 未启动时返回 `connected: false` + 诊断
- `reasonix_status` 在 Reasonix 启动后返回 running/plan/label/cwd/used/window
- `reasonix_submit_async` 提交成功
- `reasonix_history` 可读结果

### 同步 turn 测试
- `reasonix_submit` 简单任务返回 completed
- `turn_done.err` 返回 `isError: true`
- timeout 不 cancel Reasonix
- timeout 后再次 submit 返回 busy 提示

### 状态机测试
- `timed_out` 后收到 `turn_done` → 状态退出到 completed/idle
- `timed_out` 后 cancel 成功 → 状态退出到 idle
- bridge 启动时 Reasonix 已 `running=true` → 标记 `running_unknown`
- `running_unknown` 下新 submit 返回 `reasonix_busy`

### pending 测试
- `approval_request` → `pending_approval`
- `reasonix_approve(waitForTurn=true)` 后等到 completed
- `ask_request` → `pending_ask`
- `reasonix_answer(waitForTurn=true)` 后等到 completed

### cursor 测试
- submit 遇到 `approval_request` 后返回 pending
- approve 后新 waiter 不重复消费旧 approval event
- ask 同理
- approve 后再次出现 approval request 时返回新的 pending，而不是旧 pending

### 返回结构测试
- completed 返回结构包含 `status`
- completed 返回结构包含 `response`
- `includeEvents=false` 时不返回完整事件
- `includeEvents=true` 时返回 events
- `includeReasoning=false` 时不返回 reasoning
- `includeReasoning=true` 时返回 reasoning（如果存在）

### 并发测试
- 两个 `reasonix_submit` 同时调用，只允许一个进入
- active turn 期间新 submit 返回 `reasonix_busy`
- pending approval 期间新 submit 被拒
- pending approval 期间 approve 被允许

### cancel / new session 测试
- idle 状态下调用 `reasonix_cancel`，优雅返回
- active turn 下调用 `reasonix_new_session(force=false)`，返回 busy
- active turn 下调用 `reasonix_new_session(force=true)`，先 cancel，再 new
- `reasonix_approve(waitForTurn=false)` 立即返回，不注册 waiter
- `reasonix_answer(waitForTurn=false)` 立即返回，不注册 waiter

### SSE 测试
- `/events` 断线后最多重连 3 次
- 重连失败时等待者收到 `sse_reconnect_failed`
- 断线后可通过 status/history 恢复判断

### HTTP contract 测试
- POST 缺 `Content-Type` 时识别 415
- Reasonix endpoint 缺少字段时报 `contract_mismatch`，bridge 不崩溃
- `/status` shape 变化时报 `missing_field`，但 bridge 不崩溃

---

## 最终工具清单（10 个）

| 工具 | 用途 | Phase |
|------|------|-------|
| `reasonix_status` | 获取 Reasonix 连接状态和 session 信息 | 1 |
| `reasonix_submit_async` | 异步提交编码任务 | 1 |
| `reasonix_history` | 读取对话历史 | 1 |
| `reasonix_cancel` | 取消当前 turn | 1 |
| `reasonix_submit` | 同步提交并等待完成 | 2 |
| `reasonix_approve` | 批准/拒绝工具调用 | 3 |
| `reasonix_answer` | 回答 ask 问题 | 3 |
| `reasonix_plan_mode` | 切换 plan 模式 | 3 |
| `reasonix_new_session` | 新建 session | 3 |
| `reasonix_context` | 查询 context window 用量 | 3 |

---

## 开工前必须确认的 5 项

1. **MCP SDK 路线**：走 v1 (`@modelcontextprotocol/sdk`) 还是 v2 (`@modelcontextprotocol/server`)，固定包名和版本
2. **`timed_out` 退出路径**：四种退出方式的具体实现
3. **`completed` 返回结构**：字段语义和 fallback 逻辑
4. **event buffer cursor 机制**：pending → approve 的事件不重复消费
5. **active turn 下 cancel / new session 的行为**：force 模式的具体流程
