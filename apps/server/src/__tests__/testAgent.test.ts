import os from 'node:os';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  checkReadAllowed,
  checkWriteAllowed,
  checkListFilesTarget,
  checkTestBashAllowed,
  TestAllowlistViolationError,
  TestMetacharViolationError,
  buildSystemPrompt,
} from '../agents/testAgent.js';

process.env['ANTHROPIC_API_KEY'] = 'test-key';
process.env['ARTIFACTS_REPO_PATH'] = '/tmp/test-artifacts';

const { mockCreateMessageStream } = vi.hoisted(() => ({
  mockCreateMessageStream: vi.fn(),
}));

vi.mock('../lib/anthropic.js', () => ({
  createMessageStream: mockCreateMessageStream,
  // Pure passthrough — agent tests do not assert on the cache marker.
  withLastMessageCached: (messages: unknown) => messages,
}));

import { runTestAgent } from '../agents/testAgent.js';
import { SHELL_METACHAR_RE } from '../lib/container.js';
import type { ContainerHandle } from '../lib/container.js';
import type Anthropic from '@anthropic-ai/sdk';

const ROOT = '/worktree/root';
const TEST_DIR = '__tests__';

describe('checkReadAllowed — path jail', () => {
  it('allows spec.md at root', () => {
    expect(() => checkReadAllowed(ROOT, 'spec.md', TEST_DIR)).not.toThrow();
  });

  it('allows contract.yaml at root', () => {
    expect(() => checkReadAllowed(ROOT, 'contract.yaml', TEST_DIR)).not.toThrow();
  });

  it('allows CLAUDE.md at root', () => {
    expect(() => checkReadAllowed(ROOT, 'CLAUDE.md', TEST_DIR)).not.toThrow();
  });

  it('allows package.json at root', () => {
    expect(() => checkReadAllowed(ROOT, 'package.json', TEST_DIR)).not.toThrow();
  });

  it('allows tsconfig.json at root', () => {
    expect(() => checkReadAllowed(ROOT, 'tsconfig.json', TEST_DIR)).not.toThrow();
  });

  it('allows files inside the test directory', () => {
    expect(() => checkReadAllowed(ROOT, '__tests__/feature.test.ts', TEST_DIR)).not.toThrow();
    expect(() => checkReadAllowed(ROOT, '__tests__/sub/helper.ts', TEST_DIR)).not.toThrow();
  });

  it('blocks src/ (implementation directory)', () => {
    expect(() => checkReadAllowed(ROOT, 'src/index.ts', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });

  it('blocks lib/ (implementation directory)', () => {
    expect(() => checkReadAllowed(ROOT, 'lib/utils.ts', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });

  it('blocks app/ (implementation directory)', () => {
    expect(() => checkReadAllowed(ROOT, 'app/main.ts', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });

  it('blocks dist/ (build output)', () => {
    expect(() => checkReadAllowed(ROOT, 'dist/index.js', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });

  it('blocks nested paths inside src/', () => {
    expect(() => checkReadAllowed(ROOT, 'src/routes/health.ts', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });

  it('blocks unknown root-level files not on whitelist', () => {
    expect(() => checkReadAllowed(ROOT, 'README.md', TEST_DIR)).toThrow(
      /not on the Test Agent read whitelist/,
    );
  });

  it('blocks absolute paths', () => {
    expect(() => checkReadAllowed(ROOT, '/etc/passwd', TEST_DIR)).toThrow(/absolute/);
  });

  it('blocks traversal escapes', () => {
    expect(() => checkReadAllowed(ROOT, '../../etc/passwd', TEST_DIR)).toThrow(/escapes/);
  });

  it('returns the absolute path on success', () => {
    const result = checkReadAllowed(ROOT, 'spec.md', TEST_DIR);
    expect(result).toBe(`${ROOT}/spec.md`);
  });

  // ── New cases ────────────────────────────────────────────────────────────────

  it('blocks sibling directory "test-fixtures" (not in whitelist, not an impl dir)', () => {
    expect(() => checkReadAllowed(ROOT, 'test-fixtures/data.json', TEST_DIR)).toThrow(
      /not on the Test Agent read whitelist/,
    );
  });

  it('blocks "Src/service.ts" — case-folded blocklist catches uppercase variants', () => {
    expect(() => checkReadAllowed(ROOT, 'Src/service.ts', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });

  it('blocks "build/" — implementation directory', () => {
    expect(() => checkReadAllowed(ROOT, 'build/index.js', TEST_DIR)).toThrow(
      /implementation directory/,
    );
  });
});

describe('checkWriteAllowed — test directory jail', () => {
  it('allows writing inside the test directory', () => {
    expect(() => checkWriteAllowed(ROOT, '__tests__/acceptance.test.ts', TEST_DIR)).not.toThrow();
    expect(() => checkWriteAllowed(ROOT, '__tests__/sub/helper.test.ts', TEST_DIR)).not.toThrow();
  });

  it('blocks writing to src/', () => {
    expect(() => checkWriteAllowed(ROOT, 'src/index.ts', TEST_DIR)).toThrow(
      /outside the test directory/,
    );
  });

  it('blocks writing to root-level files', () => {
    expect(() => checkWriteAllowed(ROOT, 'package.json', TEST_DIR)).toThrow(
      /outside the test directory/,
    );
  });

  it('blocks absolute paths', () => {
    expect(() => checkWriteAllowed(ROOT, '/tmp/evil.ts', TEST_DIR)).toThrow(/absolute/);
  });

  it('returns the absolute path on success', () => {
    const result = checkWriteAllowed(ROOT, '__tests__/foo.test.ts', TEST_DIR);
    expect(result).toBe(`${ROOT}/__tests__/foo.test.ts`);
  });

  // ── New cases ────────────────────────────────────────────────────────────────

  it('blocks "test/../src/service.ts" — traversal resolves outside test directory', () => {
    // path.resolve collapses '..' so this becomes 'src/service.ts' which is outside __tests__
    expect(() => checkWriteAllowed(ROOT, '__tests__/../src/service.ts', TEST_DIR)).toThrow(
      /outside the test directory/,
    );
  });

  it('allows writing __orrery_harness_brief.md at the repo root', () => {
    const result = checkWriteAllowed(ROOT, '__orrery_harness_brief.md', TEST_DIR);
    expect(result).toBe(`${ROOT}/__orrery_harness_brief.md`);
  });

  it('rejects __orrery_harness_brief.md written inside the test directory', () => {
    expect(() =>
      checkWriteAllowed(ROOT, `${TEST_DIR}/__orrery_harness_brief.md`, TEST_DIR),
    ).toThrow(/must be written at the repository root/);
  });
});

describe('checkTestBashAllowed — test-agent bash enforcement', () => {
  it('accepts "npm test"', () => {
    expect(() => checkTestBashAllowed('npm test')).not.toThrow();
  });

  it('accepts "npm run test"', () => {
    expect(() => checkTestBashAllowed('npm run test')).not.toThrow();
  });

  it('accepts "npx vitest run"', () => {
    expect(() => checkTestBashAllowed('npx vitest run')).not.toThrow();
  });

  it('accepts "npx jest --ci"', () => {
    expect(() => checkTestBashAllowed('npx jest --ci')).not.toThrow();
  });

  it('rejects "cat src/service.ts" — not on test-agent allowlist', () => {
    expect(() => checkTestBashAllowed('cat src/service.ts')).toThrow(TestAllowlistViolationError);
  });

  it('rejects "npm test; cat src/service.ts" — semicolon metacharacter', () => {
    expect(() => checkTestBashAllowed('npm test; cat src/service.ts')).toThrow(
      TestMetacharViolationError,
    );
  });

  it('rejects "ls __tests__" — not on test-agent allowlist', () => {
    expect(() => checkTestBashAllowed('ls __tests__')).toThrow(TestAllowlistViolationError);
  });

  it('rejects "find . -name *.test.ts" — not on test-agent allowlist', () => {
    expect(() => checkTestBashAllowed('find . -name *.test.ts')).toThrow(
      TestAllowlistViolationError,
    );
  });

  it('rejects "grep foo src/" — not on test-agent allowlist', () => {
    expect(() => checkTestBashAllowed('grep foo src/')).toThrow(TestAllowlistViolationError);
  });

  it('rejects non-exempt pipe metacharacter', () => {
    expect(() => checkTestBashAllowed('npm test | grep error')).toThrow(TestMetacharViolationError);
  });

  it('allows trailing | head -N (output-shaping exemption, same as dev agent)', () => {
    expect(() => checkTestBashAllowed('npm test | head -20')).not.toThrow();
  });

  it('accepts "npx jest --ci ... 2>&1" — 2>&1 must not trigger metachar', () => {
    expect(() =>
      checkTestBashAllowed('npx jest --ci --testPathPattern="cardAction/foo" 2>&1'),
    ).not.toThrow();
  });

  it('rejects "npx jest | grep foo" — bare pipe is still a metachar', () => {
    expect(() => checkTestBashAllowed('npx jest | grep foo')).toThrow(TestMetacharViolationError);
  });
});

describe('SHELL_METACHAR_RE — single canonical definition', () => {
  it('is exported from container.ts as the sole definition', () => {
    expect(SHELL_METACHAR_RE).toBeInstanceOf(RegExp);
    expect(SHELL_METACHAR_RE.test('a;b')).toBe(true);
    expect(SHELL_METACHAR_RE.test('a|b')).toBe(true);
    expect(SHELL_METACHAR_RE.test('grep "a\\|b" file')).toBe(false);
  });
});

// ── Integration tests — real filesystem scratch worktree ──────────────────────

describe('path-jail integration — real filesystem scratch worktree', () => {
  // beforeAll/afterAll so the write in one test persists for the read + list tests.
  let root: string;
  const TEST_SUBDIR = '__tests__';

  beforeAll(() => {
    root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testjail-'));
    nodeFs.mkdirSync(nodePath.join(root, TEST_SUBDIR), { recursive: true });
  });

  afterAll(() => {
    nodeFs.rmSync(root, { recursive: true, force: true });
  });

  it('write_file: writing a new test file inside testDir succeeds', () => {
    const result = checkWriteAllowed(root, `${TEST_SUBDIR}/acceptance.test.ts`, TEST_SUBDIR);
    nodeFs.writeFileSync(result, '// acceptance test\n', 'utf-8');
    expect(nodeFs.existsSync(result)).toBe(true);
  });

  it('read_file: reading the file just written succeeds', () => {
    const result = checkReadAllowed(root, `${TEST_SUBDIR}/acceptance.test.ts`, TEST_SUBDIR);
    expect(nodeFs.readFileSync(result, 'utf-8')).toContain('// acceptance test');
  });

  it('write_file: overwriting the same file a second time succeeds', () => {
    const result = checkWriteAllowed(root, `${TEST_SUBDIR}/acceptance.test.ts`, TEST_SUBDIR);
    nodeFs.writeFileSync(result, '// updated\n', 'utf-8');
    expect(nodeFs.readFileSync(result, 'utf-8')).toContain('// updated');
  });

  it('list_files: passing spec.md (not a directory) throws', () => {
    nodeFs.writeFileSync(nodePath.join(root, 'spec.md'), '# spec\n', 'utf-8');
    expect(() => checkListFilesTarget(root, 'spec.md', TEST_SUBDIR)).toThrow(
      /not an existing directory/,
    );
  });

  it('list_files: passing "." (worktree root) throws — not inside test directory', () => {
    expect(() => checkListFilesTarget(root, '.', TEST_SUBDIR)).toThrow();
  });

  it('list_files: passing testDir returns names of files written', () => {
    const names = checkListFilesTarget(root, TEST_SUBDIR, TEST_SUBDIR);
    expect(names.split('\n')).toContain('acceptance.test.ts');
  });
});

// ── testAgent read_file range ─────────────────────────────────────────────────

describe('testAgent — read_file range', () => {
  let tmpRoot: string;
  const TEST_SUBDIR = '__tests__';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-range-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot, TEST_SUBDIR), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeContainer(): ContainerHandle {
    return {
      name: 'test-container',
      exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };
  }

  function makeCtx() {
    return {
      featureId: 'feat-1',
      specMarkdown: '# spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR,
    };
  }

  function makeStreamMock(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function endTurnMessage(): Anthropic.Message {
    return {
      id: 'end',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as Anthropic.Message;
  }

  async function captureReadFileResult(input: Record<string, unknown>): Promise<string> {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1) {
        return Promise.resolve(
          makeStreamMock({
            id: 'rf',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
            content: [{ type: 'tool_use', id: 'tu_rf', name: 'read_file', input }],
          } as unknown as Anthropic.Message),
        );
      }
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });
    await runTestAgent('feat-1', makeCtx(), makeContainer(), tmpRoot);
    const second = calls[1]!.messages;
    const last = second[second.length - 1];
    const content = last?.content as Anthropic.ToolResultBlockParam[];
    const block = content.find((b) => b.type === 'tool_result');
    return JSON.stringify(block?.content ?? '');
  }

  it('returns slice with 1-based line number prefixes from a file inside testDir', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `testline${i + 1}`);
    nodeFs.writeFileSync(
      nodePath.join(tmpRoot, TEST_SUBDIR, 'foo.test.ts'),
      lines.join('\n'),
      'utf-8',
    );
    const result = await captureReadFileResult({
      path: `${TEST_SUBDIR}/foo.test.ts`,
      start_line: 2,
      end_line: 4,
    });
    expect(result).toContain('2\\ttestline2');
    expect(result).toContain('3\\ttestline3');
    expect(result).toContain('4\\ttestline4');
    expect(result).not.toContain('testline1');
    expect(result).not.toContain('testline5');
  });

  it('start_line past EOF returns error with line count', async () => {
    const lines = ['x', 'y', 'z'];
    nodeFs.writeFileSync(
      nodePath.join(tmpRoot, TEST_SUBDIR, 'tiny.test.ts'),
      lines.join('\n'),
      'utf-8',
    );
    const result = await captureReadFileResult({
      path: `${TEST_SUBDIR}/tiny.test.ts`,
      start_line: 99,
    });
    expect(result).toContain('file has 3 lines');
  });
});

// ── testAgent read_file truncation ────────────────────────────────────────────

describe('testAgent — read_file truncation', () => {
  let tmpRoot2: string;
  const TEST_SUBDIR2 = '__tests__';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot2 = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-trunc2-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot2, TEST_SUBDIR2), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot2, { recursive: true, force: true });
  });

  function makeContainer2(): ContainerHandle {
    return {
      name: 'test-container',
      exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };
  }

  function makeCtx2() {
    return {
      featureId: 'feat-1',
      specMarkdown: '# spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR2,
    };
  }

  function makeStreamMock2(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function endTurnMessage2(): Anthropic.Message {
    return {
      id: 'end',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as Anthropic.Message;
  }

  async function captureFullRead(content: string, filename = 'target.test.ts'): Promise<string> {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1) {
        return Promise.resolve(
          makeStreamMock2({
            id: 'rf',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
            content: [
              {
                type: 'tool_use',
                id: 'tu_rf',
                name: 'read_file',
                input: { path: `${TEST_SUBDIR2}/${filename}` },
              },
            ],
          } as unknown as Anthropic.Message),
        );
      }
      return Promise.resolve(makeStreamMock2(endTurnMessage2()));
    });
    nodeFs.writeFileSync(nodePath.join(tmpRoot2, TEST_SUBDIR2, filename), content, 'utf-8');
    await runTestAgent('feat-1', makeCtx2(), makeContainer2(), tmpRoot2);
    const second = calls[1]!.messages;
    const last = second[second.length - 1];
    const block = (last?.content as Anthropic.ToolResultBlockParam[]).find(
      (b) => b.type === 'tool_result',
    );
    return JSON.stringify(block?.content ?? '');
  }

  it('file under the limit is returned whole with no truncation marker', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const result = await captureFullRead(lines.join('\n'));
    expect(result).toContain('line10');
    expect(result).not.toContain('showing first');
  });

  it('file over the limit keeps the beginning and includes a truncation marker', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
    const result = await captureFullRead(lines.join('\n'));
    expect(result).toContain('line1');
    expect(result).not.toContain('line600');
    expect(result).toContain('showing first');
  });

  it('truncation marker names the total line count and how to read the rest', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
    const result = await captureFullRead(lines.join('\n'));
    expect(result).toContain('600');
    expect(result).toContain('start_line');
  });

  it('full and ranged reads are formatted consistently (both have 1-based line numbers)', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `item${i + 1}`);
    const result = await captureFullRead(lines.join('\n'), 'nums.test.ts');
    expect(result).toContain('1\\titem1');
    expect(result).toContain('3\\titem3');
    expect(result).toContain('5\\titem5');
  });
});

// ── stop_reason: max_tokens recovery ─────────────────────────────────────────

describe('testAgent — stop_reason: max_tokens recovery', () => {
  let tmpRoot: string;
  const TEST_SUBDIR = '__tests__';

  const TRUNC_CTX = {
    featureId: 'feat-trunc',
    specMarkdown: '',
    contractYaml: '',
    repoClaudeMd: '',
    testDir: TEST_SUBDIR,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-trunc-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot, TEST_SUBDIR), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeStreamMock(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function endTurnMessage(): Anthropic.Message {
    return {
      id: 'end',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as Anthropic.Message;
  }

  function makeContainer(): ContainerHandle {
    return {
      name: 'test-container',
      exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };
  }

  function maxTokensMessage(): Anthropic.Message {
    return {
      id: 'trunc',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 16384 },
      content: [{ type: 'text', text: 'Partial respon' }],
    } as unknown as Anthropic.Message;
  }

  it('pops the partial assistant message so no stale entry persists after recovery', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      return Promise.resolve(
        makeStreamMock(calls.length === 1 ? maxTokensMessage() : endTurnMessage()),
      );
    });

    await runTestAgent('feat-trunc', TRUNC_CTX, makeContainer(), tmpRoot);

    // Turn 2's message list must not contain any assistant message from turn 1.
    const turn2Messages = calls[1]!.messages;
    const assistantFromTurn1 = turn2Messages.find(
      (m, i) => i > 0 && m.role === 'assistant' && m.content === maxTokensMessage().content,
    );
    expect(assistantFromTurn1).toBeUndefined();
  });

  it('injects a recovery user nudge containing "cut off"', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      return Promise.resolve(
        makeStreamMock(calls.length === 1 ? maxTokensMessage() : endTurnMessage()),
      );
    });

    await runTestAgent('feat-trunc', TRUNC_CTX, makeContainer(), tmpRoot);

    const turn2Messages = calls[1]!.messages;
    const recoveryMsg = turn2Messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('cut off'),
    );
    expect(recoveryMsg).toBeDefined();
  });

  it('continues the loop and returns completed after recovery', async () => {
    let callCount = 0;
    mockCreateMessageStream.mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        makeStreamMock(callCount === 1 ? maxTokensMessage() : endTurnMessage()),
      );
    });

    const outcome = await runTestAgent('feat-trunc', TRUNC_CTX, makeContainer(), tmpRoot);
    expect(outcome.kind).toBe('completed');
  });

  it('handles multiple consecutive truncations before end_turn', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      return Promise.resolve(
        makeStreamMock(calls.length < 3 ? maxTokensMessage() : endTurnMessage()),
      );
    });

    const outcome = await runTestAgent('feat-trunc', TRUNC_CTX, makeContainer(), tmpRoot);
    expect(outcome.kind).toBe('completed');

    // No stale assistant messages: calls.length < 3 means turns 1 & 2 truncate,
    // turn 3 (index 2) is end_turn. The message list at turn 3 must have no
    // assistant entries — all partial messages from prior truncations were popped.
    expect(calls.length).toBe(3);
    const finalMessages = calls[2]!.messages;
    const assistantMessages = finalMessages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBe(0);
  });
});

// ── onToolCall callback — testAgent ──────────────────────────────────────────

import type { ToolCallInfo } from '../agents/devAgent.js';

describe('testAgent — onToolCall callback', () => {
  let tmpRoot2: string;
  const TEST_SUBDIR = '__tests__';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot2 = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-toolcall-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot2, TEST_SUBDIR), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot2, { recursive: true, force: true });
  });

  function makeContainerLocal(): ContainerHandle {
    return {
      name: 'test-container',
      exec: () => Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };
  }

  function makeCtxLocal() {
    return {
      featureId: 'feat-tc',
      specMarkdown: '# spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR,
    };
  }

  function makeStreamMockLocal(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function endTurnMsg(): Anthropic.Message {
    return {
      id: 'end',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as Anthropic.Message;
  }

  function toolUseMsg(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Anthropic.Message {
    return {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'tool_use', id: `tu_${id}`, name: toolName, input }],
    } as unknown as Anthropic.Message;
  }

  it('bash: emits toolName, turn, command (≤120 chars), and resultSize', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMockLocal(toolUseMsg('b1', 'bash', { command: 'npm test' })))
      .mockResolvedValueOnce(makeStreamMockLocal(endTurnMsg()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-tc',
      makeCtxLocal(),
      makeContainerLocal(),
      tmpRoot2,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos).toHaveLength(1);
    expect(infos[0]!.toolName).toBe('bash');
    expect(infos[0]!.turn).toBe(1);
    expect(infos[0]!.command).toBe('npm test');
    expect(infos[0]!.resultSize).toBeGreaterThan(0);
  });

  it('read_file (full): emits path and range="full"', async () => {
    nodeFs.writeFileSync(
      nodePath.join(tmpRoot2, TEST_SUBDIR, 'feature.test.ts'),
      '// test\n',
      'utf-8',
    );

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMockLocal(
          toolUseMsg('rf1', 'read_file', { path: `${TEST_SUBDIR}/feature.test.ts` }),
        ),
      )
      .mockResolvedValueOnce(makeStreamMockLocal(endTurnMsg()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-tc',
      makeCtxLocal(),
      makeContainerLocal(),
      tmpRoot2,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos[0]!.toolName).toBe('read_file');
    expect(infos[0]!.path).toBe(`${TEST_SUBDIR}/feature.test.ts`);
    expect(infos[0]!.range).toBe('full');
  });

  it('read_file (range): emits range as "lines N–M"', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `tline${i + 1}`);
    nodeFs.writeFileSync(
      nodePath.join(tmpRoot2, TEST_SUBDIR, 'ranged.test.ts'),
      lines.join('\n'),
      'utf-8',
    );

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMockLocal(
          toolUseMsg('rf2', 'read_file', {
            path: `${TEST_SUBDIR}/ranged.test.ts`,
            start_line: 2,
            end_line: 5,
          }),
        ),
      )
      .mockResolvedValueOnce(makeStreamMockLocal(endTurnMsg()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-tc',
      makeCtxLocal(),
      makeContainerLocal(),
      tmpRoot2,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos[0]!.range).toBe('lines 2–5');
  });

  it('write_file: emits path and contentLength', async () => {
    const content = 'it("works", () => {});\n';

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMockLocal(
          toolUseMsg('wf1', 'write_file', { path: `${TEST_SUBDIR}/new.test.ts`, content }),
        ),
      )
      .mockResolvedValueOnce(makeStreamMockLocal(endTurnMsg()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-tc',
      makeCtxLocal(),
      makeContainerLocal(),
      tmpRoot2,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos[0]!.toolName).toBe('write_file');
    expect(infos[0]!.path).toBe(`${TEST_SUBDIR}/new.test.ts`);
    expect(infos[0]!.contentLength).toBe(content.length);
  });

  it('list_files: emits toolName and resultSize', async () => {
    nodeFs.writeFileSync(nodePath.join(tmpRoot2, TEST_SUBDIR, 'a.test.ts'), '// a\n', 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMockLocal(toolUseMsg('lf1', 'list_files', { dir: TEST_SUBDIR })),
      )
      .mockResolvedValueOnce(makeStreamMockLocal(endTurnMsg()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-tc',
      makeCtxLocal(),
      makeContainerLocal(),
      tmpRoot2,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos[0]!.toolName).toBe('list_files');
    expect(infos[0]!.resultSize).toBeGreaterThan(0);
  });

  it('fires after result — turn counter increments per API call', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMockLocal(toolUseMsg('b2', 'bash', { command: 'npm test' })))
      .mockResolvedValueOnce(makeStreamMockLocal(toolUseMsg('b3', 'bash', { command: 'npm test' })))
      .mockResolvedValueOnce(makeStreamMockLocal(endTurnMsg()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-tc',
      makeCtxLocal(),
      makeContainerLocal(),
      tmpRoot2,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos).toHaveLength(2);
    expect(infos[0]!.turn).toBe(1);
    expect(infos[1]!.turn).toBe(2);
  });
});

// ── orientationBlock in testAgent system prompt ───────────────────────────────

describe('testAgent — orientationBlock in system prompt', () => {
  let tmpRoot: string;
  const TEST_SUBDIR = '__tests__';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-orient-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot, TEST_SUBDIR), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function endTurnMsgO(): Anthropic.Message {
    return {
      id: 'end',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as Anthropic.Message;
  }

  function makeStreamO(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function makeContainerO(): ContainerHandle {
    return {
      name: 'test-container',
      exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };
  }

  it('orientation block appears in the single cached system block when provided', async () => {
    const calls: Array<{ system: unknown }> = [];
    mockCreateMessageStream.mockImplementation((params: { system: unknown }) => {
      calls.push({ system: params.system });
      return Promise.resolve(makeStreamO(endTurnMsgO()));
    });

    const ctx = {
      specMarkdown: '',
      contractYaml: '--- THE_CONTRACT ---',
      repoClaudeMd: '--- THE_CLAUDE_MD ---',
      testDir: TEST_SUBDIR,
      orientationBlock: '--- THE_ORIENTATION ---',
    };
    await runTestAgent('feat-orient', ctx, makeContainerO(), tmpRoot);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const systemArray = calls[0]!.system as Array<{
      type: string;
      text: string;
      cache_control?: unknown;
    }>;
    expect(systemArray).toHaveLength(1);
    const singleBlock = systemArray[0]!;
    expect(singleBlock.cache_control).toBeDefined();
    expect(singleBlock.text).toContain('--- THE_ORIENTATION ---');
    expect(singleBlock.text).toContain('--- THE_CONTRACT ---');
  });

  it('orientation block appears AFTER CLAUDE.md and BEFORE the contract in testAgent prompt', async () => {
    const calls: Array<{ system: unknown }> = [];
    mockCreateMessageStream.mockImplementation((params: { system: unknown }) => {
      calls.push({ system: params.system });
      return Promise.resolve(makeStreamO(endTurnMsgO()));
    });

    const ctx = {
      specMarkdown: '',
      contractYaml: '--- THE_CONTRACT ---',
      repoClaudeMd: '--- THE_CLAUDE_MD ---',
      testDir: TEST_SUBDIR,
      orientationBlock: '--- THE_ORIENTATION ---',
    };
    await runTestAgent('feat-orient2', ctx, makeContainerO(), tmpRoot);

    const systemArray = calls[0]!.system as Array<{ text: string }>;
    const text = systemArray[0]!.text;
    const claudePos = text.indexOf('--- THE_CLAUDE_MD ---');
    const orientPos = text.indexOf('--- THE_ORIENTATION ---');
    const contractPos = text.indexOf('--- THE_CONTRACT ---');
    expect(claudePos).toBeGreaterThanOrEqual(0);
    expect(orientPos).toBeGreaterThan(claudePos);
    expect(contractPos).toBeGreaterThan(orientPos);
  });

  it('testAgent system prompt absent of orientation when not provided', async () => {
    const calls: Array<{ system: unknown }> = [];
    mockCreateMessageStream.mockImplementation((params: { system: unknown }) => {
      calls.push({ system: params.system });
      return Promise.resolve(makeStreamO(endTurnMsgO()));
    });

    const ctx = {
      specMarkdown: '',
      contractYaml: '',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR,
    };
    await runTestAgent('feat-orient3', ctx, makeContainerO(), tmpRoot);

    const systemArray = calls[0]!.system as Array<{ text: string }>;
    expect(systemArray[0]!.text).not.toContain('## Repository orientation');
  });
});

// ── edit_file tool — testAgent ────────────────────────────────────────────────

describe('testAgent — edit_file tool', () => {
  let tmpRoot3: string;
  const TEST_SUBDIR = '__tests__';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot3 = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-edit-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot3, TEST_SUBDIR), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot3, { recursive: true, force: true });
  });

  function makeContainerEdit(): ContainerHandle {
    return {
      name: 'test-container',
      exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };
  }

  function makeCtxEdit() {
    return {
      featureId: 'feat-edit',
      specMarkdown: '# spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR,
    };
  }

  function makeStreamEdit(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function endTurnEdit(): Anthropic.Message {
    return {
      id: 'end',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as Anthropic.Message;
  }

  function toolUseMsgEdit(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Anthropic.Message {
    return {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'tool_use', id: `tu_${id}`, name: toolName, input }],
    } as unknown as Anthropic.Message;
  }

  it('unique match — changes only the matched text, tool_result confirms edit', async () => {
    const filePath = nodePath.join(tmpRoot3, TEST_SUBDIR, 'foo.test.ts');
    nodeFs.writeFileSync(filePath, 'const A = 1;\n', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamEdit(
            toolUseMsgEdit('ef1', 'edit_file', {
              path: `${TEST_SUBDIR}/foo.test.ts`,
              old_str: 'const A = 1;',
              new_str: 'const B = 2;',
            }),
          ),
        );
      return Promise.resolve(makeStreamEdit(endTurnEdit()));
    });

    await runTestAgent('feat-edit', makeCtxEdit(), makeContainerEdit(), tmpRoot3);

    const disk = nodeFs.readFileSync(filePath, 'utf-8');
    expect(disk).toContain('const B = 2;');
    expect(disk).not.toContain('const A = 1;');

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(toolResult?.content)).toContain(`Edited ${TEST_SUBDIR}/foo.test.ts`);
  });

  it('zero matches — is_error tool_result, file untouched', async () => {
    const filePath = nodePath.join(tmpRoot3, TEST_SUBDIR, 'zero.test.ts');
    nodeFs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamEdit(
            toolUseMsgEdit('ef2', 'edit_file', {
              path: `${TEST_SUBDIR}/zero.test.ts`,
              old_str: 'DOES_NOT_EXIST',
              new_str: 'replacement',
            }),
          ),
        );
      return Promise.resolve(makeStreamEdit(endTurnEdit()));
    });

    await runTestAgent('feat-edit', makeCtxEdit(), makeContainerEdit(), tmpRoot3);

    expect(nodeFs.readFileSync(filePath, 'utf-8')).toBe('const x = 1;\n');
    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(toolResult?.is_error).toBe(true);
    expect(JSON.stringify(toolResult?.content)).toContain('old_str not found in');
  });

  it('multiple matches — is_error naming the count, file untouched', async () => {
    const filePath = nodePath.join(tmpRoot3, TEST_SUBDIR, 'multi.test.ts');
    nodeFs.writeFileSync(filePath, 'foo\nfoo\n', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamEdit(
            toolUseMsgEdit('ef3', 'edit_file', {
              path: `${TEST_SUBDIR}/multi.test.ts`,
              old_str: 'foo',
              new_str: 'bar',
            }),
          ),
        );
      return Promise.resolve(makeStreamEdit(endTurnEdit()));
    });

    await runTestAgent('feat-edit', makeCtxEdit(), makeContainerEdit(), tmpRoot3);

    expect(nodeFs.readFileSync(filePath, 'utf-8')).toBe('foo\nfoo\n');
    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(toolResult?.is_error).toBe(true);
    expect(JSON.stringify(toolResult?.content)).toContain('matches 2 times');
  });

  it('empty new_str deletes the matched text', async () => {
    const filePath = nodePath.join(tmpRoot3, TEST_SUBDIR, 'del.test.ts');
    nodeFs.writeFileSync(filePath, 'keep\ndelete_me\nkeep\n', 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamEdit(
          toolUseMsgEdit('ef4', 'edit_file', {
            path: `${TEST_SUBDIR}/del.test.ts`,
            old_str: 'delete_me\n',
            new_str: '',
          }),
        ),
      )
      .mockResolvedValueOnce(makeStreamEdit(endTurnEdit()));

    await runTestAgent('feat-edit', makeCtxEdit(), makeContainerEdit(), tmpRoot3);

    expect(nodeFs.readFileSync(filePath, 'utf-8')).not.toContain('delete_me');
  });

  it('path jail rejects write outside testDir — ERROR tool_result, no throw', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamEdit(
            toolUseMsgEdit('ef5', 'edit_file', {
              path: 'src/app.ts',
              old_str: 'x',
              new_str: 'y',
            }),
          ),
        );
      return Promise.resolve(makeStreamEdit(endTurnEdit()));
    });

    await runTestAgent('feat-edit', makeCtxEdit(), makeContainerEdit(), tmpRoot3);

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(toolResult?.content)).toContain('ERROR:');
  });

  it('path traversal jail — ERROR tool_result, no throw', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamEdit(
            toolUseMsgEdit('ef6', 'edit_file', {
              path: '../evil.ts',
              old_str: 'x',
              new_str: 'y',
            }),
          ),
        );
      return Promise.resolve(makeStreamEdit(endTurnEdit()));
    });

    await runTestAgent('feat-edit', makeCtxEdit(), makeContainerEdit(), tmpRoot3);

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(toolResult?.content)).toContain('ERROR:');
  });

  it('onToolCall receives edit with oldStrLength and newStrLength', async () => {
    const oldStr = 'const OLD = 1;';
    const newStr = 'const NEW = 2;';
    const filePath = nodePath.join(tmpRoot3, TEST_SUBDIR, 'cb.test.ts');
    nodeFs.writeFileSync(filePath, oldStr + '\n', 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamEdit(
          toolUseMsgEdit('ef7', 'edit_file', {
            path: `${TEST_SUBDIR}/cb.test.ts`,
            old_str: oldStr,
            new_str: newStr,
          }),
        ),
      )
      .mockResolvedValueOnce(makeStreamEdit(endTurnEdit()));

    const infos: ToolCallInfo[] = [];
    await runTestAgent(
      'feat-edit',
      makeCtxEdit(),
      makeContainerEdit(),
      tmpRoot3,
      undefined,
      undefined,
      (i) => {
        infos.push(i);
      },
    );

    expect(infos[0]!.toolName).toBe('edit_file');
    expect(infos[0]!.path).toBe(`${TEST_SUBDIR}/cb.test.ts`);
    expect(infos[0]!.oldStrLength).toBe(oldStr.length);
    expect(infos[0]!.newStrLength).toBe(newStr.length);
  });
});

// ── Turn cap respects ctx.maxTurns ────────────────────────────────────────────

describe('testAgent — turn cap respects maxTurns', () => {
  let tmpRootCap: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRootCap = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-testagent-cap-'));
    nodeFs.mkdirSync(nodePath.join(tmpRootCap, '__tests__'), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRootCap, { recursive: true, force: true });
  });

  function makeStreamMockCap(msg: Anthropic.Message) {
    return { finalMessage: () => Promise.resolve(msg) };
  }

  function toolUseMsgCap(id: string): Anthropic.Message {
    return {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'tool_use', id: `tu_${id}`, name: 'unknown_tool', input: {} }],
    } as unknown as Anthropic.Message;
  }

  it('error message names the configured value (not hardcoded 30)', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMockCap(toolUseMsgCap('cap1')))
      .mockResolvedValueOnce(makeStreamMockCap(toolUseMsgCap('cap2')));

    const container: ContainerHandle = {
      name: 'cap-container',
      exec: () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      stop: () => Promise.resolve(),
    };

    await expect(
      runTestAgent(
        'feat-cap',
        {
          specMarkdown: '',
          contractYaml: '',
          repoClaudeMd: '',
          testDir: '__tests__',
          maxTurns: 2,
        } as Parameters<typeof runTestAgent>[1],
        container,
        tmpRootCap,
      ),
    ).rejects.toThrow('Test Agent hit 2-turn safety cap without completing');
  });
});

const BASE_CTX = {
  specMarkdown: '## Spec',
  contractYaml: 'openapi: "3.0"',
  repoClaudeMd: '# CLAUDE',
  testDir: '__tests__',
};

describe('runTestAgent — initial user-turn message', () => {
  it('does not tell the agent to read spec.md or contract.yaml (already inlined)', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      return Promise.resolve({
        finalMessage: () =>
          Promise.resolve({
            id: 'end',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 5 },
            content: [{ type: 'text', text: 'Done.' }],
          } as unknown as Anthropic.Message),
      });
    });
    await runTestAgent(
      'feat-prompt',
      { ...BASE_CTX },
      {
        name: 'c',
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        stop: async () => {},
      },
      '/tmp',
    );
    const firstCall = calls[0]!;
    const userTurn = firstCall.messages.find((m) => m.role === 'user');
    const content = typeof userTurn?.content === 'string' ? userTurn.content : '';
    expect(content).not.toMatch(/Read spec\.md.*contract\.yaml/);
    expect(content).toContain('already in your system prompt');
  });
});

describe('buildSystemPrompt — existingTestFiles injection', () => {
  it('omits existing-coverage section when existingTestFiles is absent', () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).not.toContain('## Existing test coverage');
  });

  it('omits existing-coverage section when existingTestFiles is empty', () => {
    const prompt = buildSystemPrompt({ ...BASE_CTX, existingTestFiles: [] });
    expect(prompt).not.toContain('## Existing test coverage');
  });

  it('injects the section when existingTestFiles is populated', () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      existingTestFiles: [
        { path: '__tests__/foo.test.ts', describes: ['GET /health', 'POST /users'] },
      ],
    });
    expect(prompt).toContain('## Existing test coverage');
    expect(prompt).toContain('__tests__/foo.test.ts');
    expect(prompt).toContain('"GET /health"');
    expect(prompt).toContain('"POST /users"');
  });

  it('lists multiple files', () => {
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      existingTestFiles: [
        { path: '__tests__/a.test.ts', describes: ['suite A'] },
        { path: '__tests__/b.test.ts', describes: ['suite B'] },
      ],
    });
    expect(prompt).toContain('__tests__/a.test.ts');
    expect(prompt).toContain('__tests__/b.test.ts');
  });

  it('includes inspect_file tool documentation in the system prompt', () => {
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('inspect_file');
  });
});

// ── inspect_file tool ─────────────────────────────────────────────────────────

describe('testAgent — inspect_file tool', () => {
  let tmpRoot: string;
  const TEST_SUBDIR = '__tests__';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'orrery-inspect-'));
    nodeFs.mkdirSync(nodePath.join(tmpRoot, TEST_SUBDIR), { recursive: true });
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function captureInspectResult(
    filePath: string,
    nodeOutput: string,
  ): Promise<{ resultContent: string; execCommands: string[] }> {
    const execCommands: string[] = [];
    const container: ContainerHandle = {
      name: 'test-container',
      exec: (cmd: string) => {
        execCommands.push(cmd);
        return Promise.resolve({ stdout: nodeOutput, stderr: '', exitCode: 0 });
      },
      stop: () => Promise.resolve(),
    };

    const ctx = {
      featureId: 'feat-inspect',
      specMarkdown: '# spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR,
    };

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1) {
        return Promise.resolve({
          finalMessage: () =>
            Promise.resolve({
              id: 'insp',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 10 },
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_insp',
                  name: 'inspect_file',
                  input: { path: filePath },
                },
              ],
            } as unknown as Anthropic.Message),
        });
      }
      return Promise.resolve({
        finalMessage: () =>
          Promise.resolve({
            id: 'end',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 5 },
            content: [{ type: 'text', text: 'done' }],
          } as unknown as Anthropic.Message),
      });
    });

    // Write the script file so checkReadAllowed sees a real path
    nodeFs.writeFileSync(
      nodePath.join(tmpRoot, TEST_SUBDIR, nodePath.basename(filePath)),
      'console.log("hello");\n',
      'utf-8',
    );

    await runTestAgent('feat-inspect', ctx, container, tmpRoot);

    const second = calls[1]!.messages;
    const last = second[second.length - 1];
    const block = (last?.content as Anthropic.ToolResultBlockParam[]).find(
      (b) => b.type === 'tool_result',
    );
    return { resultContent: JSON.stringify(block?.content ?? ''), execCommands };
  }

  it('runs node <abs_path> and returns stdout to the agent', async () => {
    const { resultContent, execCommands } = await captureInspectResult(
      `${TEST_SUBDIR}/debug.mjs`,
      'the sort order is: a, b, c\n',
    );
    expect(resultContent).toContain('the sort order is');
    expect(execCommands.some((c) => c.startsWith('node ') && c.includes(TEST_SUBDIR))).toBe(true);
  });

  it('rejects inspect_file path outside test directory', async () => {
    // checkReadAllowed throws for paths outside testDir — the handler returns an error result
    const execCommands: string[] = [];
    const container: ContainerHandle = {
      name: 'test-container',
      exec: (cmd: string) => {
        execCommands.push(cmd);
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      stop: () => Promise.resolve(),
    };
    const ctx = {
      featureId: 'feat-inspect',
      specMarkdown: '# spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '',
      testDir: TEST_SUBDIR,
    };
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1) {
        return Promise.resolve({
          finalMessage: () =>
            Promise.resolve({
              id: 'insp2',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 10 },
              content: [
                {
                  type: 'tool_use',
                  id: 'tu_insp2',
                  name: 'inspect_file',
                  input: { path: 'src/index.ts' },
                },
              ],
            } as unknown as Anthropic.Message),
        });
      }
      return Promise.resolve({
        finalMessage: () =>
          Promise.resolve({
            id: 'end2',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 5 },
            content: [{ type: 'text', text: 'done' }],
          } as unknown as Anthropic.Message),
      });
    });

    await runTestAgent('feat-inspect', ctx, container, tmpRoot);

    // No node command should have been run — the path jail rejected it
    expect(execCommands.some((c) => c.startsWith('node '))).toBe(false);
    // The tool result should contain an error message
    const second = calls[1]!.messages;
    const last = second[second.length - 1];
    const block = (last?.content as Anthropic.ToolResultBlockParam[]).find(
      (b) => b.type === 'tool_result',
    );
    const content = JSON.stringify(block?.content ?? '');
    expect(content).toContain('implementation directory');
  });
});
