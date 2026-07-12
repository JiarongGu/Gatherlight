// MCP stdio server — the AGENT-facing adapter for the backend tool registry.
//
// The chat's local claude CLI spawns this over stdio (see mcp.chat.json, wired in
// via --mcp-config on the chat runs). It exposes exactly the same `tools.ts`
// registry the HTTP API serves, so a tool defined once is reachable from both the
// frontend (HTTP) and the agent (MCP).
//
// PROTOCOL NOTE: MCP uses stdout for JSON-RPC — nothing here may write to stdout
// except the transport. All logs go to stderr. (The Claude-backed tools spawn a
// child claude whose stdout is captured internally, never inherited.)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { listTools, runTool, MCP_SERVER_NAME } from './tools.ts';

async function main(): Promise<void> {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // tools/list — advertise everything exposed on the MCP surface.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools('mcp')
  }));

  // tools/call — dispatch through the shared registry. Tool-level failures are
  // returned as isError content (so the model can read + react), not as protocol
  // errors, per MCP convention.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const text = await runTool(name, (args ?? {}) as Record<string, unknown>, 'mcp');
      return { content: [{ type: 'text', text }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `工具错误:${err?.message ?? err}` }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mcp:${MCP_SERVER_NAME}] ready on stdio (${listTools('mcp').length} tools)\n`);
}

main().catch((err) => {
  process.stderr.write(`[mcp:${MCP_SERVER_NAME}] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
