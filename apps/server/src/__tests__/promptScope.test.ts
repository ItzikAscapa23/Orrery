import { describe, it, expect, vi } from 'vitest';
import yaml from 'js-yaml';
import { scopeSpecByRefs, scopeContract } from '../lib/promptScope.js';

// Agent modules import anthropic.js at module load — mock it before importing agents.
process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';
vi.mock('../lib/anthropic.js', () => ({ createMessageStream: vi.fn() }));

import { measurePromptSections as measureDevSections } from '../agents/devAgent.js';
import { measurePromptSections as measureTestSections } from '../agents/testAgent.js';

const SAMPLE_SPEC = `This is the preamble.

## API endpoints

GET /users returns a list of users.
POST /users creates a new user.

## Authentication

JWT-based auth required for all endpoints.

## Screens

The login screen shows a form.

## Error handling

Standard error responses with status codes.
`;

// 4-path contract fixture used across filtering tests
const SAMPLE_CONTRACT = `openapi: "3.0.0"
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: ok
  /posts:
    get:
      operationId: listPosts
      responses:
        "200":
          description: ok
  /comments:
    get:
      operationId: listComments
      responses:
        "200":
          description: ok
  /tags:
    get:
      operationId: listTags
      responses:
        "200":
          description: ok`;

describe('scopeSpecByRefs', () => {
  it('returns full spec unchanged when refs is empty', () => {
    expect(scopeSpecByRefs(SAMPLE_SPEC, [])).toBe(SAMPLE_SPEC);
  });

  it('returns preamble + matching section when one ref matches', () => {
    const result = scopeSpecByRefs(SAMPLE_SPEC, ['API endpoints']);
    expect(result).toContain('This is the preamble.');
    expect(result).toContain('## API endpoints');
    expect(result).toContain('GET /users');
    expect(result).not.toContain('## Authentication');
    expect(result).not.toContain('## Screens');
    expect(result).not.toContain('## Error handling');
  });

  it('returns full spec when no refs match (nothing to filter)', () => {
    const result = scopeSpecByRefs(SAMPLE_SPEC, ['Nonexistent section']);
    expect(result).toBe(SAMPLE_SPEC);
  });

  it('returns full spec when matched sections exceed 75% of total', () => {
    // 4 sections in SAMPLE_SPEC; matching 4 of 4 = 100% > 75% → return full
    const result = scopeSpecByRefs(SAMPLE_SPEC, [
      'API endpoints',
      'Authentication',
      'Screens',
      'Error handling',
    ]);
    expect(result).toBe(SAMPLE_SPEC);
  });

  it('case-insensitive heading match', () => {
    const result = scopeSpecByRefs(SAMPLE_SPEC, ['api endpoints']);
    expect(result).toContain('## API endpoints');
    expect(result).not.toContain('## Authentication');
  });
});

describe('scopeContract — passthrough', () => {
  it('returns the contract unchanged for server side when no refs given', () => {
    const contractYaml = 'openapi: 3.0.0\npaths:\n  /users:\n    get: {}\n';
    expect(scopeContract(contractYaml, { side: 'server' })).toBe(contractYaml);
  });

  it('returns the contract unchanged for client side when no refs given', () => {
    const contractYaml = 'openapi: 3.0.0\npaths:\n  /users:\n    get: {}\n';
    expect(scopeContract(contractYaml, { side: 'client' })).toBe(contractYaml);
  });
});

describe('scopeContract — filtering', () => {
  it('contract filtered to referenced operations; all $refs resolve', () => {
    // 4 paths; match only /users (75% removed ≥ 25% threshold → filtering proceeds)
    const result = scopeContract(SAMPLE_CONTRACT, {
      side: 'server',
      refs: ['users'],
      taskDescription: 'implement user listing',
    });
    const parsed = yaml.load(result) as { paths: Record<string, unknown> };
    expect(Object.keys(parsed.paths)).toContain('/users');
    expect(Object.keys(parsed.paths)).not.toContain('/posts');
    expect(Object.keys(parsed.paths)).not.toContain('/comments');
    expect(Object.keys(parsed.paths)).not.toContain('/tags');
    // No dangling $refs — none present in the fixture, so this passes if we get here
  });

  it('<25% removable → whole document returned', () => {
    // 5 paths where refs match 4 of them (1/5 = 20% removed < 25%) → full doc returned.
    // Use refs that token-match /users, /posts, /comments, /tags but NOT /admin.
    // removedFraction = 1/5 = 0.2, which is < 0.25 → guard fires → full doc.
    const fivePathContract =
      SAMPLE_CONTRACT +
      `\n  /admin:\n    get:\n      operationId: adminGet\n      responses:\n        "200":\n          description: ok`;
    const result = scopeContract(fivePathContract, {
      side: 'server',
      refs: ['users', 'posts', 'comments', 'tags'],
    });
    const parsed = yaml.load(result) as { paths: Record<string, unknown> };
    expect(Object.keys(parsed.paths)).toHaveLength(5);
  });

  it('unresolvable $ref → whole document + onFallback called', () => {
    const contractWithDanglingRef = `openapi: "3.0.0"
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UserList'
  /posts:
    get:
      operationId: listPosts
      responses:
        "200":
          description: ok
  /comments:
    get:
      operationId: listComments
      responses:
        "200":
          description: ok
  /tags:
    get:
      operationId: listTags
      responses:
        "200":
          description: ok`;
    // components.schemas.UserList referenced but not present → dangling $ref after filtering
    const fallbackReasons: string[] = [];
    const result = scopeContract(contractWithDanglingRef, {
      side: 'server',
      refs: ['users'],
      onFallback: (reason) => fallbackReasons.push(reason),
    });
    expect(result).toBe(contractWithDanglingRef);
    expect(fallbackReasons).toHaveLength(1);
    expect(fallbackReasons[0]).toContain('dangling $ref');
  });
});

describe('measurePromptSections — devAgent', () => {
  it('returns per-section char counts summing to total', () => {
    const task = {
      id: 't1',
      title: 'Add endpoint',
      description: 'GET /users returns users',
      specRefs: ['API endpoints'],
    };
    const ctx = {
      specMarkdown: 'spec text here',
      contractYaml: 'openapi: 3.0.0',
      repoClaudeMd: '# Repo CLAUDE.md',
    };
    const sections = measureDevSections(task, ctx);
    expect(sections.claudeMd).toBe(ctx.repoClaudeMd.length);
    expect(sections.contract).toBe(ctx.contractYaml.length);
    expect(sections.spec).toBe(ctx.specMarkdown.length);
    expect(sections.task).toBeGreaterThan(0);
    expect(sections.rules).toBeGreaterThan(0);
    expect(sections.total).toBe(
      sections.claudeMd + sections.contract + sections.spec + sections.task + sections.rules,
    );
  });
});

describe('measurePromptSections — testAgent', () => {
  it('returns per-section char counts summing to total', () => {
    const ctx = {
      specMarkdown: 'spec text here',
      contractYaml: 'openapi: 3.0.0',
      repoClaudeMd: '# Repo CLAUDE.md',
      testDir: '__tests__',
    };
    const sections = measureTestSections(ctx);
    expect(sections.claudeMd).toBe(ctx.repoClaudeMd.length);
    expect(sections.contract).toBe(ctx.contractYaml.length);
    expect(sections.spec).toBe(ctx.specMarkdown.length);
    expect(sections.rules).toBeGreaterThan(0);
    expect(sections.total).toBe(
      sections.claudeMd + sections.contract + sections.spec + sections.rules,
    );
  });
});
