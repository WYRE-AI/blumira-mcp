import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the client module directly — domain handlers import getClient from
// ../utils/client.js and call methods on the resolved client. Mocking at
// this boundary lets us assert exact outbound call shape without touching
// credentials, OAuth, or the real Blumira SDK.
const mockClient = {
  findings: {
    list: vi.fn(),
    get: vi.fn(),
    getDetails: vi.fn(),
    resolve: vi.fn(),
    assignOwners: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
  },
};

vi.mock('../utils/client.js', () => ({
  getClient: vi.fn(async () => mockClient),
}));

import { findingsHandler } from '../domains/findings.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findingsHandler.getTools', () => {
  it('exposes all findings tools', () => {
    const names = findingsHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'blumira_findings_list',
      'blumira_findings_get',
      'blumira_findings_details',
      'blumira_findings_resolve',
      'blumira_findings_assign',
      'blumira_findings_comments_list',
      'blumira_findings_comments_add',
    ]);
  });
});

describe('findingsHandler.handleCall', () => {
  it('blumira_findings_list forwards filter args and returns the raw response', async () => {
    const apiResponse = { data: [{ id: 'f-1', name: 'Suspicious login' }], total: 1 };
    mockClient.findings.list.mockResolvedValue(apiResponse);

    const args = { status: 10, priority: 3, page: 2, page_size: 50 };
    const result = await findingsHandler.handleCall('blumira_findings_list', args);

    expect(mockClient.findings.list).toHaveBeenCalledWith(args);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_findings_list handles an array response shape too', async () => {
    const apiResponse = [{ id: 'f-2' }];
    mockClient.findings.list.mockResolvedValue(apiResponse);

    const result = await findingsHandler.handleCall('blumira_findings_list', {});

    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_findings_get extracts finding_id and calls client.findings.get', async () => {
    const apiResponse = { id: 'f-3', status: 10 };
    mockClient.findings.get.mockResolvedValue(apiResponse);

    const result = await findingsHandler.handleCall('blumira_findings_get', { finding_id: 'f-3' });

    expect(mockClient.findings.get).toHaveBeenCalledWith('f-3');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_findings_details calls client.findings.getDetails with the id', async () => {
    const apiResponse = { id: 'f-4', owners: [], summary: 'x' };
    mockClient.findings.getDetails.mockResolvedValue(apiResponse);

    const result = await findingsHandler.handleCall('blumira_findings_details', { finding_id: 'f-4' });

    expect(mockClient.findings.getDetails).toHaveBeenCalledWith('f-4');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_findings_resolve maps resolution + resolution_notes into a shaped payload', async () => {
    const apiResponse = { id: 'f-5', status: 40 };
    mockClient.findings.resolve.mockResolvedValue(apiResponse);

    await findingsHandler.handleCall('blumira_findings_resolve', {
      finding_id: 'f-5',
      resolution: 40,
      resolution_notes: 'accepted risk',
    });

    expect(mockClient.findings.resolve).toHaveBeenCalledWith('f-5', {
      resolution: 40,
      resolution_notes: 'accepted risk',
    });
  });

  it('blumira_findings_resolve omits resolution_notes when not provided', async () => {
    mockClient.findings.resolve.mockResolvedValue({ id: 'f-6' });

    await findingsHandler.handleCall('blumira_findings_resolve', { finding_id: 'f-6', resolution: 20 });

    expect(mockClient.findings.resolve).toHaveBeenCalledWith('f-6', {
      resolution: 20,
      resolution_notes: undefined,
    });
  });

  it('blumira_findings_assign maps owner_type + owners into a shaped payload', async () => {
    mockClient.findings.assignOwners.mockResolvedValue({ id: 'f-7' });

    await findingsHandler.handleCall('blumira_findings_assign', {
      finding_id: 'f-7',
      owner_type: 'responder',
      owners: ['user-1', 'user-2'],
    });

    expect(mockClient.findings.assignOwners).toHaveBeenCalledWith('f-7', {
      owner_type: 'responder',
      owners: ['user-1', 'user-2'],
    });
  });

  it('blumira_findings_comments_list calls client.findings.listComments with the id', async () => {
    const apiResponse = [{ id: 'c-1', body: 'hi' }];
    mockClient.findings.listComments.mockResolvedValue(apiResponse);

    const result = await findingsHandler.handleCall('blumira_findings_comments_list', { finding_id: 'f-8' });

    expect(mockClient.findings.listComments).toHaveBeenCalledWith('f-8');
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('blumira_findings_comments_add maps body + sender into a shaped payload', async () => {
    mockClient.findings.addComment.mockResolvedValue({ id: 'c-2' });

    await findingsHandler.handleCall('blumira_findings_comments_add', {
      finding_id: 'f-9',
      body: '<p>note</p>',
      sender: 'user-3',
    });

    expect(mockClient.findings.addComment).toHaveBeenCalledWith('f-9', {
      body: '<p>note</p>',
      sender: 'user-3',
    });
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await findingsHandler.handleCall('blumira_findings_bogus', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
