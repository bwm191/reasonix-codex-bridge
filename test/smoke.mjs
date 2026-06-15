#!/usr/bin/env node
/**
 * Phase 0 smoke test — 验证 Reasonix HTTP API 契约
 *
 * 用 fetch + ReadableStream 手工解析 SSE（不用 EventSource）。
 * 验证: submit → 等 turn_done → 读 history
 *
 * Usage: node test/smoke.mjs
 * Requires: reasonix serve running on http://127.0.0.1:8787
 */

const BASE = process.env.REASONIX_SERVE_URL || "http://127.0.0.1:8787";

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`  ✅ ${name}`);
  passed++;
}
function fail(name, reason) {
  console.log(`  ❌ ${name}: ${reason}`);
  failed++;
}

// ---- helpers ----

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/**
 * Parse SSE from a ReadableStream. Yields parsed JSON events.
 * Filters out ping comments (lines starting with ": ").
 */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);

        if (!line) continue; // skip empty lines
        if (line.startsWith(":")) {
          // ping / comment — skip
          console.log(`  📡 SSE ping: ${line}`);
          continue;
        }
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          // TODO Phase 0.5: handle multi-line data events (SSE spec allows multiple
          // consecutive "data:" lines that form one event, delimited by a blank line).
          // Current Reasonix serve emits single-line JSON so this is sufficient for Phase 0.
          try {
            yield JSON.parse(data);
          } catch {
            console.log(`  ⚠️  SSE unparseable: ${data.slice(0, 80)}...`);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- tests ----

async function test_status_reachable() {
  console.log("\n📋 test: /status reachable");
  const { status, body } = await get("/status");
  if (status !== 200) return fail("/status", `status ${status}`);
  if (typeof body?.running !== "boolean") return fail("/status", "missing running field");
  if (typeof body?.plan !== "boolean") return fail("/status", "missing plan field");
  if (typeof body?.window !== "number") return fail("/status", "missing window field");
  ok("/status returns expected shape");
}

async function test_context() {
  console.log("\n📋 test: /context");
  const { status, body } = await get("/context");
  if (status !== 200) return fail("/context", `status ${status}`);
  if (typeof body?.used !== "number") return fail("/context", "missing used");
  if (typeof body?.window !== "number") return fail("/context", "missing window");
  ok("/context returns expected shape");
}

async function test_history() {
  console.log("\n📋 test: /history");
  const { status, body } = await get("/history");
  if (status !== 200) return fail("/history", `status ${status}`);
  if (!Array.isArray(body)) return fail("/history", "not an array");
  if (body.length < 1) return fail("/history", "expected at least system prompt");
  if (body[0]?.role !== "system") return fail("/history", "first message not system");
  ok(`/history returns ${body.length} messages`);
}

async function test_submit_missing_ct() {
  console.log("\n📋 test: POST /submit without Content-Type");
  const r = await fetch(`${BASE}/submit`, {
    method: "POST",
    body: JSON.stringify({ input: "test" }),
  });
  if (r.status !== 415) return fail("415 check", `expected 415 got ${r.status}`);
  ok("415 without Content-Type");
}

async function test_submit_missing_input() {
  console.log("\n📋 test: POST /submit without input field");
  const { status } = await post("/submit", {});
  if (status !== 400) return fail("400 check", `expected 400 got ${status}`);
  ok("400 without input field");
}

async function test_submit_turn_done() {
  console.log("\n📋 test: submit → SSE → turn_done");

  // Connect SSE first (before submit, per PLAN.md rule)
  const sseResp = await fetch(`${BASE}/events`, { signal: AbortSignal.timeout(30000) });
  if (sseResp.status !== 200) return fail("SSE connect", `status ${sseResp.status}`);
  console.log("  📡 SSE connected");

  const events = sseEvents(sseResp);
  const collected = [];
  let timedOut = false;

  // Submit a task that reliably uses a tool (bash list directory)
  await sleep(100); // small delay after SSE connect
  const { status: submitStatus } = await post("/submit", {
    input: "list files in / (use ls or dir)",
  });
  if (submitStatus !== 202) return fail("submit", `expected 202 got ${submitStatus}`);
  console.log("  📤 submitted task");

  // Collect events until turn_done
  try {
    for await (const ev of events) {
      collected.push(ev);
      // Only log key events to keep output readable
      if (ev.kind === "turn_started") console.log("  🔄 turn_started");
      if (ev.kind === "turn_done") {
        console.log("  ✅ turn_done");
        break;
      }
      if (ev.kind === "approval_request") console.log("  ⏸️  approval_request");
      if (ev.kind === "ask_request") console.log("  ❓ ask_request");
    }
  } catch (e) {
    if (e.name === "AbortError") {
      timedOut = true;
    } else {
      return fail("SSE read", e.message);
    }
  }

  if (timedOut) return fail("SSE timeout", "30s timeout reached before turn_done");

  const kinds = collected.map((e) => e.kind);
  if (!kinds.includes("turn_started")) return fail("turn lifecycle", "no turn_started");
  if (!kinds.includes("turn_done")) return fail("turn lifecycle", "no turn_done");
  // tool_result may not appear if model replies directly; warn but don't fail
  if (!kinds.includes("tool_result")) {
    console.log("  ⚠️  no tool_result (model replied directly — not an error)");
  }

  // Read history to confirm the turn was recorded
  const { body: history } = await get("/history");
  const userMsgs = history.filter((m) => m.role === "user" && m.content?.includes("list files in"));
  if (userMsgs.length === 0) return fail("history check", "task not found in history");

  ok(`submit → SSE → turn_done (${collected.length} events, task in history)`);
}

async function test_approve_missing_id() {
  console.log("\n📋 test: POST /approve without id");
  const { status } = await post("/approve", { allow: true });
  if (status !== 400) return fail("400 check", `expected 400 got ${status}`);
  ok("400 without id");
}

async function test_plan_toggle() {
  console.log("\n📋 test: POST /plan");
  const { status: s1 } = await post("/plan", { on: true });
  if (s1 !== 204) return fail("plan on", `expected 204 got ${s1}`);

  // Verify via /status
  const { body: st1 } = await get("/status");
  if (st1.plan !== true) return fail("plan on verify", `plan not true: ${st1.plan}`);

  const { status: s2 } = await post("/plan", { on: false });
  if (s2 !== 204) return fail("plan off", `expected 204 got ${s2}`);

  const { body: st2 } = await get("/status");
  if (st2.plan !== false) return fail("plan off verify", `plan not false: ${st2.plan}`);

  ok("/plan toggle works");
}

// ---- main ----

async function main() {
  console.log("🧪 Phase 0 Smoke Test — Reasonix HTTP API\n");
  console.log(`   Target: ${BASE}`);

  // Pre-flight: check Reasonix is reachable
  try {
    await fetch(`${BASE}/status`);
  } catch {
    console.log("\nReasonix not reachable. Start with: npx reasonix@1.8.0-rc.1 serve --addr 127.0.0.1:8787\n");
    process.exit(1);
  }

  await test_status_reachable();
  await test_context();
  await test_history();
  await test_submit_missing_ct();
  await test_submit_missing_input();
  await test_approve_missing_id();
  await test_plan_toggle();
  await test_submit_turn_done();

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
