/**
 * Full TurnCoordinator — Phase 2
 *
 * Manages the complete Reasonix turn lifecycle:
 * - 8-state machine
 * - Event buffer with seq / cursor
 * - Waiter for synchronous submit
 * - Singleton SSE listener with reconnect
 * - timed_out exit paths
 * - completed return structure
 */

import { ReasonixClient, type ReasonixMessage } from "./reasonix-client.js";
import { sseStream, type ReasonixEvent } from "./sse.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min

// ---- types ----

export type TurnState =
  | { kind: "idle" }
  | { kind: "submitting"; activeTurnId: string }
  | { kind: "running"; activeTurnId: string; startedAt: number }
  | { kind: "pending_approval"; activeTurnId: string; approvalId: string }
  | { kind: "pending_ask"; activeTurnId: string; askId: string }
  | { kind: "timed_out"; activeTurnId: string; runningMayContinue: true }
  | { kind: "running_unknown"; reason: string }
  | { kind: "disconnected"; runningUnknown: boolean };

export interface CoordinatorStatus {
  connected: boolean;
  state: TurnState["kind"];
  activeTurnId: string | null;
  reasonixRunning: boolean;
  label: string | null;
}

export interface SubmitOptions {
  input: string;
  timeoutMs?: number;
  includeEvents?: boolean;
  includeReasoning?: boolean;
}

export interface SubmitResult {
  status: "completed" | "pending_approval" | "pending_ask" | "timed_out" | "approval_sent" | "answer_sent" | "error";
  response?: string;
  activeTurnId?: string;
  historyMessageCount?: number;
  eventsIncluded?: boolean;
  events?: ReasonixEvent[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  isError?: boolean;
  error?: string;
  errorType?: string;
  approvalId?: string;
  askId?: string;
  hint?: string;
}

interface Waiter {
  resolve: (result: SubmitResult) => void;
  cursor: number; // only events with seq > cursor are relevant
  timeoutMs: number;
  startedAt: number;
  includeEvents: boolean;
  includeReasoning: boolean;
}

// ---- coordinator ----

export class TurnCoordinator {
  private client: ReasonixClient;
  private state: TurnState = { kind: "idle" };
  private activeTurnId: string | null = null;
  private submitMutex = false;

  // Event buffer
  private eventBuffer: ReasonixEvent[] = [];
  private eventSeq = 0;

  // Waiter (only one at a time)
  private waiter: Waiter | null = null;

  // SSE
  private baseUrl: string;
  private sseAbort: AbortController | null = null;
  private sseRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 1000; // start at 1s, exponential backoff

  constructor(baseUrl: string = "http://127.0.0.1:8787") {
    this.baseUrl = baseUrl;
    this.client = new ReasonixClient(baseUrl);
  }

  // ---- accessors ----

  getState(): TurnState {
    return this.state;
  }

  getActiveTurnId(): string | null {
    return this.activeTurnId;
  }

  isBusy(): boolean {
    return (
      this.state.kind !== "idle" &&
      this.state.kind !== "disconnected" &&
      this.state.kind !== "running_unknown"
    );
  }

  // ---- lifecycle ----

  async initialize(): Promise<void> {
    try {
      const { body: status } = await this.client.status();
      if (!status) {
        this.state = { kind: "disconnected", runningUnknown: false };
        return;
      }
      if (status.running) {
        this.state = {
          kind: "running_unknown",
          reason: "Reasonix was already running when bridge started",
        };
      }
    } catch {
      this.state = { kind: "disconnected", runningUnknown: false };
    }
  }

  async getStatus(): Promise<CoordinatorStatus> {
    try {
      const { body: status } = await this.client.status();
      // Sync internal state based on what Reasonix reports
      if (status && !status.running && this.state.kind !== "idle") {
        // timed_out exit path: status shows idle
        this.state = { kind: "idle" };
        this.activeTurnId = null;
        this.eventBuffer = [];
        this.eventSeq = 0;
      }
      if (status && status.running && this.state.kind === "idle") {
        this.state = {
          kind: "running_unknown",
          reason: "Reasonix running detected during status check",
        };
      }
      if (!status) {
        return {
          connected: false,
          state: this.state.kind,
          activeTurnId: this.activeTurnId,
          reasonixRunning: false,
          label: null,
        };
      }
      return {
        connected: true,
        state: this.state.kind,
        activeTurnId: this.activeTurnId,
        reasonixRunning: status.running,
        label: status.label,
      };
    } catch {
      this.state = { kind: "disconnected", runningUnknown: this.state.kind !== "idle" };
      return {
        connected: false,
        state: this.state.kind,
        activeTurnId: this.activeTurnId,
        reasonixRunning: false,
        label: null,
      };
    }
  }

  // ---- SSE lifecycle ----

  /**
   * Start the singleton SSE listener. Must be called once at startup.
   * Ensures SSE is connected before any submit.
   */
  async startSSE(): Promise<void> {
    if (this.sseRunning) return;
    this.sseRunning = true;
    this.reconnectAttempts = 0;
    await this.connectSSE();
  }

  private async connectSSE(): Promise<void> {
    if (!this.sseRunning) return;

    this.sseAbort = new AbortController();
    try {
      const events = sseStream(this.baseUrl, this.sseAbort.signal);
      this.reconnectAttempts = 0; // reset on successful connection

      for await (const ev of events) {
        this.handleSSEEvent(ev);
      }
      // SSE stream ended cleanly (server closed). Attempt reconnect.
      if (!this.sseRunning) return;
      console.error("[bridge] SSE stream ended, attempting reconnect...");
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        console.error(
          `[bridge] SSE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        await this.connectSSE();
      } else {
        console.error("[bridge] SSE reconnect failed after max attempts");
        if (this.waiter) {
          this.waiter.resolve({
            status: "error",
            isError: true,
            errorType: "sse_reconnect_failed",
            error: "SSE connection lost and reconnect failed after 3 attempts.",
          });
          this.waiter = null;
        }
        this.sseRunning = false;
        this.state = { kind: "disconnected", runningUnknown: this.state.kind !== "idle" };
      }
    } catch (e) {
      if (!this.sseRunning) return; // intentional stop
      console.error(`[bridge] SSE error: ${e instanceof Error ? e.message : String(e)}`);

      // Attempt reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        console.error(
          `[bridge] SSE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        await this.connectSSE();
      } else {
        console.error("[bridge] SSE reconnect failed after max attempts");
        // Notify waiter
        if (this.waiter) {
          this.waiter.resolve({
            status: "error",
            isError: true,
            errorType: "sse_reconnect_failed",
            error: "SSE connection lost and reconnect failed after 3 attempts.",
          });
          this.waiter = null;
        }
        // Check Reasonix state
        try {
          const { body: status } = await this.client.status();
          if (status?.running && this.state.kind === "timed_out") {
            this.state = { kind: "running_unknown", reason: "SSE lost while turn was running" };
          }
        } catch {
          this.state = { kind: "disconnected", runningUnknown: this.state.kind !== "idle" };
        }
        this.sseRunning = false;
      }
    }
  }

  stopSSE(): void {
    this.sseRunning = false;
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
  }

  private handleSSEEvent(ev: ReasonixEvent): void {
    // Assign seq and buffer
    this.eventSeq++;
    this.eventBuffer.push(ev);

    // Prune old events (keep last 500)
    if (this.eventBuffer.length > 500) {
      this.eventBuffer = this.eventBuffer.slice(-500);
    }

    // Handle state transitions
    switch (ev.kind) {
      case "turn_started":
        if (this.state.kind === "submitting") {
          this.state = {
            kind: "running",
            activeTurnId: this.state.activeTurnId,
            startedAt: Date.now(),
          };
        }
        break;

      case "approval_request":
        if (this.state.kind === "running" || this.state.kind === "timed_out") {
          this.state = {
            kind: "pending_approval",
            activeTurnId: this.activeTurnId || "",
            approvalId: ev.approval.id,
          };
          // Only resolve waiter if this is a new event (cursor check)
          if (this.waiter && this.eventSeq > this.waiter.cursor) {
            this.waiter.resolve({
              status: "pending_approval",
              activeTurnId: this.activeTurnId || undefined,
              approvalId: ev.approval.id,
              hint: "Call reasonix_approve to allow or deny the tool call.",
            });
            this.waiter = null;
          }
        }
        break;

      case "ask_request":
        if (this.state.kind === "running" || this.state.kind === "timed_out") {
          this.state = {
            kind: "pending_ask",
            activeTurnId: this.activeTurnId || "",
            askId: ev.ask.id,
          };
          if (this.waiter && this.eventSeq > this.waiter.cursor) {
            this.waiter.resolve({
              status: "pending_ask",
              activeTurnId: this.activeTurnId || undefined,
              askId: ev.ask.id,
              hint: "Call reasonix_answer to respond to the question.",
            });
            this.waiter = null;
          }
        }
        break;

      case "turn_done":
        this.handleTurnDone(ev);
        break;
    }
  }

  private async handleTurnDone(ev: ReasonixEvent): Promise<void> {
    const wasTimedOut = this.state.kind === "timed_out";

    if (ev.kind === "turn_done" && ev.err) {
      // Turn ended with error
      if (this.waiter && this.eventSeq > this.waiter.cursor) {
        this.waiter.resolve({
          status: "error",
          isError: true,
          errorType: "turn_done_error",
          error: ev.err,
          activeTurnId: this.activeTurnId || undefined,
        });
        this.waiter = null;
      }
    } else if (this.waiter && this.eventSeq > this.waiter.cursor) {
      // Normal completion — build completed result
      const result = await this.buildCompletedResult(this.waiter);
      this.waiter.resolve(result);
      this.waiter = null;
    }

    // Clear state (timed_out exit path: turn_done arrives → go idle)
    this.state = { kind: "idle" };
    this.activeTurnId = null;
    this.eventBuffer = [];
    this.eventSeq = 0;
  }

  private async buildCompletedResult(waiter: Waiter): Promise<SubmitResult> {
    // Get final response from history
    let response = "";
    let historyMessageCount = 0;
    try {
      const { body: history } = await this.client.history();
      if (history && history.length > 0) {
        historyMessageCount = history.length;
        // Find last assistant message
        const filtered = waiter.includeReasoning
          ? history
          : history.map((m: ReasonixMessage & { reasoning?: string }) => {
              const { reasoning, ...rest } = m;
              return rest;
            });
        for (let i = filtered.length - 1; i >= 0; i--) {
          if (filtered[i].role === "assistant" && filtered[i].content) {
            response = filtered[i].content;
            break;
          }
        }
      }
    } catch {
      // history unavailable
    }

    // Fallback: use text/message events
    if (!response) {
      const texts = this.eventBuffer
        .filter((e) => e.kind === "text")
        .map((e) => (e as { text: string }).text)
        .join("");
      if (texts) response = texts;
    }

    // Extract usage from last usage event
    let usage: SubmitResult["usage"];
    for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
      if (this.eventBuffer[i].kind === "usage") {
        const u = (this.eventBuffer[i] as { usage: { promptTokens: number; completionTokens: number; totalTokens: number } }).usage;
        usage = {
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.totalTokens,
        };
        break;
      }
    }

    return {
      status: "completed",
      response,
      activeTurnId: this.activeTurnId || undefined,
      historyMessageCount,
      eventsIncluded: waiter.includeEvents,
      events: waiter.includeEvents ? [...this.eventBuffer] : [],
      usage,
    };
  }

  // ---- submit (async, Phase 1 compatible) ----

  async submitAsync(input: string): Promise<{ accepted: boolean; running: boolean; hint: string }> {
    if (this.state.kind === "running_unknown") {
      return {
        accepted: false,
        running: false,
        hint: "Reasonix was already running when bridge started. Use reasonix_status or reasonix_history to inspect, or reasonix_cancel to reset.",
      };
    }
    if (this.isBusy()) {
      return {
        accepted: false,
        running: false,
        hint: `Reasonix is busy (state: ${this.state.kind}). Wait for the current turn to complete or use reasonix_cancel.`,
      };
    }
    if (this.submitMutex) {
      return {
        accepted: false,
        running: false,
        hint: "Another submit is in progress. Please wait.",
      };
    }

    this.submitMutex = true;
    try {
      // Ensure SSE is connected first
      if (!this.sseRunning) {
        return {
          accepted: false,
          running: false,
          hint: "SSE listener is not running. Bridge may need restart.",
        };
      }

      const { status } = await this.client.submit(input);
      if (status !== 202) {
        return {
          accepted: false,
          running: false,
          hint: `Reasonix returned unexpected status ${status}.`,
        };
      }

      this.activeTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.state = {
        kind: "running",
        activeTurnId: this.activeTurnId,
        startedAt: Date.now(),
      };

      return {
        accepted: true,
        running: true,
        hint: `Turn submitted. Use reasonix_status to monitor. Active turn ID: ${this.activeTurnId}`,
      };
    } finally {
      this.submitMutex = false;
    }
  }

  // ---- submit (synchronous, Phase 2) ----

  /**
   * Submit a task and wait for completion, approval, ask, timeout, or error.
   */
  async submit(opts: SubmitOptions): Promise<SubmitResult> {
    const {
      input,
      timeoutMs = 300_000, // default 5 min
      includeEvents = false,
      includeReasoning = false,
    } = opts;

    // Guard checks (same as submitAsync)
    if (this.state.kind === "running_unknown") {
      return {
        status: "error",
        isError: true,
        errorType: "reasonix_busy",
        error: "Reasonix was already running when bridge started.",
        hint: "Use reasonix_status, reasonix_history, or reasonix_cancel to recover.",
      };
    }
    if (this.isBusy()) {
      return {
        status: "error",
        isError: true,
        errorType: "reasonix_busy",
        error: `Reasonix is busy (state: ${this.state.kind}).`,
        hint: "Wait for the current turn to complete or use reasonix_cancel.",
      };
    }
    if (!this.sseRunning) {
      return {
        status: "error",
        isError: true,
        errorType: "sse_disconnected",
        error: "SSE listener is not running.",
      };
    }

    this.submitMutex = true;
    try {
      this.activeTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.state = {
        kind: "submitting",
        activeTurnId: this.activeTurnId,
      };

      // Create the waiter before POST /submit. Reasonix can emit a full turn
      // lifecycle over SSE before the HTTP 202 response is observed.
      const cursor = this.eventSeq;
      let resolveSubmitWaiter: ((r: SubmitResult) => void) | null = null;

      const resultPromise = new Promise<SubmitResult>((_resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.waiter = null;
          this.state = {
            kind: "timed_out",
            activeTurnId: this.activeTurnId!,
            runningMayContinue: true,
          };
          _resolve({
            status: "timed_out",
            isError: true,
            errorType: "timeout",
            activeTurnId: this.activeTurnId!,
            hint: "The turn timed out. Reasonix may still be running. Use reasonix_status, reasonix_history, or reasonix_cancel to recover.",
          });
        }, timeoutMs);

        const wrappedResolve = (r: SubmitResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          _resolve(r);
        };

        resolveSubmitWaiter = wrappedResolve;
        this.waiter = {
          resolve: wrappedResolve,
          cursor,
          timeoutMs,
          startedAt: Date.now(),
          includeEvents,
          includeReasoning,
        };
      });

      const resolveSubmitError = (result: SubmitResult): SubmitResult => {
        if (this.waiter && resolveSubmitWaiter) {
          this.waiter = null;
          resolveSubmitWaiter(result);
        }
        return result;
      };

      // POST /submit after the waiter is live.
      const { status } = await this.client.submit(input);
      if (status !== 202) {
        this.state = { kind: "idle" };
        this.activeTurnId = null;
        return resolveSubmitError({
          status: "error",
          isError: true,
          errorType: "contract_mismatch",
          error: `Reasonix /submit returned ${status}, expected 202.`,
        });
      }

      return await resultPromise;
    } catch (e) {
      const result: SubmitResult = {
        status: "error",
        isError: true,
        errorType: "connection_refused",
        error: `Submit failed: ${e instanceof Error ? e.message : String(e)}`,
      };
      if (this.waiter) {
        this.waiter.resolve(result);
        this.waiter = null;
      }
      this.state = { kind: "idle" };
      this.activeTurnId = null;
      return result;
    } finally {
      this.submitMutex = false;
    }
  }

  /**
   * Create a new waiter for approve/answer continuation.
   * Only consumes events after the current seq (cursor).
   */
  createWaiter(opts: {
    timeoutMs: number;
    includeEvents: boolean;
    includeReasoning: boolean;
  }): { waiterPromise: Promise<SubmitResult>; cleanup: () => void } {
    const cursor = this.eventSeq;

    const waiterPromise = new Promise<SubmitResult>((_resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiter = null;
        this.state = {
          kind: "timed_out",
          activeTurnId: this.activeTurnId ?? "unknown",
          runningMayContinue: true,
        };
        _resolve({
          status: "timed_out",
          isError: true,
          errorType: "timeout",
          activeTurnId: this.activeTurnId ?? undefined,
          hint: "The turn timed out after approve/answer.",
        });
      }, opts.timeoutMs);

      const wrappedResolve = (r: SubmitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        _resolve(r);
      };

      const waiter: Waiter = {
        resolve: wrappedResolve,
        cursor,
        timeoutMs: opts.timeoutMs,
        startedAt: Date.now(),
        includeEvents: opts.includeEvents,
        includeReasoning: opts.includeReasoning,
      };

      // Assign waiter only after wrapped resolve and timeout are ready
      this.waiter = waiter;
    });

    return {
      waiterPromise,
      cleanup: () => {
        this.waiter = null;
      },
    };
  }

  // ---- approve / answer / plan / new ----

  /**
   * Approve or deny a pending tool call.
   *
   * @param waitForTurn  If true (default), continue waiting for turn completion after approve.
   * @param timeoutMs    Timeout for the post-approve wait (if waitForTurn=true).
   */
  async approve(opts: {
    id: string;
    allow: boolean;
    session?: boolean;
    persist?: boolean;
    waitForTurn?: boolean;
    timeoutMs?: number;
    includeEvents?: boolean;
    includeReasoning?: boolean;
  }): Promise<SubmitResult> {
    const {
      id,
      allow,
      session = false,
      persist = false,
      waitForTurn = true,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      includeEvents = false,
      includeReasoning = false,
    } = opts;

    if (this.state.kind !== "pending_approval") {
      return {
        status: "error",
        isError: true,
        errorType: "reasonix_busy",
        error: `No pending approval. Current state: ${this.state.kind}.`,
      };
    }

    const { status } = await this.client.approve({ id, allow, session, persist });
    if (status !== 204) {
      return {
        status: "error",
        isError: true,
        errorType: "contract_mismatch",
        error: `/approve returned ${status}, expected 204.`,
      };
    }

    // Transition back to running so subsequent events are handled
    this.state = {
      kind: "running",
      activeTurnId: this.activeTurnId!,
      startedAt: Date.now(),
    };

    if (!waitForTurn) {
      return {
        status: "approval_sent",
        hint: "Approval sent. Use reasonix_status or reasonix_history to inspect the result.",
      };
    }

    // Wait for turn to continue
    const { waiterPromise } = this.createWaiter({
      timeoutMs,
      includeEvents,
      includeReasoning,
    });
    return waiterPromise;
  }

  /**
   * Answer a pending ask question.
   *
   * @param waitForTurn  If true (default), continue waiting for turn completion after answer.
   */
  async answer(opts: {
    id: string;
    answers: { questionId: string; selected: string[] }[];
    waitForTurn?: boolean;
    timeoutMs?: number;
    includeEvents?: boolean;
    includeReasoning?: boolean;
  }): Promise<SubmitResult> {
    const {
      id,
      answers,
      waitForTurn = true,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      includeEvents = false,
      includeReasoning = false,
    } = opts;

    if (this.state.kind !== "pending_ask") {
      return {
        status: "error",
        isError: true,
        errorType: "reasonix_busy",
        error: `No pending ask. Current state: ${this.state.kind}.`,
      };
    }

    const { status } = await this.client.answer({ id, answers });
    if (status !== 204) {
      return {
        status: "error",
        isError: true,
        errorType: "contract_mismatch",
        error: `/answer returned ${status}, expected 204.`,
      };
    }

    // Transition back to running so subsequent events are handled
    this.state = {
      kind: "running",
      activeTurnId: this.activeTurnId!,
      startedAt: Date.now(),
    };

    if (!waitForTurn) {
      return {
        status: "answer_sent",
        hint: "Answer sent. Use reasonix_status or reasonix_history to inspect the result.",
      };
    }

    const { waiterPromise } = this.createWaiter({
      timeoutMs,
      includeEvents,
      includeReasoning,
    });
    return waiterPromise;
  }

  /** Toggle plan mode on/off. */
  async planMode(on: boolean): Promise<{ ok: boolean }> {
    const { status } = await this.client.plan(on);
    return { ok: status === 204 };
  }

  /**
   * Create a new Reasonix session.
   *
   * Default force=false: rejects if turn is active.
   * force=true: cancels active turn first, then creates new session.
   */
  async newSession(force: boolean = false): Promise<{ ok: boolean; message: string }> {
    if (this.isBusy()) {
      if (!force) {
        return {
          ok: false,
          message: `Cannot create new session: Reasonix has an active turn (state: ${this.state.kind}). Use force=true to cancel first.`,
        };
      }
      // Force: cancel first
      await this.cancel();
      // Poll status until idle
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const { body: status } = await this.client.status();
          if (status && !status.running) break;
        } catch {
          break;
        }
      }
    }

    const { status } = await this.client.newSession();
    if (status !== 204) {
      return {
        ok: false,
        message: `/new returned ${status}, expected 204.`,
      };
    }

    this.state = { kind: "idle" };
    this.activeTurnId = null;
    this.eventBuffer = [];
    this.eventSeq = 0;

    return { ok: true, message: "New Reasonix session created." };
  }

  async cancel(): Promise<{ cancelled: boolean; message: string }> {
    if (this.state.kind === "idle") {
      return { cancelled: false, message: "No active Reasonix turn." };
    }

    if (this.state.kind === "running_unknown") {
      try {
        const { status } = await this.client.cancel();
        if (status === 204) {
          this.state = { kind: "idle" };
          this.activeTurnId = null;
          return { cancelled: true, message: "Cancel sent successfully. Reasonix is now idle." };
        }
        return {
          cancelled: false,
          message: `Cancel returned unexpected status ${status}. Reasonix state remains uncertain.`,
        };
      } catch (e) {
        return {
          cancelled: false,
          message: `Cancel failed: ${e instanceof Error ? e.message : String(e)}. Reasonix state remains uncertain.`,
        };
      }
    }

    if (this.state.kind === "disconnected") {
      return { cancelled: false, message: "Reasonix is disconnected. Cannot cancel." };
    }

    // Active turn: POST /cancel
    try {
      const { status } = await this.client.cancel();
      if (status !== 204) {
        return {
          cancelled: false,
          message: `Cancel returned unexpected status ${status}.`,
        };
      }
    } catch (e) {
      return {
        cancelled: false,
        message: `Cancel failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Clear waiter
    if (this.waiter) {
      this.waiter.resolve({
        status: "error",
        isError: true,
        errorType: "reasonix_busy",
        error: "Turn was cancelled.",
      });
      this.waiter = null;
    }

    // Clear state
    this.state = { kind: "idle" };
    this.activeTurnId = null;
    this.eventBuffer = [];
    this.eventSeq = 0;

    // Poll status to confirm idle
    try {
      const { body: status } = await this.client.status();
      if (status?.running) {
        return {
          cancelled: true,
          message: "Cancel requested but Reasonix is still running. Check reasonix_status for updates.",
        };
      }
    } catch {
      // status check failed, but cancel was sent
    }

    return { cancelled: true, message: "Turn cancelled. Reasonix is now idle." };
  }

  // ---- state sync ----

  async syncState(): Promise<void> {
    try {
      const { body: status } = await this.client.status();
      if (status && !status.running && this.state.kind !== "idle") {
        // timed_out exit path: status shows idle
        this.state = { kind: "idle" };
        this.activeTurnId = null;
        this.eventBuffer = [];
        this.eventSeq = 0;
      }
      if (status && status.running && this.state.kind === "idle") {
        this.state = {
          kind: "running_unknown",
          reason: "Reasonix running detected during sync",
        };
      }
    } catch {
      this.state = { kind: "disconnected", runningUnknown: this.state.kind !== "idle" };
    }
  }

  getClient(): ReasonixClient {
    return this.client;
  }
}
