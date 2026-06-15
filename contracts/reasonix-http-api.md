# Reasonix HTTP API Contract

**日期**: 2026-06-12
**Reasonix 版本**: `1.6.0-rc.1`
**Base URL**: `http://127.0.0.1:8787`

> 通过 `reasonix serve -addr 127.0.0.1:8787` 启动，实际探测结果。

---

## 通用约定

- **Content-Type**: 所有 POST/PUT 请求必须携带 `Content-Type: application/json`，否则返回 `415 Unsupported Media Type`
- **成功响应码**: 
  - `GET` → `200 OK` + JSON body
  - `POST` (fire-and-forget) → `202 Accepted` 或 `204 No Content`，body 为空
- **错误响应码**: `400 Bad Request`（参数缺失/无效）、`415 Unsupported Media Type`（缺 Content-Type）、`500 Internal Server Error`
- **未识别 GET 路径**: 返回 `200 OK` + SPA HTML（无 404 机制）
- **SSE**: `GET /events`，`Content-Type: text/event-stream`，支持 `: ping` keepalive

---

## Endpoint 清单

### 1. `GET /status`

**响应码**: `200 OK`

**响应体**:
```json
{
  "autoApproveTools": false,
  "balance": {
    "Available": true,
    "Infos": [{"Currency": "CNY", "TotalBalance": "14.59", "GrantedBalance": "0.00", "ToppedUpBalance": "14.59"}]
  },
  "bypass": false,
  "cacheHit": 0,
  "cacheMiss": 0,
  "cwd": "C:\\Users\\Administrator\\AppData\\Roaming\\reasonix\\sessions",
  "goal": "",
  "goalStatus": "stopped",
  "label": "deepseek-v4-pro",
  "lastUsage": {
    "PromptTokens": 0,
    "CompletionTokens": 0,
    "TotalTokens": 0,
    "CacheHitTokens": 0,
    "CacheMissTokens": 0,
    "ReasoningTokens": 0,
    "FinishReason": "stop"
  },
  "plan": false,
  "running": false,
  "toolApprovalMode": "ask",
  "used": 0,
  "window": 1000000
}
```

**关键字段**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `running` | boolean | 是否有活跃 turn |
| `plan` | boolean | plan 模式是否开启 |
| `toolApprovalMode` | string | `"ask"` / `"auto"` / `"yolo"` |
| `label` | string | 当前模型标签 |
| `used` | number | 当前 context window 已用 tokens |
| `window` | number | context window 总容量 |
| `cwd` | string | Reasonix 工作目录 |
| `autoApproveTools` | boolean | 是否自动批准工具 |
| `lastUsage` | object | 最后一次 turn 的 token 使用（仅在 turn 结束后存在） |

> **注**: `lastUsage` 字段在 turn 运行期间不存在；仅在 `running=false` 且有历史 turn 时出现。

---

### 2. `GET /context`

**响应码**: `200 OK`

**响应体**:
```json
{"used": 0, "window": 1000000}
```

---

### 3. `GET /history`

**查询参数**:
- `limit` (number, optional): 限制返回消息数

**响应码**: `200 OK`

**响应体**: `Message[]`

**Message 结构**:
```ts
type Message = 
  | { role: "system", content: string }
  | { role: "user", content: string }
  | { role: "assistant", content: string, reasoning?: string, toolCalls?: ToolCall[] }
  | { role: "tool", content: string, toolCallId: string, toolName: string }

type ToolCall = {
  id: string
  name: string
  arguments: string  // JSON string
}
```

**示例**:
```json
[
  {"role":"system","content":"You are Reasonix..."},
  {"role":"user","content":"echo hello world"},
  {"role":"assistant","content":"`hello world` — 搞定。","reasoning":"Another echo hello world. Done.","toolCalls":[{"id":"call_00_xxx","name":"bash","arguments":"{\"command\": \"echo hello world\"}"}]},
  {"role":"tool","content":"hello world\n","toolCallId":"call_00_xxx","toolName":"bash"}
]
```

---

### 4. `GET /events` (SSE)

**响应码**: `200 OK`
**Content-Type**: `text/event-stream`

**SSE 事件流**。连接后首先收到 `: connected`（ping comment），随后按 turn 推进收到各类事件。

**事件种类（kind 枚举）**:

| kind | 字段 | 说明 |
|------|------|------|
| `turn_started` | — | turn 开始 |
| `reasoning` | `text: string` | 推理流片段 |
| `text` | `text: string` | 输出文本流片段 |
| `message` | `text: string`, `reasoning?: string` | 完整消息（含 reasoning 摘要） |
| `tool_dispatch` | `tool: { id, name, args?, readOnly, partial? }` | 工具调度（partial=true 表示预览） |
| `tool_progress` | `tool: { id, name, output?, readOnly }` | 工具输出流 |
| `tool_result` | `tool: { id, name, args?, output?, readOnly, durationMs, err? }` | 工具最终结果 |
| `approval_request` | `approval: { id, tool, subject }` | 工具审批请求 |
| `ask_request` | `ask: { id, questions: AskQuestion[] }` | Ask 问题请求 |
| `usage` | `usage: Usage` | Token 使用统计（可多次出现） |
| `turn_done` | `err?: string` | turn 结束（err 非空表示异常结束） |
| (ping) | `: ping` 或 `: connected` | SSE keepalive（以 `:` 开头的注释行） |

**AskQuestion 结构**:
```ts
{
  id: string          // e.g. "q1"
  header: string      // tab label
  prompt: string      // the question
  options: {
    label: string
    description: string
  }[]
}
```

**Usage 结构**:
```ts
{
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  cacheDiagnostics: {
    prefixHash: string
    prefixChanged: boolean
    systemHash: string
    toolsHash: string
    logRewriteVersion: number
    toolSchemaTokens: number
    cacheMissTokens: number
    cacheHitTokens: number
  }
  sessionCacheHitTokens: number
  sessionCacheMissTokens: number
  cost: number
  currency: string   // "¥" | "$"
  costUsd: number
}
```

**事件顺序（典型）**:
```
turn_started
  → reasoning* (streaming)
  → message (reasoning summary + optional text)
  → usage
  → tool_dispatch (partial=true, preview)
  → tool_dispatch (full args)
  → [approval_request | ask_request]  (if interactive)
  → tool_progress*
  → tool_result
  → reasoning*
  → text*
  → message
  → usage
  → turn_done
```

---

### 5. `POST /submit`

**Content-Type**: `application/json` (必须)

**请求体**:
```json
{"input": "string (required)"}
```

**响应码**: 
- `202 Accepted` (成功提交，body 为空)
- `400 Bad Request` (缺少 `input` 字段)
- `415 Unsupported Media Type` (缺少 Content-Type)

**行为**: 提交后 Reasonix 开始处理，所有事件通过 SSE `/events` 流出。如果已有 active turn，行为未定义（会排队/拒绝？需在 Phase 2 通过 TurnCoordinator 管理）。

---

### 6. `POST /approve`

**Content-Type**: `application/json` (必须)

**请求体**:
```json
{
  "id": "string (approval id, required)",
  "allow": true,
  "session": false,
  "persist": false,
  "scope": ""
}
```

**响应码**: 
- `204 No Content` (成功)
- `400 Bad Request` (缺少 `id`)

---

### 7. `POST /answer`

**Content-Type**: `application/json` (必须)

**请求体**:
```json
{
  "id": "string (ask id, required)",
  "answers": [
    {"questionId": "q1", "selected": ["TypeScript"]}
  ]
}
```

**响应码**: `204 No Content`

---

### 8. `POST /plan`

**请求体**: `{"on": true}` 或 `{"on": false}`

**响应码**: `204 No Content`

---

### 9. `POST /new`

**请求体**: `{}` (empty)

**响应码**: `204 No Content`

**行为**: 创建新 session，清空对话历史。

---

### 10. `POST /cancel`

**请求体**: `{}` (empty)

**响应码**: `204 No Content`

**行为**: 取消当前活跃 turn。

---

## 额外端点（暂不暴露给 MCP）

| Endpoint | Method | 说明 |
|----------|--------|------|
| `/tool-approval-mode` | POST | `{"mode":"ask"\|"auto"\|"yolo"}` → 204 |
| `/sessions` | GET | 返回 session 列表 |
| `/checkpoints` | GET | 返回 checkpoint 列表 |
| `/resume` | POST | `{"path":"..."}` 恢复 session |
| `/compact` | POST | 触发 context 压缩 |
| `/rewind` | POST | `{"turn":n,"scope":"..."}` → 204 |
| `/fork` | POST | `{"turn":n,"name":""}` → 500 (有 bug) |
| `/summarize` | POST | `{"turn":n,"mode":"from"\|"upto"}` → 500 |
| `/delete-session` | POST | `{"name":"..."}` → 500 |

---

## 错误模式总结

| 场景 | 状态码 | 说明 |
|------|--------|------|
| 缺 Content-Type | `415 Unsupported Media Type` | 所有 POST 端点 |
| 缺必填字段（submit 无 input） | `400 Bad Request` | 返回 JSON error |
| 缺必填字段（approve 无 id） | `400 Bad Request` | 返回 JSON error |
| 未识别 GET 路径 | `200 OK` | 返回 SPA HTML（无 404） |
| 内部错误 | `500 Internal Server Error` | 部分端点有 bug |
