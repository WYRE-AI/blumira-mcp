import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials } from '../utils/client.js';
import { HANDLERS, getAllTools } from './index.js';

export function getStatusTool(): Tool {
  return {
    name: 'blumira_status',
    description: 'Check Blumira API connection status and list the available tools by domain.',
    inputSchema: { type: 'object' as const, properties: {} },
  };
}

export function getStatus() {
  return {
    connected: !!getCredentials(),
    toolCount: getAllTools().length + 1,
    domains: Object.fromEntries(
      Object.entries(HANDLERS).map(([domain, h]) => [domain, h.getTools().map(t => t.name)]),
    ),
  };
}
