import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  users: {
    list: vi.fn(),
  },
};

vi.mock('../utils/client.js', () => ({
  getClient: vi.fn(async () => mockClient),
}));

import { usersHandler } from '../domains/users.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usersHandler.getTools', () => {
  it('exposes the users_list tool', () => {
    const names = usersHandler.getTools().map((t) => t.name);
    expect(names).toEqual(['blumira_users_list']);
  });
});

describe('usersHandler.handleCall', () => {
  it('blumira_users_list forwards paging args and returns the raw response', async () => {
    const apiResponse = { data: [{ id: 'u-1', email: 'a@example.com', role: 'admin' }] };
    mockClient.users.list.mockResolvedValue(apiResponse);

    const args = { page: 1, page_size: 50 };
    const result = await usersHandler.handleCall('blumira_users_list', args);

    expect(mockClient.users.list).toHaveBeenCalledWith(args);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(JSON.stringify(apiResponse, null, 2));
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await usersHandler.handleCall('blumira_users_bogus', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
