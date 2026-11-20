import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DomainHandler, DomainName } from '../utils/types.js';
import { findingsHandler } from './findings.js';
import { agentsHandler } from './agents.js';
import { usersHandler } from './users.js';
import { mspHandler } from './msp.js';
import { resolutionsHandler } from './resolutions.js';

export const HANDLERS: Record<DomainName, DomainHandler> = {
  findings: findingsHandler,
  agents: agentsHandler,
  users: usersHandler,
  msp: mspHandler,
  resolutions: resolutionsHandler,
};

/** Every domain tool, flat. Served by tools/list with no navigation step. */
export function getAllTools(): Tool[] {
  return Object.values(HANDLERS).flatMap(h => h.getTools());
}

/** Resolve the handler that owns a tool name, or undefined if none does. */
export function getHandlerForTool(toolName: string): DomainHandler | undefined {
  return Object.values(HANDLERS).find(h => h.getTools().some(t => t.name === toolName));
}
