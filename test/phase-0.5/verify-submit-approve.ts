/**
 * Phase 0.5 — Verification Script 2
 *
 * Path: submit → approval_request → approve → turn_done
 *
 * Uses our sse.ts + reasonix-client.ts modules.
 *
 * Usage: npx tsx test/phase-0.5/verify-submit-approve.ts
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
  let approvalId: string | null = null;
  let hadTurnStarted = false;
  let hadApprovalRequest = false;
  let hadTurnDone = false;

  const eventLoop = (async () => {
    for await (const ev of events) {
      eventCount++;
      switch (ev.kind) {
        case "turn_started":
          hadTurnStarted = true;
          console.log("   🔄 turn_started");
          break;
        case "approval_request":
          hadApprovalRequest = true;
          approvalId = ev.approval.id;
          console.log(`   ⏸️  approval_request id=${approvalId} tool=${ev.approval.tool}`);
          // Approve immediately
          console.log(`   👍 Approving id=${approvalId}...`);
          const { status: approveStatus } = await client.approve({
            id: approvalId,
            allow: true,
          });
          if (approveStatus !== 204) {
            console.log(`   ⚠️ approve returned ${approveStatus}`);
          } else {
            console.log("   ✓ Approved");
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
  console.log("📤 Submitting write-file task...");
  const { status: submitStatus } = await client.submit(
    "Write a file /tmp/phase05-test.txt with content verify_approval",
  );
  if (submitStatus !== 202) throw new Error(`submit returned ${submitStatus}`);
  console.log("   ✓ 202 Accepted");

  await eventLoop;

  // Verify the full path
  if (!hadTurnStarted) throw new Error("No turn_started event");
  if (!hadApprovalRequest) throw new Error("No approval_request event (file write may not need approval — try again)");
  if (!hadTurnDone) throw new Error("No turn_done event");

  console.log(`\n✅ Path 2 verified: submit → approval_request → approve → turn_done (${eventCount} events)`);
}

main().catch((e) => {
  console.error(`\n❌ FAIL: ${e.message}`);
  process.exit(1);
});
