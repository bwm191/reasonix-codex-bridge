/**
 * Phase 0.5 — Verification Script 3
 *
 * Path: submit → ask_request → answer → turn_done
 *
 * Uses our sse.ts + reasonix-client.ts modules.
 *
 * Usage: npx tsx test/phase-0.5/verify-submit-answer.ts
 */

import { sseStream } from "../../src/sse.js";
import { ReasonixClient } from "../../src/reasonix-client.js";

const BASE = process.env.REASONIX_SERVE_URL || "http://127.0.0.1:8787";

async function main() {
  const client = new ReasonixClient(BASE);

  // Pre-flight check
  const { body: status } = await client.status();
  if (!status) throw new Error("Cannot reach Reasonix");
  if (status.running) throw new Error("Reasonix already has an active turn");
  console.log(`✅ Reasonix reachable (running: ${status.running})`);

  // Connect SSE first
  const ac = new AbortController();
  const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(45000)]);
  console.log("📡 Connecting SSE...");
  const events = sseStream(BASE, signal);

  // Start consuming events in background
  let eventCount = 0;
  let askId: string | null = null;
  let hadTurnStarted = false;
  let hadAskRequest = false;
  let hadTurnDone = false;

  const eventLoop = (async () => {
    for await (const ev of events) {
      eventCount++;
      switch (ev.kind) {
        case "turn_started":
          hadTurnStarted = true;
          console.log("   🔄 turn_started");
          break;
        case "ask_request":
          hadAskRequest = true;
          askId = ev.ask.id;
          console.log(
            `   ❓ ask_request id=${askId} questions=${ev.ask.questions.length}`,
          );
          // Answer immediately
          const answers = ev.ask.questions.map((q) => ({
            questionId: q.id,
            selected: [q.options[0]?.label ?? "TypeScript"],
          }));
          console.log(`   ✍️  Answering id=${askId} with ${answers.map((a) => a.selected).join(", ")}...`);
          const { status: answerStatus } = await client.answer({
            id: askId,
            answers,
          });
          if (answerStatus !== 204) {
            console.log(`   ⚠️ answer returned ${answerStatus}`);
          } else {
            console.log("   ✓ Answered");
          }
          break;
        case "tool_result":
          console.log(`   🔧 tool_result (${ev.tool.name}, ${ev.tool.durationMs}ms)`);
          break;
        case "turn_done":
          hadTurnDone = true;
          console.log("   ✅ turn_done");
          return;
        case "usage":
          console.log(`   📊 usage: ${ev.usage.totalTokens}t ¥${ev.usage.cost}`);
          break;
      }
    }
  })();

  // Small delay to let SSE fetch complete, then submit
  await new Promise((r) => setTimeout(r, 300));
  console.log("📤 Submitting ask question task...");
  const { status: submitStatus } = await client.submit(
    "Ask me which programming language to use for this project. Options: TypeScript, Python, Go, Rust.",
  );
  if (submitStatus !== 202) throw new Error(`submit returned ${submitStatus}`);
  console.log("   ✓ 202 Accepted");

  await eventLoop;

  // Verify the full path
  if (!hadTurnStarted) throw new Error("No turn_started event");
  if (!hadAskRequest) throw new Error("No ask_request event (model may have answered directly — try again)");
  if (!hadTurnDone) throw new Error("No turn_done event");

  console.log(`\n✅ Path 3 verified: submit → ask_request → answer → turn_done (${eventCount} events)`);
}

main().catch((e) => {
  console.error(`\n❌ FAIL: ${e.message}`);
  process.exit(1);
});
