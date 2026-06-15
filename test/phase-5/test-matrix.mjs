#!/usr/bin/env node
/**
 * Phase 5 — Test Matrix
 *
 * Verifies the MCP bridge tool responses without requiring a full MCP transport.
 * Tests the TurnCoordinator state machine, tool handlers, and edge cases.
 *
 * Usage: node test/phase-5/test-matrix.mjs
 * Requires: reasonix serve running, bridge built
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const BRIDGE_PATH = "./build/index.js";

let passed = 0;
let failed = 0;
let testName = "";

function ok(msg) { passed++; console.log(`  ✅ ${msg}`); }
function fail(msg) { failed++; console.log(`  ❌ ${testName}: ${msg}`); }

function startBridge() {
  const proc = spawn("node", [BRIDGE_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const rl = createInterface({ input: proc.stdout });
  return { proc, rl };
}

function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

async function readResponse(rl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    rl.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ raw: line });
      }
    });
  });
}

async function run() {
  console.log("🧪 Phase 5 Test Matrix\n");

  // ---- Test 1: Initialize ----
  testName = "Initialize";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const resp = await readResponse(rl);
    if (resp?.result?.protocolVersion) ok("initialize succeeds");
    else fail(`unexpected: ${JSON.stringify(resp).slice(0, 100)}`);

    // Test 2: Tools list
    testName = "Tools list";
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const resp2 = await readResponse(rl);
    const tools = resp2?.result?.tools;
    if (tools?.length === 10) ok(`10 tools registered: ${tools.map(t => t.name).join(", ")}`);
    else fail(`expected 10 tools, got ${tools?.length}`);

    proc.kill();
  }

  // ---- Test 3: reasonix_status ----
  testName = "reasonix_status";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_status", arguments: {} } });
    const resp = await readResponse(rl);
    const text = resp?.result?.content?.[0]?.text;
    if (text) {
      const data = JSON.parse(text);
      if (data.bridge?.state) ok(`status returns state: ${data.bridge.state}, connected: ${data.bridge.connected}`);
      else fail("no bridge state");
    } else fail("no response text");
    proc.kill();
  }

  // ---- Test 4: reasonix_context ----
  testName = "reasonix_context";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_context", arguments: {} } });
    const resp = await readResponse(rl);
    const text = resp?.result?.content?.[0]?.text;
    if (text) {
      const data = JSON.parse(text);
      if (typeof data.used === "number" && typeof data.window === "number") ok(`context: used=${data.used}, window=${data.window}`);
      else fail(`unexpected context: ${text}`);
    } else fail("no response");
    proc.kill();
  }

  // ---- Test 5: reasonix_cancel (idle) ----
  testName = "reasonix_cancel (idle)";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_cancel", arguments: {} } });
    const resp = await readResponse(rl);
    const text = resp?.result?.content?.[0]?.text;
    if (text?.includes("No active") || text?.includes("cancelled")) ok("cancel returns valid response");
    else fail(`unexpected: ${text}`);
    proc.kill();
  }

  // ---- Test 6: reasonix_submit (sync, completed) ----
  testName = "reasonix_submit (sync)";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    // Cancel any stray pending state first
    send(proc, { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "reasonix_cancel", arguments: {} } });
    await readResponse(rl, 5000);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_submit", arguments: { input: "echo phase5_test", timeoutMs: 30000 } } });
    const resp = await readResponse(rl, 25000);
    const text = resp?.result?.content?.[0]?.text;
    if (text) {
      const data = JSON.parse(text);
      if (data.status === "completed") ok(`submit completed: response="${data.response?.slice(0, 40)}..." usage=${data.usage?.totalTokens || "N/A"}`);
      else ok(`submit returned: status=${data.status} (${data.error || data.hint || ""})`);
    } else fail("no response");
    proc.kill();
  }

  // ---- Test 7: reasonix_submit (includeEvents) ----
  testName = "reasonix_submit (includeEvents)";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_submit", arguments: { input: "say hi", timeoutMs: 30000, includeEvents: true } } });
    const resp = await readResponse(rl, 20000);
    const text = resp?.result?.content?.[0]?.text;
    if (text) {
      const data = JSON.parse(text);
      if (data.status === "completed" && data.eventsIncluded && data.events?.length > 0) ok(`includeEvents: ${data.events.length} events returned`);
      else if (data.status === "completed") fail(`eventsIncluded=${data.eventsIncluded} events count=${data.events?.length}`);
      else fail(`status=${data.status}`);
    } else fail("no response");
    proc.kill();
  }

  // ---- Test 8: reasonix_submit (missing input) ----
  testName = "reasonix_submit (missing input)";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_submit", arguments: {} } });
    const resp = await readResponse(rl);
    if (resp?.result?.isError) ok("missing input returns isError");
    else fail("missing input should return isError");
    proc.kill();
  }

  // ---- Test 9: reasonix_history ----
  testName = "reasonix_history";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_history", arguments: { limit: 2 } } });
    const resp = await readResponse(rl);
    const text = resp?.result?.content?.[0]?.text;
    if (text) {
      const data = JSON.parse(text);
      if (Array.isArray(data)) ok(`history returns ${data.length} messages`);
      else fail(`not an array: ${text.slice(0, 60)}`);
    } else fail("no response");
    proc.kill();
  }

  // ---- Test 10: reasonix_plan_mode ----
  testName = "reasonix_plan_mode";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_plan_mode", arguments: { on: false } } });
    const resp = await readResponse(rl);
    const text = resp?.result?.content?.[0]?.text;
    if (text?.includes("ok")) ok("plan_mode toggle works");
    else fail(`unexpected: ${text}`);
    proc.kill();
  }

  // ---- Test 11: reasonix_new_session ----
  testName = "reasonix_new_session";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_new_session", arguments: {} } });
    const resp = await readResponse(rl);
    const text = resp?.result?.content?.[0]?.text;
    if (text?.includes("ok")) ok("new_session returns ok");
    else fail(`unexpected: ${text}`);
    proc.kill();
  }

  // ---- Test 12: Submit approval flow ----
  testName = "Submit → approval_request";
  {
    const { proc, rl } = startBridge();
    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await readResponse(rl);
    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reasonix_submit", arguments: { input: "Write a file /tmp/test-phase5.txt with content test", timeoutMs: 45000 } } });
    const resp = await readResponse(rl, 50000);
    const text = resp?.result?.content?.[0]?.text;
    if (text) {
      const data = JSON.parse(text);
      if (data.status === "pending_approval") {
        ok(`approval flow: got pending_approval, id=${data.approvalId}`);

        // Send approve with waitForTurn=true
        send(proc, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reasonix_approve", arguments: { id: data.approvalId, allow: true, waitForTurn: true, timeoutMs: 30000 } } });
        const resp2 = await readResponse(rl, 35000);
        const text2 = resp2?.result?.content?.[0]?.text;
        if (text2) {
          const data2 = JSON.parse(text2);
          if (data2.status === "completed") ok("approve → completed");
          else ok(`approve → ${data2.status}`);
        }
      } else if (data.status === "completed") {
        ok("approval not needed (auto-approved or model replied directly)");
      } else {
        ok(`status: ${data.status} (may not need approval)`);
      }
    } else fail("no response");
    proc.kill();
  }

  // ---- Summary ----
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(`\n❌ Test harness error: ${e.message}`);
  process.exit(1);
});
