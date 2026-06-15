# Codex to Reasonix MCP Bridge

MCP stdio server that lets Codex drive `reasonix serve` through its local
HTTP/SSE API.

```text
Codex MCP client --stdio--> reasonix-codex-bridge --HTTP/SSE--> reasonix serve
```

The default target is `http://127.0.0.1:8787`.

## Quick Start

1. Start Reasonix serve:

```bash
npx reasonix@1.6.0-rc.1 serve --addr 127.0.0.1:8787
```

2. Build the bridge:

```bash
npm install
npm run build
```

3. Add the bridge to `~/.codex/config.toml`:

```toml
[mcp_servers.reasonix]
command = "node"
args = ["E:/rea MCP/build/index.js"]
startup_timeout_sec = 10
tool_timeout_sec = 330
enabled = true
```

`tool_timeout_sec` should be slightly longer than
`REASONIX_DEFAULT_TIMEOUT_MS` so Codex does not kill the MCP call before the
bridge finishes its own timeout handling.

## Desktop vs CLI Authentication

The desktop app and `reasonix serve` may use different credential paths.

`reasonix serve` resolves config from:

```text
flag > ./reasonix.toml > %APPDATA%/reasonix/config.toml > built-in defaults
```

Provider secrets are read from the configured `api_key_env`, for example
`DEEPSEEK_API_KEY`. A desktop app can still work while the CLI serve path fails
if the desktop app is using a legacy or app-local key that is not present in the
CLI environment.

Useful checks:

```bash
npx reasonix@1.6.0-rc.1 doctor --json
npx reasonix@1.6.0-rc.1 serve --addr 127.0.0.1:8787
```

Then call the MCP tool `reasonix_status`. It reports the bridge `serveUrl`,
auto-launch settings, and whether Reasonix reported provider balance/auth data.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `REASONIX_SERVE_URL` | `http://127.0.0.1:8787` | Reasonix serve base URL. |
| `REASONIX_DEFAULT_TIMEOUT_MS` | `300000` | Default sync submit timeout. |
| `REASONIX_AUTO_LAUNCH` | `false` | Set to `true` to auto-launch Reasonix serve. |
| `REASONIX_COMMAND` | `reasonix` | Command used for auto-launch. |
| `REASONIX_ARGS` | `serve` | Space-separated auto-launch arguments. |
| `REASONIX_CWD` | bridge cwd | Working directory for the auto-launched process. |
| `REASONIX_LOG_PATH` | `./tmp/reasonix-serve.log` | Auto-launch stdout/stderr log file. |

Auto-launch example:

```toml
[mcp_servers.reasonix]
command = "node"
args = ["E:/rea MCP/build/index.js"]
startup_timeout_sec = 15
tool_timeout_sec = 330
enabled = true
env = {
  REASONIX_AUTO_LAUNCH = "true",
  REASONIX_COMMAND = "npx",
  REASONIX_ARGS = "reasonix@1.6.0-rc.1 serve"
}
```

Auto-launch is restricted to localhost targets.

## Tools

| Tool | Purpose |
| --- | --- |
| `reasonix_status` | Bridge, Reasonix, auth/balance, and context diagnostics. |
| `reasonix_submit` | Submit a task and wait for completion, approval, ask, timeout, or error. |
| `reasonix_submit_async` | Submit a task and return immediately. |
| `reasonix_history` | Read Reasonix conversation history. |
| `reasonix_cancel` | Cancel the active turn. |
| `reasonix_approve` | Approve or deny a pending tool call. |
| `reasonix_answer` | Answer a pending ask request. |
| `reasonix_plan_mode` | Toggle Reasonix plan mode. |
| `reasonix_new_session` | Create a new Reasonix session. |
| `reasonix_context` | Read current context window usage. |

## Testing

```bash
npm run check       # TypeScript type check
npm run build       # Compile build/
npm run test:unit   # Offline bridge regression tests
npm test            # Reasonix HTTP smoke test; requires reasonix serve
npm run test:mcp    # MCP JSON-RPC matrix; requires reasonix serve
npm run test:submit # End-to-end completed submit; requires working provider auth
```

`test:submit` is the strictest availability check. It fails if Reasonix returns
`turn_done` with an auth error, timeout, pending approval, or any status other
than `completed`.

## Error Types

The bridge returns structured errors:

| Error type | Meaning |
| --- | --- |
| `connection_refused` | Reasonix is not reachable. |
| `timeout` | The turn exceeded the bridge timeout; Reasonix may still be running. |
| `reasonix_busy` | Another turn is active or state is uncertain. |
| `pending_approval` | Reasonix is waiting for tool approval. |
| `pending_ask` | Reasonix is waiting for an answer. |
| `sse_disconnected` | The SSE listener is not running. |
| `sse_reconnect_failed` | SSE reconnect attempts were exhausted. |
| `contract_mismatch` | Reasonix returned an unexpected HTTP response. |
| `missing_field` | Required MCP tool argument is missing. |
| `turn_done_error` | Reasonix emitted `turn_done` with an error. |

## Security

- Keep Reasonix serve bound to localhost.
- Do not expose the bridge or Reasonix serve to LAN/WAN.
- Reasonix serve has no built-in HTTP auth; rely on localhost and OS firewall.
- POST requests sent by the bridge use `Content-Type: application/json`.

## Project Structure

```text
src/
  index.ts              MCP server and tool handlers
  turn-coordinator.ts   Turn state machine and SSE lifecycle
  reasonix-client.ts    Typed HTTP client
  sse.ts                SSE parser
test/
  turn-coordinator-fast-completion.mjs
  mcp-status-diagnostics.mjs
  mcp-submit-completion.mjs
  smoke.mjs
  phase-0.5/
  phase-5/
```

## License

MIT
