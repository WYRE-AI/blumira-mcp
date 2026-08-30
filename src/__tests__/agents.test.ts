import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  agents: {
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    listKeys: vi.fn(),
    getKey: vi.fn(),
  },
};

vi.mock('../utils/client.js', () => ({
  getClient: vi.fn(async () => mockClient),
}));

import { agentsHandler } from '../domains/agents.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agentsHandler.getTools', () => {
  it('exposes all agents tools', () => {
    const names = agentsHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'blumira_agents_devices_list',
      'blumira_agents_devices_get',
      'blumira_agents_keys_list',
      'blumira_agents_keys_get',
    ]);
  });
});

describe('agentsHandler.handleCall', () => {
  it('blumira_agents_devices_list forwards paging args to client.agents.listDevices', async () => {
    const apiResponse = { data: [{ id: 'dev-1' }] };
    mockClient.agents.listDevices.mockResolvedValue(apiResponse);

    const args = { page: 1, page_size: 25 };
    const result = await agentsHandler.handleCall('blumira_agents_devices_list', args);

    expect(mockClient.agents.listDevices).toHaveBeenCalledWith(args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_agents_devices_get extracts device_id and calls client.agents.getDevice', async () => {
    const apiResponse = { id: 'dev-2', hostname: 'host-2' };
    mockClient.agents.getDevice.mockResolvedValue(apiResponse);

    const result = await agentsHandler.handleCall('blumira_agents_devices_get', { device_id: 'dev-2' });

    expect(mockClient.agents.getDevice).toHaveBeenCalledWith('dev-2');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_agents_keys_list forwards paging args to client.agents.listKeys', async () => {
    const apiResponse = { data: [{ id: 'key-1' }] };
    mockClient.agents.listKeys.mockResolvedValue(apiResponse);

    const args = { order_by: 'created;desc' };
    const result = await agentsHandler.handleCall('blumira_agents_keys_list', args);

    expect(mockClient.agents.listKeys).toHaveBeenCalledWith(args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_agents_keys_get extracts key_id and calls client.agents.getKey', async () => {
    const apiResponse = { id: 'key-2' };
    mockClient.agents.getKey.mockResolvedValue(apiResponse);

    const result = await agentsHandler.handleCall('blumira_agents_keys_get', { key_id: 'key-2' });

    expect(mockClient.agents.getKey).toHaveBeenCalledWith('key-2');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await agentsHandler.handleCall('blumira_agents_bogus', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
