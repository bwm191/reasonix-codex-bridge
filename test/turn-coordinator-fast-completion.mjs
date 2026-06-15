#!/usr/bin/env node
/**
 * Regression test for fast Reasonix turns.
 *
 * The bridge must create its waiter before POST /submit can trigger SSE events.
 * Otherwise a fast turn_done event can arrive before the waiter exists and the
 * synchronous submit call incorrectly times out.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { TurnCoordinator } from "../build/turn-coordinator.js";

let sseResponse = null;
let resolveSseConnected;
const sseConnected = new Promise((resolve) => {
  resolveSseConnected = resolve;
});

const history = [{ role: "system", content: "fake system prompt" }];

function writeEvent(event) {
  assert.ok(sseResponse, "SSE connection must be established before submit");
  sseResponse.write(`data: ${JSON.stringify(event)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/status") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        running: false,
        plan: false,
        label: "fake",
        used: 0,
        window: 1000,
      }),
    );
    return;
  }

  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sseResponse = res;
    res.write(": connected\n\n");
    resolveSseConnected();
    return;
  }

  if (req.method === "POST" && req.url === "/submit") {
    req.resume();
    history.push(
      { role: "user", content: "fast completion" },
      { role: "assistant", content: "fast_done" },
    );

    writeEvent({ kind: "turn_started" });
    writeEvent({ kind: "text", text: "fast_done" });
    writeEvent({ kind: "turn_done" });

    setTimeout(() => {
      res.statusCode = 202;
      res.end();
    }, 25);
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/history")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(history));
    return;
  }

  res.statusCode = 404;
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const { port } = server.address();
const coordinator = new TurnCoordinator(`http://127.0.0.1:${port}`);

try {
  await coordinator.initialize();
  coordinator.startSSE();
  await sseConnected;

  const result = await coordinator.submit({
    input: "fast completion",
    timeoutMs: 300,
    includeEvents: true,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.response, "fast_done");
  assert.equal(result.events?.some((event) => event.kind === "turn_done"), true);
} finally {
  coordinator.stopSSE();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
