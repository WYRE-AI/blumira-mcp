import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  resolutions: {
    list: vi.fn(),
  },
};

vi.mock('../utils/client.js', () => ({
  getClient: vi.fn(async () => mockClient),
}));

import { resolutionsHandler } from '../domains/resolutions.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolutionsHandler.getTools', () => {
  it('exposes the resolutions_list tool', () => {
    const names = resolutionsHandler.getTools().map((t) => t.name);
    expect(names).toEqual(['blumira_resolutions_list']);
  });
});

describe('resolutionsHandler.handleCall', () => {
  it('blumira_resolutions_list calls client.resolutions.list with no args and returns the raw response', async () => {
    const apiResponse = [
      { id: 10, name: 'Valid' },
      { id: 20, name: 'False Positive' },
    ];
    mockClient.resolutions.list.mockResolvedValue(apiResponse);

    const result = await resolutionsHandler.handleCall('blumira_resolutions_list', {});

    expect(mockClient.resolutions.list).toHaveBeenCalledWith();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await resolutionsHandler.handleCall('blumira_resolutions_bogus', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
