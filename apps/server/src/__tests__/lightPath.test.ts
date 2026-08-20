/**
 * 14b: Light path tests.
 *
 * Tests:
 *  1. Selecting only light repos → featurePath=LIGHT
 *  2. Selecting a light + a full repo → featurePath=FULL
 *  7. Malformed YAML fails syntax probe and is not committed (pure unit test)
 *  8. Valid YAML passes and is committed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitStepError } from '../jobs/devJob.js';
import { probeSyntax } from '../jobs/lightDevJob.js';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

// ── Feature path derivation (via POST /features) ──────────────────────────────

const { mockLoadActiveRepos } = vi.hoisted(() => ({
  mockLoadActiveRepos: vi.fn(),
}));

vi.mock('../agents/plannerAgent.js', () => ({
  loadActiveRepos: mockLoadActiveRepos,
}));

import { getPrisma, disconnectPrisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

const FULL_REPO = {
  id: 'demo-server',
  side: 'server',
  active: true,
  path: 'full',
  url: '',
  default_branch: 'main',
  description: 'Demo server',
};
const LIGHT_REPO_SWAGGERS = {
  id: 'swaggers',
  side: 'server',
  active: true, // pretend active for test purposes
  path: 'light',
  url: '',
  default_branch: 'main',
  description: 'Swagger YMLs',
};
const LIGHT_REPO_BFF_CFG = {
  id: 'bff-configurations',
  side: 'server',
  active: true,
  path: 'light',
  url: '',
  default_branch: 'main',
  description: 'BFF env configs',
};

let app: FastifyInstance;

beforeEach(async () => {
  mockLoadActiveRepos.mockReturnValue([FULL_REPO, LIGHT_REPO_SWAGGERS, LIGHT_REPO_BFF_CFG]);
  await getPrisma().$executeRaw`TRUNCATE features CASCADE`;
  app = await createApp();
});

afterEach(async () => {
  await app.close();
  await disconnectPrisma();
});

describe('feature path derivation', () => {
  it('derives LIGHT when all selected repos are light', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: {
        name: 'Add swagger endpoint',
        requirement: 'Add GET /users to swaggers',
        repos: ['swaggers'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body['feature_path']).toBe('LIGHT');
  });

  it('derives LIGHT when multiple light repos selected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: {
        name: 'Config update',
        requirement: 'Update env + swagger',
        repos: ['swaggers', 'bff-configurations'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Record<string, unknown>>()['feature_path']).toBe('LIGHT');
  });

  it('derives FULL when any selected repo is full', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: {
        name: 'Full feature with swagger',
        requirement: 'Add endpoint and swagger',
        repos: ['demo-server', 'swaggers'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Record<string, unknown>>()['feature_path']).toBe('FULL');
  });

  it('derives FULL when only full repos selected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/features',
      payload: {
        name: 'Server feature',
        requirement: 'req',
        repos: ['demo-server'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Record<string, unknown>>()['feature_path']).toBe('FULL');
  });
});

// ── Syntax probe unit tests (pure, no DB) ────────────────────────────────────

describe('probeSyntax', () => {
  it('accepts valid YAML', () => {
    expect(
      probeSyntax('api.yaml', 'openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0"'),
    ).toBe('yaml');
    expect(probeSyntax('contract.yml', 'key: value')).toBe('yaml');
  });

  it('throws CommitStepError for malformed YAML', () => {
    expect(() => probeSyntax('api.yaml', 'key: [unclosed')).toThrow(CommitStepError);
    expect(() => probeSyntax('api.yaml', 'key: [unclosed')).toThrow('YAML syntax error');
  });

  it('accepts valid .env KEY=value content', () => {
    const envContent = '# comment\nFOO=bar\nBAZ=123\n\nQUX=hello world';
    expect(probeSyntax('.env', envContent)).toBe('env-kv');
    expect(probeSyntax('.env.sandbox', envContent)).toBe('env-kv');
  });

  it('throws CommitStepError for malformed .env content', () => {
    expect(() => probeSyntax('.env', 'FOO=bar\n123INVALID=oops')).toThrow(CommitStepError);
    expect(() => probeSyntax('.env', 'FOO=bar\n123INVALID=oops')).toThrow('Invalid .env format');
  });

  it('returns none for unrecognised file types', () => {
    expect(probeSyntax('README.md', '# hello')).toBe('none');
    expect(probeSyntax('schema.json', '{}')).toBe('none');
    expect(probeSyntax('config.ts', 'export default {}')).toBe('none');
  });

  it('skips probe for blank lines and comments in .env', () => {
    const content = '# This is a comment\n\nDB_HOST=localhost\nDB_PORT=5432';
    expect(() => probeSyntax('.env', content)).not.toThrow();
  });

  it('accepts valid JSON object in a .env file and returns env-json', () => {
    const jsonObject = '{\n  "DB_HOST": "localhost",\n  "DB_PORT": 5432\n}';
    expect(probeSyntax('.env', jsonObject)).toBe('env-json');
    expect(probeSyntax('.env.production', jsonObject)).toBe('env-json');
  });

  it('accepts valid JSON array in a .env file and returns env-json', () => {
    expect(probeSyntax('.env', '[{"key": "value"}]')).toBe('env-json');
  });

  it('throws CommitStepError for malformed JSON in a .env file', () => {
    expect(() => probeSyntax('.env', '{ "broken": ')).toThrow(CommitStepError);
    expect(() => probeSyntax('.env', '{ "broken": ')).toThrow('Invalid JSON');
  });
});
