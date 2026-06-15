/**
 * Phase 0.5 — Verification Script 1
 *
 * Path: submit → turn_done → history
 *
 * Uses our sse.ts + reasonix-client.ts modules.
 *
 * Usage: npx tsx test/phase-0.5/verify-submit-turn-done.ts
 */

import { sseStream } from "../../src/sse.js";
import { ReasonixClient } from "../../src/reasonix-client.js";

const BASE = process.env.REASONIX_SERVE_URL || "http://127.0.0.1:8787";

async function main() {
  const client = new ReasonixClient(BASE);

  // Pre-flight check
  const { body: status } = await client.status();
  if (!status) throw new Error("Cannot reach Reasonix");
  console.log(`✅ Reasonix reachable (model: ${status.label}, running: ${status.running})`);

  // Connect SSE first (start consuming so fetch runs)
  const signal = AbortSignal.timeout(60000);
  console.log("📡 Connecting SSE...");
  const events = sseStream(BASE, signal);

  // Start consuming events in background; submit concurrently
  let eventCount = 0;
  let hadTurnStarted = false;
  let hadToolResult = false;
  let hadTurnDone = false;

  const eventLoop = (async () => {
    for await (const ev of events) {
      eventCount++;
      switch (ev.kind) {
        case "turn_started":
          hadTurnStarted = true;
          console.log("   🔄 turn_started");
          break;
        case "tool_result":
          hadToolResult = true;
          console.log(`   🔧 tool_result (${ev.tool.name}, ${ev.tool.durationMs}ms)`);
          break;
        case "turn_done":
          hadTurnDone = true;
          if (ev.err) console.log(`   ⚠️ turn_done with err: ${ev.err}`);
          else console.log("   ✅ turn_done");
          return; // exit loop
        case "usage":
          console.log(
            `   📊 usage: ${ev.usage.totalTokens}t (${ev.usage.cacheHitTokens} cache hit) ¥${ev.usage.cost}`,
          );
          break;
      }
    }
  })();

  // Small delay to let SSE fetch complete, then submit
  await new Promise((r) => setTimeout(r, 300));
  console.log('📤 Submitting "echo phase_0.5_test_1"...');
  const { status: submitStatus } = await client.submit("echo phase_0.5_test_1");
  if (submitStatus !== 202) throw new Error(`submit returned ${submitStatus}`);
  console.log("   ✓ 202 Accepted");

  await eventLoop;
  if (!hadTurnStarted) throw new Error("No turn_started event");
  if (!hadTurnDone) throw new Error("No turn_done event");

  // Read history
  const { body: history } = await client.history();
  if (!history) throw new Error("Cannot read history");

  const found = history.filter(
    (m) => m.role === "user" && m.content?.includes("phase_0.5_test_1"),
  );
  if (found.length === 0) throw new Error("Task not found in history");

  console.log(`\n✅ Path 1 verified: submit → turn_done → history (${eventCount} events, in history)`);
}

main().catch((e) => {
  console.error(`\n❌ FAIL: ${e.message}`);
  process.exit(1);
});
