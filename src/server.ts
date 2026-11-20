import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAllTools, getHandlerForTool } from './domains/index.js';
import { getStatusTool, getStatus } from './domains/status.js';
import { logger } from './utils/logger.js';

export function createServer(): Server {
  const server = new Server(
    { name: 'blumira-mcp', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    }
  );

  // Flat tool list: every tool is listed on a fresh session. Conduit refuses to
  // list or proxy `_navigate`, so a navigation gate would hide the domain tools.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [getStatusTool(), ...getAllTools()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    if (name === 'blumira_status') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(getStatus(), null, 2) }],
      };
    }

    const handler = getHandlerForTool(name);
    if (!handler) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      return await handler.handleCall(name, (args || {}) as Record<string, unknown>, extra);
    } catch (error) {
      logger.error('Tool call failed', { tool: name, error: (error as Error).message });
      return {
        content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}
