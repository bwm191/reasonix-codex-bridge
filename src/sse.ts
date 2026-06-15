/**
 * SSE (Server-Sent Events) parser for Reasonix event stream.
 *
 * Uses fetch + ReadableStream (not EventSource) to parse SSE frames.
 * Handles:
 *  - data: <json> → yields parsed ReasonixEvent
 *  - : <text>    → ping/comment, ignored
 *  - multi-line data events (blank-line delimited)
 *
 * Phase 0.5 — standalone prototype, verified with smoke tests.
 */

// ---- types ----

export interface ReasonixEventTurnStarted {
  kind: "turn_started";
}

export interface ReasonixEventReasoning {
  kind: "reasoning";
  text: string;
}

export interface ReasonixEventText {
  kind: "text";
  text: string;
}

export interface ReasonixEventMessage {
  kind: "message";
  text?: string;
  reasoning?: string;
}

export interface ReasonixEventToolDispatch {
  kind: "tool_dispatch";
  tool: {
    id: string;
    name: string;
    args?: string;
    readOnly: boolean;
    partial?: boolean;
  };
}

export interface ReasonixEventToolProgress {
  kind: "tool_progress";
  tool: {
    id: string;
    name: string;
    output?: string;
    readOnly: boolean;
  };
}

export interface ReasonixEventToolResult {
  kind: "tool_result";
  tool: {
    id: string;
    name: string;
    args?: string;
    output?: string;
    readOnly: boolean;
    durationMs?: number;
    err?: string;
  };
}

export interface ReasonixEventApprovalRequest {
  kind: "approval_request";
  approval: {
    id: string;
    tool: string;
    subject: string;
  };
}

export interface ReasonixEventAskRequest {
  kind: "ask_request";
  ask: {
    id: string;
    questions: AskQuestion[];
  };
}

export interface AskQuestion {
  id: string;
  header: string;
  prompt: string;
  options: { label: string; description: string }[];
}

export interface ReasonixEventUsage {
  kind: "usage";
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    reasoningTokens: number;
    cacheDiagnostics?: Record<string, unknown>;
    sessionCacheHitTokens?: number;
    sessionCacheMissTokens?: number;
    cost?: number;
    currency?: string;
    costUsd?: number;
  };
}

export interface ReasonixEventTurnDone {
  kind: "turn_done";
  err?: string;
}

export type ReasonixEvent =
  | ReasonixEventTurnStarted
  | ReasonixEventReasoning
  | ReasonixEventText
  | ReasonixEventMessage
  | ReasonixEventToolDispatch
  | ReasonixEventToolProgress
  | ReasonixEventToolResult
  | ReasonixEventApprovalRequest
  | ReasonixEventAskRequest
  | ReasonixEventUsage
  | ReasonixEventTurnDone;

// ---- parser ----

/**
 * Connect to the Reasonix SSE endpoint and return an AsyncIterable of parsed events.
 *
 * Usage:
 *   for await (const ev of sseStream("http://127.0.0.1:8787")) {
 *     if (ev.kind === "turn_done") break;
 *   }
 *
 * @param baseUrl  Reasonix base URL (e.g. "http://127.0.0.1:8787")
 * @param signal   Optional AbortSignal for cancellation
 */
export async function* sseStream(
  baseUrl: string,
  signal?: AbortSignal,
): AsyncIterable<ReasonixEvent> {
  const url = `${baseUrl.replace(/\/$/, "")}/events`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`SSE connection failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("SSE response has no readable body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

        // Empty line → event delimiter
        if (line === "") {
          if (dataLines.length > 0) {
            const ev = parseDataLines(dataLines);
            dataLines = [];
            if (ev) yield ev;
          }
          continue;
        }

        // Comment line (ping keepalive) — ignore
        if (line.startsWith(":")) {
          continue;
        }

        // data: line — accumulate for possible multi-line
        if (line.startsWith("data:")) {
          const v = line.slice(5);
          dataLines.push(v.startsWith(" ") ? v.slice(1) : v);
          continue;
        }

        // Unknown field — per SSE spec, ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseDataLines(lines: string[]): ReasonixEvent | null {
  const data = lines.join("\n");
  try {
    return JSON.parse(data) as ReasonixEvent;
  } catch {
    // Non-JSON data — silently skip (e.g. malformed events)
    return null;
  }
}
