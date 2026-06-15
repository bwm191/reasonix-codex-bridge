#!/usr/bin/env node
/**
 * Offline MCP status diagnostics test.
 *
 * The bridge should expose enough local configuration to diagnose "MCP is using
 * a different Reasonix serve/key path than the desktop app" without requiring
 * Reasonix itself to be reachable.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const serveUrl = "http://127.0.0.1:1";
const proc = spawn("node", ["build/index.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "ignore"],
  env: {
    ...process.env,
    REASONIX_SERVE_URL: serveUrl,
    REASONIX_AUTO_LAUNCH: "false",
  },
});
const rl = createInterface({ input: proc.stdout });

function send(message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function readResponse(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for MCP response")), timeoutMs);
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
      clientInfo: { name: "status-diagnostics-test", version: "1" },
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
  const response = await readResponse();
  const statusText = response.result?.content?.[0]?.text;
  assert.ok(statusText, "reasonix_status should return text content");

  const status = JSON.parse(statusText);
  assert.equal(status.bridge.connected, false);
  assert.equal(status.bridge.serveUrl, serveUrl);
  assert.equal(status.bridge.autoLaunch, false);
  assert.equal(status.bridge.defaultTimeoutMs > 0, true);
  assert.equal(status.reasonix, null);
} finally {
  rl.close();
  proc.kill("SIGTERM");
}
