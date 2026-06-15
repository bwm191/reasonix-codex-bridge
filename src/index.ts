/**
 * Codex → Reasonix MCP Bridge — Main entry point
 *
 * Phase 4: Full 10-tool MCP server with auto-launch, security, and documentation.
 *
 * Architecture:
 *   Codex (MCP client) ──stdio──► bridge ──HTTP/SSE──► reasonix serve
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TurnCoordinator } from "./turn-coordinator.js";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---- config ----

const REASONIX_URL = process.env.REASONIX_SERVE_URL || "http://127.0.0.1:8787";
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.REASONIX_DEFAULT_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
})();

function splitProcessArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    args.push(current);
  }
  return args;
}

// Auto-launch (default OFF)
const AUTO_LAUNCH = process.env.REASONIX_AUTO_LAUNCH === "true";
const REASONIX_COMMAND = process.env.REASONIX_COMMAND || "reasonix";
const REASONIX_ARGS = splitProcessArgs(process.env.REASONIX_ARGS || "serve");
const REASONIX_CWD = process.env.REASONIX_CWD || process.cwd();
const REASONIX_LOG_PATH =
  process.env.REASONIX_LOG_PATH || resolve(process.cwd(), "tmp", "reasonix-serve.log");

// ---- init ----

const coordinator = new TurnCoordinator(REASONIX_URL);
let reasonixProcess: ChildProcess | null = null;

// ---- MCP server ----

const server = new Server(
  {
    name: "reasonix-codex-bridge",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---- tool definitions ----

const TOOLS = [
  {
    name: "reasonix_status",
    description:
      "Get Reasonix connection status and session information. Returns connected state, running status, model label, context window usage, plan mode, and diagnostics. Does not fail if Reasonix is unreachable — instead returns connected: false with diagnostic info.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "reasonix_submit",
    description:
      "Submit a coding task to Reasonix and wait for completion. Blocks until the turn completes, reaches pending approval/ask, times out, or encounters an error. Returns the full result including response text, usage stats, and optionally events and reasoning.",
    inputSchema: {
      type: "object" as const,
      properties: {
        input: {
          type: "string",
          description: "The task description to submit to Reasonix.",
        },
        timeoutMs: {
          type: "number",
          description: `Maximum time to wait in milliseconds (default: ${DEFAULT_TIMEOUT_MS}ms = 5 min).`,
        },
        includeEvents: {
          type: "boolean",
          description: "Include the full SSE event stream in the response (default: false).",
        },
        includeReasoning: {
          type: "boolean",
          description: "Include reasoning/thinking text in the response (default: false).",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "reasonix_submit_async",
    description:
      "Submit a coding task to Reasonix asynchronously (fire-and-forget). Returns immediately with acceptance status. Use reasonix_status to monitor progress and reasonix_history to read results. Only one turn can be active at a time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        input: {
          type: "string",
          description: "The task description to submit to Reasonix.",
        },
      },
      required: ["input"],
    },
  },
  {
    name: "reasonix_history",
    description:
      "Read the Reasonix conversation history. Returns messages including system prompt, user inputs, assistant responses, tool calls, and tool results. Useful for inspecting turn results after submission.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 50). Must be positive.",
        },
        includeToolCalls: {
          type: "boolean",
          description: "Include tool call details in assistant messages (default: true).",
        },
        includeReasoning: {
          type: "boolean",
          description: "Include reasoning/thinking text in assistant messages (default: true).",
        },
      },
      required: [],
    },
  },
  {
    name: "reasonix_cancel",
    description:
      "Cancel the currently active Reasonix turn. If no turn is active, returns gracefully with a message. Use this to free up Reasonix for a new task when stuck or when you want to abort.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "reasonix_approve",
    description:
      "Approve or deny a pending tool execution in Reasonix. After approving, can optionally wait for the turn to complete (waitForTurn=true, default). Use this when Reasonix pauses for tool approval.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The approval ID from the pending_approval response.",
        },
        allow: {
          type: "boolean",
          description: "true to allow the tool call, false to deny.",
        },
        session: {
          type: "boolean",
          description: "Allow this tool for the rest of the session (default: false).",
        },
        persist: {
          type: "boolean",
          description: "Remember this approval across sessions (default: false).",
        },
        waitForTurn: {
          type: "boolean",
          description: "Continue waiting for the turn to complete after approving (default: true). Set false to return immediately.",
        },
        timeoutMs: {
          type: "number",
          description: `Max wait time in ms when waitForTurn=true (default: ${DEFAULT_TIMEOUT_MS}ms).`,
        },
      },
      required: ["id", "allow"],
    },
  },
  {
    name: "reasonix_answer",
    description:
      "Answer a question that Reasonix asked via the ask tool. After answering, can optionally wait for the turn to complete (waitForTurn=true, default).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The ask ID from the pending_ask response.",
        },
        answers: {
          type: "array",
          description: "Array of { questionId: string, selected: string[] } objects.",
          items: {
            type: "object",
            properties: {
              questionId: { type: "string" },
              selected: { type: "array", items: { type: "string" } },
            },
            required: ["questionId", "selected"],
          },
        },
        waitForTurn: {
          type: "boolean",
          description: "Continue waiting for the turn to complete after answering (default: true). Set false to return immediately.",
        },
        timeoutMs: {
          type: "number",
          description: `Max wait time in ms when waitForTurn=true (default: ${DEFAULT_TIMEOUT_MS}ms).`,
        },
      },
      required: ["id", "answers"],
    },
  },
  {
    name: "reasonix_plan_mode",
    description:
      "Toggle Reasonix plan mode on or off. In plan mode, Reasonix performs read-only analysis and presents a plan before making changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        on: {
          type: "boolean",
          description: "true to enable plan mode, false to disable.",
        },
      },
      required: ["on"],
    },
  },
  {
    name: "reasonix_new_session",
    description:
      "Create a new Reasonix session, clearing conversation history. By default, refuses if a turn is active. Use force=true to cancel the active turn first and then create a new session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        force: {
          type: "boolean",
          description: "If true, cancel any active turn before creating a new session (default: false).",
        },
      },
      required: [],
    },
  },
  {
    name: "reasonix_context",
    description:
      "Get the current Reasonix context window usage (used tokens / total window). Lightweight status check.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ---- helpers ----

function sanitizeLimit(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && raw > 0 && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  return fallback;
}

function sanitizeTimeout(raw: unknown, fallback: number, max: number = 600_000): number {
  if (typeof raw === "number" && raw > 0 && Number.isFinite(raw)) {
    return Math.min(Math.floor(raw), max);
  }
  return fallback;
}

interface HistoryMessage {
  role: string;
  content: string;
  reasoning?: string;
  toolCalls?: unknown[];
}

function filterHistoryMessages(
  messages: HistoryMessage[],
  includeToolCalls: boolean,
  includeReasoning: boolean,
): HistoryMessage[] {
  return messages.map((m) => {
    const copy = { ...m };
    if (!includeToolCalls && "toolCalls" in copy) {
      delete copy.toolCalls;
    }
    if (!includeReasoning && "reasoning" in copy) {
      delete copy.reasoning;
    }
    return copy;
  });
}

// ---- request handlers ----

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const client = coordinator.getClient();

  switch (name) {
    case "reasonix_status": {
      const status = await coordinator.getStatus();
      let reasonixStatus = null;
      try {
        const { body } = await client.status();
        reasonixStatus = body;
      } catch {
        // Reasonix unreachable
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                bridge: {
                  ...status,
                  serveUrl: REASONIX_URL,
                  autoLaunch: AUTO_LAUNCH,
                  autoLaunchCommand: AUTO_LAUNCH
                    ? `${REASONIX_COMMAND} ${REASONIX_ARGS.join(" ")}`
                    : null,
                  autoLaunchLogPath: AUTO_LAUNCH ? REASONIX_LOG_PATH : null,
                  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
                },
                reasonix: reasonixStatus
                  ? {
                      running: reasonixStatus.running,
                      plan: reasonixStatus.plan,
                      label: reasonixStatus.label,
                      used: reasonixStatus.used,
                      window: reasonixStatus.window,
                      cwd: reasonixStatus.cwd,
                      toolApprovalMode: reasonixStatus.toolApprovalMode,
                      auth: {
                        balanceReported: reasonixStatus.balance != null,
                        balanceAvailable: reasonixStatus.balance?.Available ?? null,
                        balanceCurrencies:
                          reasonixStatus.balance?.Infos?.map((info) => info.Currency) ?? [],
                        hint:
                          reasonixStatus.balance == null
                            ? "Reasonix did not report balance data; submit may still fail if provider auth is invalid."
                            : reasonixStatus.balance.Available
                              ? null
                              : "Reasonix reported provider balance unavailable; verify the configured api_key_env for the CLI serve process.",
                      },
                    }
                  : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "reasonix_submit": {
      const input = args?.input;
      if (typeof input !== "string" || !input.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'input' parameter is required." }) }],
          isError: true,
        };
      }
      const timeoutMs = sanitizeTimeout(args?.timeoutMs, DEFAULT_TIMEOUT_MS);
      const includeEvents = args?.includeEvents === true;
      const includeReasoning = args?.includeReasoning === true;

      const result = await coordinator.submit({
        input,
        timeoutMs,
        includeEvents,
        includeReasoning,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.isError === true,
      };
    }

    case "reasonix_submit_async": {
      const input = args?.input;
      if (typeof input !== "string" || !input.trim()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'input' parameter is required." }) }],
          isError: true,
        };
      }
      const result = await coordinator.submitAsync(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.accepted,
      };
    }

    case "reasonix_history": {
      const limit = sanitizeLimit(args?.limit, DEFAULT_HISTORY_LIMIT);
      const includeToolCalls = args?.includeToolCalls !== false;
      const includeReasoning = args?.includeReasoning !== false;
      try {
        const { body: history } = await client.history(limit);
        const filtered = history
          ? filterHistoryMessages(history as HistoryMessage[], includeToolCalls, includeReasoning)
          : [];
        return {
          content: [{ type: "text", text: JSON.stringify(filtered) }],
        };
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "connection_refused", message: "Reasonix is not reachable." }) }],
          isError: true,
        };
      }
    }

    case "reasonix_cancel": {
      const result = await coordinator.cancel();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "reasonix_approve": {
      const id = args?.id;
      const allow = args?.allow;
      if (typeof id !== "string" || !id) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'id' parameter is required." }) }], isError: true };
      }
      if (typeof allow !== "boolean") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'allow' parameter is required (boolean)." }) }], isError: true };
      }
      const result = await coordinator.approve({
        id,
        allow,
        session: args?.session === true,
        persist: args?.persist === true,
        waitForTurn: args?.waitForTurn !== false,
        timeoutMs: sanitizeTimeout(args?.timeoutMs, DEFAULT_TIMEOUT_MS),
        includeEvents: args?.includeEvents === true,
        includeReasoning: args?.includeReasoning === true,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.isError === true,
      };
    }

    case "reasonix_answer": {
      const id = args?.id;
      const answers = args?.answers;
      if (typeof id !== "string" || !id) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'id' parameter is required." }) }], isError: true };
      }
      if (!Array.isArray(answers) || answers.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'answers' parameter is required (non-empty array)." }) }], isError: true };
      }
      const result = await coordinator.answer({
        id,
        answers: answers as { questionId: string; selected: string[] }[],
        waitForTurn: args?.waitForTurn !== false,
        timeoutMs: sanitizeTimeout(args?.timeoutMs, DEFAULT_TIMEOUT_MS),
        includeEvents: args?.includeEvents === true,
        includeReasoning: args?.includeReasoning === true,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.isError === true,
      };
    }

    case "reasonix_plan_mode": {
      const on = args?.on;
      if (typeof on !== "boolean") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "missing_field", message: "The 'on' parameter is required (boolean)." }) }], isError: true };
      }
      const result = await coordinator.planMode(on);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "reasonix_new_session": {
      const force = args?.force === true;
      const result = await coordinator.newSession(force);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    }

    case "reasonix_context": {
      try {
        const { body } = await client.context();
        return {
          content: [{ type: "text", text: JSON.stringify(body || { used: 0, window: 1000000 }) }],
        };
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "connection_refused", message: "Reasonix is not reachable." }) }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: `Unknown tool: ${name}` }) }],
        isError: true,
      };
  }
});

// ---- startup ----

/**
 * Launch reasonix serve as a child process (only when REASONIX_AUTO_LAUNCH=true).
 * Security: only connects to 127.0.0.1.
 */
async function launchReasonix(): Promise<void> {
  if (!AUTO_LAUNCH) return;

  let url: URL;
  try {
    url = new URL(REASONIX_URL);
  } catch {
    console.error(
      `[bridge] REASONIX_AUTO_LAUNCH: REASONIX_SERVE_URL is not a valid URL (did you forget http://?): ${REASONIX_URL}`,
    );
    return;
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    console.error(
      `[bridge] REASONIX_AUTO_LAUNCH refused: REASONIX_SERVE_URL is not localhost (${url.hostname})`,
    );
    return;
  }

  const port = url.port || "8787";
  const addr = `${url.hostname}:${port}`;

  let logFd: number | null = null;
  let stdio: ["ignore", "ignore" | number, "ignore" | number] = [
    "ignore",
    "ignore",
    "ignore",
  ];
  try {
    mkdirSync(dirname(REASONIX_LOG_PATH), { recursive: true });
    logFd = openSync(REASONIX_LOG_PATH, "a");
    stdio = ["ignore", logFd, logFd];
  } catch (e) {
    console.error(
      `[bridge] Could not open Reasonix auto-launch log ${REASONIX_LOG_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  console.error(
    `[bridge] Auto-launching: ${REASONIX_COMMAND} ${REASONIX_ARGS.join(" ")} --addr ${addr} (log: ${REASONIX_LOG_PATH})`,
  );
  reasonixProcess = spawn(REASONIX_COMMAND, [...REASONIX_ARGS, "--addr", addr], {
    cwd: REASONIX_CWD,
    stdio,
    detached: false,
  });
  if (logFd != null) {
    closeSync(logFd);
  }

  reasonixProcess.on("exit", (code) => {
    console.error(`[bridge] Reasonix process exited with code ${code}`);
    reasonixProcess = null;
  });
  reasonixProcess.on("error", (e) => {
    console.error(`[bridge] Failed to launch Reasonix: ${e.message}`);
    reasonixProcess = null;
  });

  // Wait for Reasonix to become ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch(`${REASONIX_URL}/status`);
      if (resp.ok) {
        console.error("[bridge] Reasonix is ready");
        return;
      }
    } catch {
      // not ready yet
    }
  }
  console.error(
    `[bridge] Warning: Reasonix did not become ready within 15s. Check log: ${REASONIX_LOG_PATH}`,
  );
}

async function main() {
  // Auto-launch Reasonix if configured
  await launchReasonix();

  console.error("[bridge] Initializing TurnCoordinator...");
  await coordinator.initialize();
  const state = coordinator.getState();
  console.error(`[bridge] Initial state: ${state.kind}`);

  // Start SSE listener (singleton, must be running before any submit)
  console.error("[bridge] Starting SSE listener...");
  coordinator.startSSE(); // fire-and-forget, runs in background

  // Start MCP stdio server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[bridge] MCP server ready on stdio");
}

// Cleanup on exit
process.on("SIGTERM", () => {
  coordinator.stopSSE();
  try { if (reasonixProcess) reasonixProcess.kill("SIGTERM"); } catch { /* ignore */ }
  process.exit(0);
});
process.on("SIGINT", () => {
  coordinator.stopSSE();
  try { if (reasonixProcess) reasonixProcess.kill("SIGINT"); } catch { /* ignore */ }
  process.exit(0);
});

main().catch((e) => {
  console.error("[bridge] Fatal startup error:", e);
  process.exit(1);
});
