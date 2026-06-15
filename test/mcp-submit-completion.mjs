#!/usr/bin/env node
/**
 * End-to-end MCP submit check.
 *
 * Requires a working Reasonix serve on REASONIX_SERVE_URL (default:
 * http://127.0.0.1:8787). This test fails if the turn ends with a provider
 * auth error, timeout, pending approval, or any status other than completed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const expected = `mcp_submit_ok_${Date.now()}`;
const proc = spawn("node", ["build/index.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
const rl = createInterface({ input: proc.stdout });
const stderrLines = [];
createInterface({ input: proc.stderr }).on("line", (line) => {
  stderrLines.push(line);
});

function send(message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function readResponse(timeoutMs = 70000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for MCP response; stderr=${stderrLines.slice(-5).join(" | ")}`));
    }, timeoutMs);
    rl.once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
}

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-submit-completion-test", version: "1" },
    },
  });
  await readResponse();
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "reasonix_status", arguments: {} },
  });
  const statusResponse = await readResponse();
  const statusText = statusResponse.result?.content?.[0]?.text;
  assert.ok(statusText, "reasonix_status should return text content");
  const status = JSON.parse(statusText);
  assert.equal(
    status.bridge.connected,
    true,
    `Reasonix serve is not reachable at ${status.bridge.serveUrl}`,
  );

  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "reasonix_submit",
      arguments: {
        input: `Reply with exactly: ${expected}`,
        timeoutMs: 60000,
      },
    },
  });
  const submitResponse = await readResponse();
  const submitText = submitResponse.result?.content?.[0]?.text;
  assert.ok(submitText, "reasonix_submit should return text content");
  const submit = JSON.parse(submitText);

  assert.equal(submit.status, "completed", submit.error ?? submit.hint);
  assert.equal(submit.response?.trim(), expected);
  assert.equal(submitResponse.result?.isError === true, false);
} finally {
  rl.close();
  proc.kill("SIGTERM");
}
