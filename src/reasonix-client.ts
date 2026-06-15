/**
 * Typed HTTP client for the Reasonix serve REST API.
 *
 * All POST requests carry Content-Type: application/json.
 * Returns structured responses with status codes exposed.
 *
 * Phase 0.5 — standalone prototype.
 */

// ---- types ----

export interface ReasonixStatus {
  autoApproveTools: boolean;
  balance: {
    Available: boolean;
    Infos: {
      Currency: string;
      TotalBalance: string;
      GrantedBalance: string;
      ToppedUpBalance: string;
    }[];
  };
  bypass: boolean;
  cacheHit: number;
  cacheMiss: number;
  cwd: string;
  goal: string;
  goalStatus: string;
  label: string;
  lastUsage?: {
    PromptTokens: number;
    CompletionTokens: number;
    TotalTokens: number;
    CacheHitTokens: number;
    CacheMissTokens: number;
    ReasoningTokens: number;
    FinishReason: string;
  };
  plan: boolean;
  running: boolean;
  toolApprovalMode: string;
  used: number;
  window: number;
}

export interface ReasonixContext {
  used: number;
  window: number;
}

export interface ReasonixMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  toolName?: string;
}

export interface SubmitRequest {
  input: string;
}

export interface ApproveRequest {
  id: string;
  allow: boolean;
  session?: boolean;
  persist?: boolean;
  scope?: string;
}

export interface AnswerRequest {
  id: string;
  answers: { questionId: string; selected: string[] }[];
}

export interface PlanRequest {
  on: boolean;
}

// ---- client ----

export class ReasonixClient {
  constructor(private baseUrl: string = "http://127.0.0.1:8787") {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async post<T>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: T | null }> {
    const r = await fetch(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let responseBody: T | null = null;
    try {
      responseBody = (await r.json()) as T;
    } catch {
      // no JSON body
    }
    return { status: r.status, body: responseBody };
  }

  private async get<T>(path: string): Promise<{ status: number; body: T | null }> {
    const r = await fetch(this.url(path));
    let responseBody: T | null = null;
    try {
      responseBody = (await r.json()) as T;
    } catch {
      // no JSON body
    }
    return { status: r.status, body: responseBody };
  }

  // ---- endpoints ----

  /** GET /status */
  async status(): Promise<{ status: number; body: ReasonixStatus | null }> {
    return this.get<ReasonixStatus>("/status");
  }

  /** GET /context */
  async context(): Promise<{ status: number; body: ReasonixContext | null }> {
    return this.get<ReasonixContext>("/context");
  }

  /** GET /history */
  async history(limit?: number): Promise<{ status: number; body: ReasonixMessage[] | null }> {
    const qs = limit != null ? `?limit=${limit}` : "";
    return this.get<ReasonixMessage[]>(`/history${qs}`);
  }

  /** POST /submit */
  async submit(input: string): Promise<{ status: number; body: null }> {
    return this.post<null>("/submit", { input });
  }

  /** POST /approve */
  async approve(req: ApproveRequest): Promise<{ status: number; body: null }> {
    return this.post<null>("/approve", req);
  }

  /** POST /answer */
  async answer(req: AnswerRequest): Promise<{ status: number; body: null }> {
    return this.post<null>("/answer", req);
  }

  /** POST /plan */
  async plan(on: boolean): Promise<{ status: number; body: null }> {
    return this.post<null>("/plan", { on });
  }

  /** POST /cancel */
  async cancel(): Promise<{ status: number; body: null }> {
    return this.post<null>("/cancel", {});
  }

  /** POST /new */
  async newSession(): Promise<{ status: number; body: null }> {
    return this.post<null>("/new", {});
  }
}
