import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockLoadActiveRepos } = vi.hoisted(() => ({
  mockLoadActiveRepos: vi.fn(),
}));

vi.mock('../agents/plannerAgent.js', () => ({
  loadActiveRepos: mockLoadActiveRepos,
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

const ACTIVE_REPOS = [
  { id: 'demo-server', side: 'server', active: true, url: '', default_branch: 'main', description: 'Demo server' },
  { id: 'demo-client', side: 'client', active: true, url: '', default_branch: 'main', description: 'Demo client' },
];

let app: FastifyInstance;

beforeEach(async () => {
  mockLoadActiveRepos.mockReturnValue(ACTIVE_REPOS);
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('POST /features', () => {
  it('creates a feature and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'User Login', requirement: 'Allow users to log in with email', repos: ['demo-server'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['name']).toBe('User Login');
    expect(body['slug']).toBe('user-login');
    expect(body['status']).toBe('DRAFTING_SPEC');
    expect(body['id']).toBeTruthy();
  });

  it('derives slug from name (special chars stripped)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'My Feature! (v2)', requirement: 'req', repos: ['demo-server'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Record<string, unknown>>()['slug']).toBe('my-feature-v2');
  });

  it('returns 409 on duplicate slug', async () => {
    await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Duplicate', requirement: 'req', repos: ['demo-server'] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Duplicate', requirement: 'req 2', repos: ['demo-server'] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { requirement: 'req' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /features', () => {
  it('returns an empty array initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/features' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns all created features', async () => {
    await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Feature A', requirement: 'req', repos: ['demo-server'] },
    });
    await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Feature B', requirement: 'req', repos: ['demo-client'] },
    });
    const res = await app.inject({ method: 'GET', url: '/features' });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>()).toHaveLength(2);
  });
});

describe('POST /features — repos field', () => {
  it('returns 400 when repos is omitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'No Repos Feature', requirement: 'req' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when repos is an empty array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Empty Repos', requirement: 'req', repos: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 with a message naming the invalid id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Bad Repo', requirement: 'req', repos: ['nonexistent-xyz'] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toContain('nonexistent-xyz');
  });

  it('returns 400 for an inactive repo id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Inactive Repo', requirement: 'req', repos: ['bff'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 201 and includes repos in the response body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Valid Repos', requirement: 'req', repos: ['demo-server'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['repos']).toEqual(['demo-server']);
  });
});

describe('GET /features/:id', () => {
  it('returns the feature by id', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/features',
      payload: { name: 'Find Me', requirement: 'req', repos: ['demo-server'] },
    });
    const { id } = created.json<{ id: string }>();
    const res = await app.inject({ method: 'GET', url: `/features/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()['id']).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/features/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()['error']).toBeTruthy();
  });
});
