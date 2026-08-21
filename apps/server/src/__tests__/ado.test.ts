import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAdoPullRequest, parseAdoRepoUrl } from '../lib/ado.js';

const BASE_INPUT = {
  orgUrl: 'https://dev.azure.com/myorg',
  project: 'my-project',
  repoId: 'demo-server',
  pat: 'test-pat',
  title: 'feat: test',
  description: 'body',
  sourceBranch: 'refs/heads/feature/test',
  targetBranch: 'refs/heads/main',
};

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(String(body)),
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createAdoPullRequest — URL preference', () => {
  it('uses _links.web.href as prUrl when present', async () => {
    mockFetch({
      pullRequestId: 42,
      _links: {
        web: {
          href: 'https://dev.azure.com/myorg/my-project/_git/demo-server/pullrequest/42',
        },
      },
      url: 'https://dev.azure.com/myorg/my-project/_apis/git/repositories/guid-1234/pullRequests/42',
    });
    const { prUrl } = await createAdoPullRequest(BASE_INPUT);
    expect(prUrl).toBe('https://dev.azure.com/myorg/my-project/_git/demo-server/pullrequest/42');
    expect(prUrl).not.toContain('_apis');
  });

  it('falls back to constructed _git URL when _links.web.href is absent', async () => {
    mockFetch({ pullRequestId: 99 });
    const { prUrl } = await createAdoPullRequest(BASE_INPUT);
    expect(prUrl).toBe('https://dev.azure.com/myorg/my-project/_git/demo-server/pullrequest/99');
    expect(prUrl).not.toContain('_apis');
  });

  it('never uses the REST API url field', async () => {
    mockFetch({
      pullRequestId: 7,
      url: 'https://dev.azure.com/myorg/my-project/_apis/git/repositories/guid/pullRequests/7',
    });
    const { prUrl } = await createAdoPullRequest(BASE_INPUT);
    // _links absent, data.url present — must use constructed _git URL, not data.url
    expect(prUrl).toBe('https://dev.azure.com/myorg/my-project/_git/demo-server/pullrequest/7');
    expect(prUrl).not.toContain('_apis');
  });

  it('returns prId from pullRequestId', async () => {
    mockFetch({ pullRequestId: 55 });
    const { prId } = await createAdoPullRequest(BASE_INPUT);
    expect(prId).toBe(55);
  });

  it('throws on non-2xx response', async () => {
    mockFetch('Unauthorized', 401);
    await expect(createAdoPullRequest(BASE_INPUT)).rejects.toThrow('HTTP 401');
  });
});

describe('parseAdoRepoUrl', () => {
  it('parses visualstudio.com URL', () => {
    const r = parseAdoRepoUrl('https://dev.azure.com/myorg/my-project/_git/demo-server');
    expect(r).toEqual({
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'my-project',
      repoId: 'demo-server',
    });
  });

  it('parses dev.azure.com URL', () => {
    const r = parseAdoRepoUrl('https://dev.azure.com/myorg/my-project/_git/my-repo');
    expect(r).toEqual({
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'my-project',
      repoId: 'my-repo',
    });
  });

  it('throws on unrecognised URL format', () => {
    expect(() => parseAdoRepoUrl('https://github.com/foo/bar')).toThrow(
      'Cannot parse ADO repo URL',
    );
  });
});
