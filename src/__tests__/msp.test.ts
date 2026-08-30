import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  msp: {
    listAccounts: vi.fn(),
    getAccount: vi.fn(),
    listAllFindings: vi.fn(),
    listFindings: vi.fn(),
    getFinding: vi.fn(),
    resolveFinding: vi.fn(),
    assignFindingOwners: vi.fn(),
    listFindingComments: vi.fn(),
    addFindingComment: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    listKeys: vi.fn(),
    getKey: vi.fn(),
    listUsers: vi.fn(),
  },
};

vi.mock('../utils/client.js', () => ({
  getClient: vi.fn(async () => mockClient),
}));

import { mspHandler } from '../domains/msp.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mspHandler.getTools', () => {
  it('exposes all msp tools', () => {
    const names = mspHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'blumira_msp_accounts_list',
      'blumira_msp_accounts_get',
      'blumira_msp_findings_all',
      'blumira_msp_findings_list',
      'blumira_msp_findings_get',
      'blumira_msp_findings_resolve',
      'blumira_msp_findings_assign',
      'blumira_msp_findings_comments_list',
      'blumira_msp_findings_comments_add',
      'blumira_msp_devices_list',
      'blumira_msp_devices_get',
      'blumira_msp_keys_list',
      'blumira_msp_keys_get',
      'blumira_msp_users_list',
    ]);
  });
});

describe('mspHandler.handleCall', () => {
  it('blumira_msp_accounts_list forwards paging args to client.msp.listAccounts', async () => {
    const apiResponse = { data: [{ id: 'acct-1', name: 'Acme Co' }] };
    mockClient.msp.listAccounts.mockResolvedValue(apiResponse);

    const args = { page: 1 };
    const result = await mspHandler.handleCall('blumira_msp_accounts_list', args);

    expect(mockClient.msp.listAccounts).toHaveBeenCalledWith(args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_accounts_get extracts account_id and calls client.msp.getAccount', async () => {
    const apiResponse = { id: 'acct-2', license: 'pro' };
    mockClient.msp.getAccount.mockResolvedValue(apiResponse);

    const result = await mspHandler.handleCall('blumira_msp_accounts_get', { account_id: 'acct-2' });

    expect(mockClient.msp.getAccount).toHaveBeenCalledWith('acct-2');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_findings_all forwards filter args to client.msp.listAllFindings', async () => {
    const apiResponse = { data: [{ id: 'f-1' }] };
    mockClient.msp.listAllFindings.mockResolvedValue(apiResponse);

    const args = { status: 10, priority: 2 };
    const result = await mspHandler.handleCall('blumira_msp_findings_all', args);

    expect(mockClient.msp.listAllFindings).toHaveBeenCalledWith(args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_findings_list splits account_id from the rest of the args', async () => {
    const apiResponse = { data: [{ id: 'f-2' }] };
    mockClient.msp.listFindings.mockResolvedValue(apiResponse);

    const args = { account_id: 'acct-3', status: 10, page: 1 };
    const result = await mspHandler.handleCall('blumira_msp_findings_list', args);

    expect(mockClient.msp.listFindings).toHaveBeenCalledWith('acct-3', args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_findings_get extracts account_id and finding_id', async () => {
    const apiResponse = { id: 'f-3', status: 10 };
    mockClient.msp.getFinding.mockResolvedValue(apiResponse);

    const result = await mspHandler.handleCall('blumira_msp_findings_get', {
      account_id: 'acct-4',
      finding_id: 'f-3',
    });

    expect(mockClient.msp.getFinding).toHaveBeenCalledWith('acct-4', 'f-3');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_findings_resolve maps resolution + resolution_notes into a shaped payload', async () => {
    mockClient.msp.resolveFinding.mockResolvedValue({ id: 'f-4' });

    await mspHandler.handleCall('blumira_msp_findings_resolve', {
      account_id: 'acct-5',
      finding_id: 'f-4',
      resolution: 30,
      resolution_notes: 'no action needed',
    });

    expect(mockClient.msp.resolveFinding).toHaveBeenCalledWith('acct-5', 'f-4', {
      resolution: 30,
      resolution_notes: 'no action needed',
    });
  });

  it('blumira_msp_findings_assign maps owner_type + owners into a shaped payload', async () => {
    mockClient.msp.assignFindingOwners.mockResolvedValue({ id: 'f-5' });

    await mspHandler.handleCall('blumira_msp_findings_assign', {
      account_id: 'acct-6',
      finding_id: 'f-5',
      owner_type: 'manager',
      owners: ['user-9'],
    });

    expect(mockClient.msp.assignFindingOwners).toHaveBeenCalledWith('acct-6', 'f-5', {
      owner_type: 'manager',
      owners: ['user-9'],
    });
  });

  it('blumira_msp_findings_comments_list extracts account_id and finding_id', async () => {
    const apiResponse = [{ id: 'c-1' }];
    mockClient.msp.listFindingComments.mockResolvedValue(apiResponse);

    const result = await mspHandler.handleCall('blumira_msp_findings_comments_list', {
      account_id: 'acct-7',
      finding_id: 'f-6',
    });

    expect(mockClient.msp.listFindingComments).toHaveBeenCalledWith('acct-7', 'f-6');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_findings_comments_add maps body + sender into a shaped payload', async () => {
    mockClient.msp.addFindingComment.mockResolvedValue({ id: 'c-2' });

    await mspHandler.handleCall('blumira_msp_findings_comments_add', {
      account_id: 'acct-8',
      finding_id: 'f-7',
      body: 'note',
      sender: 'user-2',
    });

    expect(mockClient.msp.addFindingComment).toHaveBeenCalledWith('acct-8', 'f-7', {
      body: 'note',
      sender: 'user-2',
    });
  });

  it('blumira_msp_devices_list forwards account_id and args to client.msp.listDevices', async () => {
    const apiResponse = { data: [{ id: 'dev-1' }] };
    mockClient.msp.listDevices.mockResolvedValue(apiResponse);

    const args = { account_id: 'acct-9', page: 1 };
    const result = await mspHandler.handleCall('blumira_msp_devices_list', args);

    expect(mockClient.msp.listDevices).toHaveBeenCalledWith('acct-9', args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_devices_get extracts account_id and device_id', async () => {
    const apiResponse = { id: 'dev-2' };
    mockClient.msp.getDevice.mockResolvedValue(apiResponse);

    const result = await mspHandler.handleCall('blumira_msp_devices_get', {
      account_id: 'acct-10',
      device_id: 'dev-2',
    });

    expect(mockClient.msp.getDevice).toHaveBeenCalledWith('acct-10', 'dev-2');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_keys_list forwards account_id and args to client.msp.listKeys', async () => {
    const apiResponse = { data: [{ id: 'key-1' }] };
    mockClient.msp.listKeys.mockResolvedValue(apiResponse);

    const args = { account_id: 'acct-11' };
    const result = await mspHandler.handleCall('blumira_msp_keys_list', args);

    expect(mockClient.msp.listKeys).toHaveBeenCalledWith('acct-11', args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_keys_get extracts account_id and key_id', async () => {
    const apiResponse = { id: 'key-2' };
    mockClient.msp.getKey.mockResolvedValue(apiResponse);

    const result = await mspHandler.handleCall('blumira_msp_keys_get', {
      account_id: 'acct-12',
      key_id: 'key-2',
    });

    expect(mockClient.msp.getKey).toHaveBeenCalledWith('acct-12', 'key-2');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_msp_users_list forwards account_id and args to client.msp.listUsers', async () => {
    const apiResponse = { data: [{ id: 'u-1' }] };
    mockClient.msp.listUsers.mockResolvedValue(apiResponse);

    const args = { account_id: 'acct-13' };
    const result = await mspHandler.handleCall('blumira_msp_users_list', args);

    expect(mockClient.msp.listUsers).toHaveBeenCalledWith('acct-13', args);
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await mspHandler.handleCall('blumira_msp_bogus', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
