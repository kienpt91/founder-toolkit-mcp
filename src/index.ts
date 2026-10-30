#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr only.
  console.error("founder-toolkit-mcp ready on stdio");
}

main().catch((err) => {
  console.error("founder-toolkit-mcp failed to start:", err);
  process.exit(1);
});
