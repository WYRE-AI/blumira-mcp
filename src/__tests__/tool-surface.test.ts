import { describe, it, expect } from 'vitest';
import { createServer } from '../server.js';
import { getAllTools, getHandlerForTool } from '../domains/index.js';
import { getStatusTool } from '../domains/status.js';

function request(method: 'tools/list' | 'tools/call', params: Record<string, unknown> = {}) {
  const handler = (createServer() as any)._requestHandlers.get(method);
  return handler({ method, params }, {});
}

async function listNames(): Promise<string[]> {
  const res = await request('tools/list');
  return res.tools.map((t: { name: string }) => t.name);
}

describe('tool surface (flat list, no navigation)', () => {
  it('lists all 27 domain tools plus blumira_status on a fresh session', async () => {
    const names = await listNames();
    expect(names).toHaveLength(28);
    expect(names).toContain('blumira_status');
    expect(getAllTools()).toHaveLength(27);
    for (const t of getAllTools()) expect(names).toContain(t.name);
  });

  it('has no navigate/back tools', async () => {
    const names = await listNames();
    expect(names.filter(n => /_navigate$|_back$/.test(n))).toEqual([]);
  });

  it('has no duplicate tool names', async () => {
    const names = await listNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('routes every listed domain tool to a handler', () => {
    for (const t of getAllTools()) {
      expect(getHandlerForTool(t.name), t.name).toBeDefined();
    }
    expect(getHandlerForTool(getStatusTool().name)).toBeUndefined();
  });

  it('rejects an unknown tool without requiring navigation', async () => {
    const res = await request('tools/call', { name: 'blumira_nope', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown tool');
  });

  it('blumira_status reports the tool surface by domain', async () => {
    const res = await request('tools/call', { name: 'blumira_status', arguments: {} });
    const body = JSON.parse(res.content[0].text);
    expect(body.toolCount).toBe(28);
    expect(Object.keys(body.domains).sort()).toEqual(['agents', 'findings', 'msp', 'resolutions', 'users']);
  });
});
