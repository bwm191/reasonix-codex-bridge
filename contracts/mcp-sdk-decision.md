# MCP SDK 路线决策

**日期**: 2026-06-12
**状态**: 已确认
**Phase**: 0

## 候选方案

### 方案 A: `@modelcontextprotocol/server` (v2 alpha)

- **最新版本**: `2.0.0-alpha.2`
- **发布时间**: 2026-04-01
- **版本数**: 2 个（均为 alpha）
- **导入路径**: `@modelcontextprotocol/server` → `./dist/index.mjs`
- **引擎要求**: Node >= 20
- **仓库**: https://github.com/modelcontextprotocol/typescript-sdk
- **评估**: alpha 阶段，API 不稳定，仅有 2 个预发布版本，无生产级 maturity。

### 方案 B: `@modelcontextprotocol/sdk` (v1 stable) ✅ 选定

- **最新版本**: `1.29.0`
- **发布时间**: 2024-11-11（首个版本），持续迭代至 2026-06
- **版本数**: 80+ 个（含 beta），丰富的 patch 和 minor 迭代
- **导入路径**: 
  - `@modelcontextprotocol/sdk` → `./dist/esm/index.js`
  - `@modelcontextprotocol/sdk/server` → `./dist/esm/server/index.js`
  - `@modelcontextprotocol/sdk/client` → `./dist/esm/client/index.js`
- **引擎要求**: Node >= 18
- **仓库**: https://github.com/modelcontextprotocol/typescript-sdk
- **评估**: 生产级稳定性，80+ 版本迭代，成熟的 server/client 子模块，社区广泛使用。

## 决策

**选择 `@modelcontextprotocol/sdk` v1.29.0**

### 理由

1. **稳定性**: v1.29.0 经过 80+ 个版本迭代，生产验证充分；v2 仅 2 个 alpha 版本
2. **API 成熟度**: v1 的 `Server`/`Client` 类、`CallToolRequestSchema` 等已在大量项目中验证
3. **风险控制**: alpha 软件在 bridge 这种关键基础设施中不可接受
4. **生态兼容**: Codex 当前生态以 v1 SDK 为主

### 固定版本

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0"
  }
}
```

使用精确版本（不写 `^`），配合 `package-lock.json` 锁定。

### 关键 API 导入

```ts
// MCP Server (stdio transport)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Tool registration
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
```

### 不混用两套 API

任何情况下不得在同一进程中同时引入 `@modelcontextprotocol/server` 和 `@modelcontextprotocol/sdk`，避免类型冲突和运行时异常。
