import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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

import {
  runDevAgent,
  resolveWorktreePath,
  buildSystemPrompt,
  PROPOSE_AMENDMENT_TOOL,
} from '../agents/devAgent.js';
import { AllowlistViolationError, MetacharViolationError } from '../lib/container.js';
import type { ContainerHandle } from '../lib/container.js';
import type Anthropic from '@anthropic-ai/sdk';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TASK = {
  id: 't1',
  title: 'Add endpoint',
  description: 'Implement GET /uptime',
  specRefs: [],
};

const CTX = { specMarkdown: '', contractYaml: '', repoClaudeMd: '' };

function toolUseMessage(
  id: string,
  toolName: string,
  input: Record<string, string>,
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

function makeContainer(
  execImpl: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): ContainerHandle {
  return { name: 'test-container', exec: execImpl, stop: () => Promise.resolve() };
}

/** Wrap a Message in a minimal MessageStream mock (only finalMessage() needed). */
function makeStreamMock(msg: Anthropic.Message) {
  return { finalMessage: () => Promise.resolve(msg) };
}

/** Build a mock sequence: n violations then end_turn (agent writes nothing, reconciler commits) */
function makeViolationThenEndTurnSequence(
  violationCount: number,
): () => Promise<ReturnType<typeof makeStreamMock>> {
  let n = 0;
  return () => {
    n++;
    if (n <= violationCount)
      return Promise.resolve(
        makeStreamMock(toolUseMessage(`bad${n}`, 'bash', { command: 'curl evil.com' })),
      );
    return Promise.resolve(makeStreamMock(endTurnMessage()));
  };
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-agent-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// (DIRTY_STATUS removed: git status is now host-side in serverDevJob.ts, not via container.exec)

// ── Violation feedback ────────────────────────────────────────────────────────

describe('devAgent — allowlist violation handling', () => {
  it('feeds a single violation back as a tool error and continues (does not throw)', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];

    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(
          makeStreamMock(toolUseMessage('m1', 'bash', { command: 'curl https://evil.com' })),
        );
      // Second turn: end_turn (agent wrote files, signals done)
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer((cmd) => {
      if (cmd === 'curl https://evil.com') return Promise.reject(new AllowlistViolationError(cmd));
      // git status --porcelain returns dirty (agent wrote files)
      if (cmd === 'git status --porcelain')
        // git is host-side — the agent should never reach this branch
        return Promise.reject(new Error('agent called git: not allowed via container.exec'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    // Verify the streaming method is invoked (not createMessage — InvokeModel is IAM-denied)
    expect(mockCreateMessageStream).toHaveBeenCalled();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(lastUserMsg?.role).toBe('user');
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const errBlock = content.find((b) => b.type === 'tool_result' && b.is_error === true);
    expect(errBlock).toBeDefined();
    expect(errBlock?.content).toContain('Command not on allowlist');
  });

  it('throws AllowlistViolationError after 3 violations in one task', async () => {
    mockCreateMessageStream.mockImplementation(() =>
      Promise.resolve(
        makeStreamMock(toolUseMessage('bad', 'bash', { command: 'curl https://evil.com' })),
      ),
    );

    expect(mockCreateMessageStream).toBeDefined(); // streaming method is wired

    const container = makeContainer((cmd) => Promise.reject(new AllowlistViolationError(cmd)));

    await expect(runDevAgent('feat-1', TASK, CTX, container, tmpDir)).rejects.toThrow(
      AllowlistViolationError,
    );
  });

  it('violation counter resets between separate runDevAgent calls', async () => {
    const container = makeContainer((cmd) => {
      if (cmd.startsWith('curl')) return Promise.reject(new AllowlistViolationError(cmd));
      if (cmd === 'git status --porcelain')
        // git is host-side — the agent should never reach this branch
        return Promise.reject(new Error('agent called git: not allowed via container.exec'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    mockCreateMessageStream.mockReset();
    mockCreateMessageStream.mockImplementation(makeViolationThenEndTurnSequence(2));
    await expect(runDevAgent('feat-1', TASK, CTX, container, tmpDir)).resolves.toBeDefined();

    mockCreateMessageStream.mockReset();
    mockCreateMessageStream.mockImplementation(makeViolationThenEndTurnSequence(2));
    await expect(runDevAgent('feat-1', TASK, CTX, container, tmpDir)).resolves.toBeDefined();
  });
});

// ── File tools ────────────────────────────────────────────────────────────────

describe('devAgent — file tools', () => {
  it('write_file creates a file in the worktree, end_turn emits zero git container exec calls', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    const containerExecCalls: string[] = [];

    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('wf', 'write_file', {
              path: 'src/test.ts',
              content: 'export const x = 1;',
            }),
          ),
        );
      // Turn 2: agent is done — end_turn (no git calls from agent)
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer((cmd) => {
      containerExecCalls.push(cmd);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    // The agent must never invoke git through container.exec — git is host-side only
    const gitContainerCalls = containerExecCalls.filter((c) => c.startsWith('git'));
    expect(gitContainerCalls).toHaveLength(0);

    const written = fs.readFileSync(path.join(tmpDir, 'src', 'test.ts'), 'utf-8');
    expect(written).toBe('export const x = 1;');

    // The write_file tool_result should confirm the write
    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const writeResult = content.find((b) => b.type === 'tool_result');
    expect(JSON.stringify(writeResult?.content)).toContain('Written src/test.ts');
  });

  it('write_file rejects .. traversal — returns error tool_result, does not throw', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('wf', 'write_file', { path: '../evil.ts', content: 'evil' }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    // Agent recovers — no throw
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    // The tool_result for the bad write must be an error message
    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const badResult = content.find((b) => b.type === 'tool_result');
    expect(JSON.stringify(badResult?.content)).toContain('ERROR:');
    expect(JSON.stringify(badResult?.content)).toContain('escapes the worktree');
  });

  it('write_file rejects absolute paths — returns error tool_result', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('wf', 'write_file', { path: '/etc/passwd', content: 'evil' }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const badResult = content.find((b) => b.type === 'tool_result');
    expect(JSON.stringify(badResult?.content)).toContain('ERROR:');
    expect(JSON.stringify(badResult?.content)).toContain('absolute');
  });

  it('read_file returns file content', async () => {
    const filePath = path.join(tmpDir, 'src', 'existing.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const existing = true;', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(
          makeStreamMock(toolUseMessage('rf', 'read_file', { path: 'src/existing.ts' })),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const readResult = content.find((b) => b.type === 'tool_result');
    // Full reads now include 1-based line number prefixes
    expect(JSON.stringify(readResult?.content)).toContain('1\\texport const existing = true;');
  });

  it('bash output is truncated when > 200 lines with truncation marker', async () => {
    const longOutput = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(makeStreamMock(toolUseMessage('ls', 'bash', { command: 'ls src' })));
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer((cmd) => {
      if (cmd === 'ls src') return Promise.resolve({ stdout: longOutput, stderr: '', exitCode: 0 });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const lsResult = content.find((b) => b.type === 'tool_result');
    expect(JSON.stringify(lsResult?.content)).toContain('(truncated');
    expect(JSON.stringify(lsResult?.content)).toContain('line 300');
  });
});

// ── resolveWorktreePath unit tests ────────────────────────────────────────────

describe('resolveWorktreePath', () => {
  it('allows relative paths within the worktree', () => {
    expect(() => resolveWorktreePath('/tmp/wt', 'src/index.ts')).not.toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWorktreePath('/tmp/wt', '/etc/passwd')).toThrow('absolute');
  });

  it('rejects .. traversal', () => {
    expect(() => resolveWorktreePath('/tmp/wt', '../secret.ts')).toThrow('escapes');
  });

  it('rejects deep traversal that escapes root', () => {
    expect(() => resolveWorktreePath('/tmp/wt', 'src/../../etc/passwd')).toThrow('escapes');
  });

  it('allows a path that resolves to exactly the worktree root', () => {
    expect(() => resolveWorktreePath('/tmp/wt', '.')).not.toThrow();
  });
});

// ── propose_amendment tool ────────────────────────────────────────────────────

describe('devAgent — propose_amendment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-amendment-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns amendment_proposed outcome when model calls propose_amendment tool', async () => {
    // First turn: model calls propose_amendment
    mockCreateMessageStream.mockResolvedValueOnce(
      makeStreamMock(
        toolUseMessage('msg1', 'propose_amendment', {
          contract_yaml: 'openapi: "3.0.0"\ninfo:\n  title: Revised\n  version: "2.0.0"\npaths: {}',
          rationale: 'The contract is missing a required /greeting endpoint.',
        }),
      ),
    );

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    const outcome = await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    expect(outcome.kind).toBe('amendment_proposed');
    if (outcome.kind === 'amendment_proposed') {
      expect(outcome.contractYaml).toContain('Revised');
      expect(outcome.rationale).toContain('missing a required /greeting endpoint');
      expect(outcome.taskId).toBe('t1');
    }
    // Should have called the model exactly once (early exit after propose_amendment)
    expect(mockCreateMessageStream).toHaveBeenCalledTimes(1);
  });

  it('returns completed outcome on normal end_turn', async () => {
    mockCreateMessageStream.mockResolvedValueOnce(makeStreamMock(endTurnMessage()));
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    const outcome = await runDevAgent('feat-2', TASK, CTX, container, tmpDir);
    expect(outcome.kind).toBe('completed');
  });
});

// ── MetacharViolationError feedback + budget ──────────────────────────────────

describe('devAgent — metacharacter violation budget (2>&1 regression guard)', () => {
  it('strike 1: metachar violation returns is_error tool_result feedback, agent continues', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];

    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        // Agent runs a command with a file redirect (> is still a metachar violation)
        return Promise.resolve(
          makeStreamMock(toolUseMessage('m1', 'bash', { command: 'npm run build > output.log' })),
        );
      // Turn 2: agent received the feedback and ends cleanly
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    // Container throws MetacharViolationError for '>'
    const container = makeContainer((cmd) => {
      if (cmd.includes('> output.log')) return Promise.reject(new MetacharViolationError(cmd, '>'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // Should not throw — strike 1 is absorbed as tool_result feedback
    const outcome = await runDevAgent('feat-1', TASK, CTX, container, tmpDir);
    expect(outcome.kind).toBe('completed');

    // The second API call must include a tool_result with is_error=true
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const errBlock = content.find((b) => b.type === 'tool_result' && b.is_error === true);
    expect(errBlock).toBeDefined();
    // The feedback must describe what is actually blocked
    expect(JSON.stringify(errBlock?.content)).toContain('File redirection is not permitted');
  });

  it('pipe violation feedback names jest positional-pattern alternative', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];

    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      const n = calls.length;
      if (n === 1)
        return Promise.resolve(
          makeStreamMock(toolUseMessage('p1', 'bash', { command: 'npm test | grep passed' })),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer((cmd) => {
      if (cmd.includes('| grep')) return Promise.reject(new MetacharViolationError(cmd, '|'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const outcome = await runDevAgent('feat-1', TASK, CTX, container, tmpDir);
    expect(outcome.kind).toBe('completed');

    const secondCallMessages = calls[1]!.messages;
    const lastUserMsg = secondCallMessages[secondCallMessages.length - 1];
    const content = lastUserMsg?.content as Anthropic.ToolResultBlockParam[];
    const errBlock = content.find((b) => b.type === 'tool_result' && b.is_error === true);
    expect(errBlock).toBeDefined();
    // Guidance must name the jest alternative, not just repeat the prohibition
    expect(JSON.stringify(errBlock?.content)).toMatch(/testPathPattern|positional/i);
  });

  it('strike 2: still tool_result feedback, agent continues and completes', async () => {
    let bashCallCount = 0;

    mockCreateMessageStream.mockImplementation(() => {
      // Each API call the agent tries the same bad command once, then on the 3rd turn ends
      const callN = ++bashCallCount;
      if (callN <= 2)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage(`m${callN}`, 'bash', { command: 'npm run build > output.log' }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer((cmd) => {
      if (cmd.includes('> output.log')) return Promise.reject(new MetacharViolationError(cmd, '>'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    // Two violations → both absorbed → agent completes on turn 3
    const outcome = await runDevAgent('feat-1', TASK, CTX, container, tmpDir);
    expect(outcome.kind).toBe('completed');
  });

  it('strike 3: third metachar violation throws MetacharViolationError out of the agent', async () => {
    // Every API call returns a file-redirect command, exhausting the 3-violation budget
    mockCreateMessageStream.mockImplementation(() =>
      Promise.resolve(
        makeStreamMock(toolUseMessage('bad', 'bash', { command: 'npm run build > output.log' })),
      ),
    );

    const container = makeContainer((cmd) => {
      if (cmd.includes('> output.log')) return Promise.reject(new MetacharViolationError(cmd, '>'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    await expect(runDevAgent('feat-1', TASK, CTX, container, tmpDir)).rejects.toThrow(
      MetacharViolationError,
    );
  });
});

// ── read_file range ───────────────────────────────────────────────────────────

describe('devAgent — read_file range', () => {
  function makeReadFileCall(input: Record<string, unknown>): ReturnType<typeof makeStreamMock> {
    return makeStreamMock({
      id: 'rf',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 'tu_rf', name: 'read_file', input }],
    } as unknown as Anthropic.Message);
  }

  async function captureToolResult(input: Record<string, unknown>): Promise<string> {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1) return Promise.resolve(makeReadFileCall(input));
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);
    const second = calls[1]!.messages;
    const last = second[second.length - 1];
    const content = last?.content as Anthropic.ToolResultBlockParam[];
    const block = content.find((b) => b.type === 'tool_result');
    return JSON.stringify(block?.content ?? '');
  }

  it('returns exact slice with 1-based line numbers prefixed', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    fs.writeFileSync(path.join(tmpDir, 'sample.ts'), lines.join('\n'), 'utf-8');
    const result = await captureToolResult({ path: 'sample.ts', start_line: 3, end_line: 5 });
    expect(result).toContain('3\\tline3');
    expect(result).toContain('4\\tline4');
    expect(result).toContain('5\\tline5');
    expect(result).not.toContain('line1');
    expect(result).not.toContain('line6');
  });

  it('end_line past EOF clamps to last line', async () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    fs.writeFileSync(path.join(tmpDir, 'short.ts'), lines.join('\n'), 'utf-8');
    const result = await captureToolResult({ path: 'short.ts', start_line: 4, end_line: 99 });
    expect(result).toContain('4\\td');
    expect(result).toContain('5\\te');
    expect(result).not.toContain('line6');
  });

  it('start_line past EOF returns error with line count', async () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    fs.writeFileSync(path.join(tmpDir, 'short.ts'), lines.join('\n'), 'utf-8');
    const result = await captureToolResult({ path: 'short.ts', start_line: 10 });
    expect(result).toContain('file has 5 lines');
  });
});

// ── read_file truncation ──────────────────────────────────────────────────────

describe('devAgent — read_file truncation', () => {
  async function captureFullReadResult(content: string, filename = 'target.ts'): Promise<string> {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamMock({
            id: 'rf',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
            content: [
              { type: 'tool_use', id: 'tu_rf', name: 'read_file', input: { path: filename } },
            ],
          } as unknown as Anthropic.Message),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf-8');
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);
    const second = calls[1]!.messages;
    const last = second[second.length - 1];
    const block = (last?.content as Anthropic.ToolResultBlockParam[]).find(
      (b) => b.type === 'tool_result',
    );
    return JSON.stringify(block?.content ?? '');
  }

  it('file under the limit is returned whole with no truncation marker', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const result = await captureFullReadResult(lines.join('\n'));
    expect(result).toContain('line10');
    expect(result).not.toContain('showing first');
  });

  it('file over the limit keeps the beginning and includes a truncation marker', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
    const result = await captureFullReadResult(lines.join('\n'));
    expect(result).toContain('line1');
    expect(result).not.toContain('line600');
    expect(result).toContain('showing first');
  });

  it('truncation marker names the total line count and how to read the rest', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
    const result = await captureFullReadResult(lines.join('\n'));
    expect(result).toContain('600');
    expect(result).toContain('start_line');
  });

  it('full and ranged reads are formatted consistently (both have 1-based line numbers)', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `item${i + 1}`);
    const fullResult = await captureFullReadResult(lines.join('\n'), 'nums.ts');
    // Full read should prefix line numbers just like range reads
    expect(fullResult).toContain('1\\titem1');
    expect(fullResult).toContain('3\\titem3');
    expect(fullResult).toContain('5\\titem5');
  });
});

// ── Violation events ──────────────────────────────────────────────────────────

describe('devAgent — violation events', () => {
  it('each metachar violation calls onViolation with count and rule', async () => {
    let bashCallCount = 0;
    mockCreateMessageStream.mockImplementation(() => {
      const n = ++bashCallCount;
      if (n <= 2)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage(`m${n}`, 'bash', { command: 'npm run build > output.log' }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });
    const container = makeContainer((cmd) => {
      if (cmd.includes('> output.log')) return Promise.reject(new MetacharViolationError(cmd, '>'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const calls: Array<{ rule: string; count: number }> = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, (info) => {
      calls.push({ rule: info.rule, count: info.count });
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ rule: 'metachar', count: 1 });
    expect(calls[1]).toMatchObject({ rule: 'metachar', count: 2 });
  });

  it('third violation calls onViolation then throws', async () => {
    mockCreateMessageStream.mockImplementation(() =>
      Promise.resolve(
        makeStreamMock(toolUseMessage('bad', 'bash', { command: 'npm run build > output.log' })),
      ),
    );
    const container = makeContainer((cmd) => {
      if (cmd.includes('> output.log')) return Promise.reject(new MetacharViolationError(cmd, '>'));
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    const calls: number[] = [];
    await expect(
      runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, (info) => {
        calls.push(info.count);
      }),
    ).rejects.toThrow(MetacharViolationError);

    expect(calls).toHaveLength(3);
    expect(calls).toEqual([1, 2, 3]);
  });
});

// ── Contract authority prompt content ─────────────────────────────────────────

describe('buildSystemPrompt — contract authority', () => {
  const PROMPT_TASK = {
    id: 't1',
    title: 'Add AQI widget',
    description: 'Show AQI data',
    specRefs: [],
  };
  const PROMPT_CTX = { specMarkdown: '', contractYaml: 'openapi: "3.0.0"', repoClaudeMd: '' };

  it('system prompt contains the Contract authority section', () => {
    const prompt = buildSystemPrompt(PROMPT_TASK, PROMPT_CTX);
    expect(prompt).toContain('## Contract authority');
    expect(prompt).toContain('contract.yaml is the sole authority');
    expect(prompt).toContain('propose_amendment tool');
    expect(prompt).toContain('Implementing against a field the contract lacks is a defect');
  });

  it('propose_amendment tool description contains a concrete trigger example', () => {
    expect(PROPOSE_AMENDMENT_TOOL.description).toContain('pollutant');
    expect(PROPOSE_AMENDMENT_TOOL.description).toContain('propose adding it');
  });

  it('system prompt contains the generalized output-capture and exploration ergonomics (both server and client profiles)', () => {
    // Both profiles use the same buildSystemPrompt — one test covers both.
    const prompt = buildSystemPrompt(PROMPT_TASK, PROMPT_CTX);
    // Auto-capture
    expect(prompt).toContain('stdout AND stderr are captured and returned together automatically');
    expect(prompt).toContain('never use pipes');
    expect(prompt).toContain('2>&1 is permitted');
    // Generalized truncation + pipe ban (replaces the narrower "never use | head or | tail")
    expect(prompt).toContain('Output is ALWAYS auto-truncated to a safe length');
    expect(prompt).toContain('you never need | head, | tail, or | grep to shrink it');
    expect(prompt).toContain(
      'Any command containing | > < ; & fails, every time, with no exception',
    );
    // Script runner
    expect(prompt).toContain('node path/to/script.js');
    // Exploration discipline: node_modules named as the anti-pattern
    expect(prompt).toContain('node_modules is off-limits for exploration');
    expect(prompt).toContain("read package.json and the repo's own src/");
    expect(prompt).toContain('package.json and tsconfig.json');
  });
});

// ── stop_reason: max_tokens recovery ─────────────────────────────────────────

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

describe('devAgent — stop_reason: max_tokens recovery', () => {
  it('pops the partial assistant message so no stale entry persists after recovery', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      return Promise.resolve(
        makeStreamMock(calls.length === 1 ? maxTokensMessage() : endTurnMessage()),
      );
    });
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    await runDevAgent('feat-trunc', TASK, CTX, container, tmpDir);

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
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    await runDevAgent('feat-trunc', TASK, CTX, container, tmpDir);

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
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    const outcome = await runDevAgent('feat-trunc', TASK, CTX, container, tmpDir);
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
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    const outcome = await runDevAgent('feat-trunc', TASK, CTX, container, tmpDir);
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

// ── orientationBlock in system prompt ────────────────────────────────────────

describe('buildSystemPrompt — orientation block placement and caching', () => {
  const PROMPT_TASK = { id: 't1', title: 'Test', description: 'Do it', specRefs: [] };

  it('orientation block appears in the system prompt when provided', () => {
    const ctx = {
      specMarkdown: '## Spec',
      contractYaml: 'openapi: "3.0.0"',
      repoClaudeMd: '# Conventions',
      orientationBlock: '## Repository orientation\nsrc/index.ts\n',
    };
    const prompt = buildSystemPrompt(PROMPT_TASK, ctx);
    expect(prompt).toContain('## Repository orientation');
    expect(prompt).toContain('src/index.ts');
  });

  it('orientation block appears AFTER CLAUDE.md and BEFORE the contract', () => {
    const ctx = {
      specMarkdown: '',
      contractYaml: '--- THE_CONTRACT ---',
      repoClaudeMd: '--- THE_CLAUDE_MD ---',
      orientationBlock: '--- THE_ORIENTATION ---',
    };
    const prompt = buildSystemPrompt(PROMPT_TASK, ctx);
    const claudePos = prompt.indexOf('--- THE_CLAUDE_MD ---');
    const orientPos = prompt.indexOf('--- THE_ORIENTATION ---');
    const contractPos = prompt.indexOf('--- THE_CONTRACT ---');
    expect(claudePos).toBeGreaterThanOrEqual(0);
    expect(orientPos).toBeGreaterThan(claudePos);
    expect(contractPos).toBeGreaterThan(orientPos);
  });

  it('system prompt contains the anti-rediscovery rule', () => {
    const ctx = {
      specMarkdown: '',
      contractYaml: '',
      repoClaudeMd: '',
      orientationBlock: '## Repository orientation\nfoo.ts\n',
    };
    const prompt = buildSystemPrompt(PROMPT_TASK, ctx);
    expect(prompt).toContain('Do not run find, ls, or cat to rediscover');
    expect(prompt).toContain('Read a file only when you need its contents');
  });

  it('orientation block is absent from the prompt when not provided', () => {
    const ctx = { specMarkdown: '', contractYaml: '', repoClaudeMd: '' };
    const prompt = buildSystemPrompt(PROMPT_TASK, ctx);
    expect(prompt).not.toContain('## Repository orientation');
    expect(prompt).not.toContain('Do not run find, ls, or cat to rediscover');
  });

  it('orientation block is inside the single cached text block (before cache_control breakpoint)', async () => {
    // The cache_control breakpoint is applied to the system array passed to createMessageStream.
    // We verify that systemPrompt (the single string) contains both the orientation AND
    // the contract — meaning orientation is merged into the same cached prefix, not a
    // separate block that would shift the breakpoint.
    const calls: Array<{ system: unknown }> = [];
    mockCreateMessageStream.mockImplementation((params: { system: unknown }) => {
      calls.push({ system: params.system });
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const ctx = {
      specMarkdown: '',
      contractYaml: '--- THE_CONTRACT ---',
      repoClaudeMd: '--- THE_CLAUDE_MD ---',
      orientationBlock: '--- THE_ORIENTATION ---',
    };
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', PROMPT_TASK, ctx, container, tmpDir);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const systemArray = calls[0]!.system as Array<{
      type: string;
      text: string;
      cache_control?: unknown;
    }>;
    // Exactly one system block (orientation merged into the same string)
    expect(systemArray).toHaveLength(1);
    const singleBlock = systemArray[0]!;
    expect(singleBlock.cache_control).toBeDefined();
    expect(singleBlock.text).toContain('--- THE_ORIENTATION ---');
    expect(singleBlock.text).toContain('--- THE_CONTRACT ---');
  });
});

// ── onToolCall callback ───────────────────────────────────────────────────────

import type { ToolCallInfo } from '../agents/devAgent.js';

describe('devAgent — onToolCall callback', () => {
  it('bash: emits toolName, turn, command (≤120 chars), and resultSize', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMock(toolUseMessage('b1', 'bash', { command: 'npm test' })))
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() =>
      Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 }),
    );

    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos).toHaveLength(1);
    expect(infos[0]!.toolName).toBe('bash');
    expect(infos[0]!.turn).toBe(1);
    expect(infos[0]!.command).toBe('npm test');
    expect(typeof infos[0]!.resultSize).toBe('number');
    expect(infos[0]!.resultSize).toBeGreaterThan(0);
  });

  it('bash: command longer than 120 chars is truncated to 120 in the callback', async () => {
    const longCmd = 'x'.repeat(200);
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMock(toolUseMessage('b2', 'bash', { command: longCmd })))
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() =>
      Promise.resolve({ stdout: 'out', stderr: '', exitCode: 0 }),
    );

    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos[0]!.command).toHaveLength(120);
  });

  it('read_file (full): emits path and range="full"', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'const x = 1;\n', 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(toolUseMessage('rf1', 'read_file', { path: 'hello.ts' })),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos).toHaveLength(1);
    expect(infos[0]!.toolName).toBe('read_file');
    expect(infos[0]!.path).toBe('hello.ts');
    expect(infos[0]!.range).toBe('full');
    expect(infos[0]!.resultSize).toBeGreaterThan(0);
  });

  it('read_file (range): emits range as "lines N–M"', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    fs.writeFileSync(path.join(tmpDir, 'ranged.ts'), lines.join('\n'), 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(
          toolUseMessage('rf2', 'read_file', {
            path: 'ranged.ts',
            start_line: '3',
            end_line: '6',
          }),
        ),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos[0]!.range).toBe('lines 3–6');
  });

  it('write_file: emits path and contentLength', async () => {
    const content = 'export const y = 42;\n';
    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(toolUseMessage('wf1', 'write_file', { path: 'src/new.ts', content })),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));

    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos[0]!.toolName).toBe('write_file');
    expect(infos[0]!.path).toBe('src/new.ts');
    expect(infos[0]!.contentLength).toBe(content.length);
  });

  it('fires after the tool result (turn counter increments per API call, not per tool)', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMock(toolUseMessage('b3', 'bash', { command: 'echo 1' })))
      .mockResolvedValueOnce(makeStreamMock(toolUseMessage('b4', 'bash', { command: 'echo 2' })))
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() =>
      Promise.resolve({ stdout: 'hi', stderr: '', exitCode: 0 }),
    );

    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos).toHaveLength(2);
    expect(infos[0]!.turn).toBe(1);
    expect(infos[1]!.turn).toBe(2);
  });
});

// ── edit_file tool ────────────────────────────────────────────────────────────

describe('devAgent — edit_file tool', () => {
  it('unique match — changes only the matched text, tool_result confirms edit', async () => {
    const filePath = path.join(tmpDir, 'src', 'foo.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'const A = 1;\n', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('ef1', 'edit_file', {
              path: 'src/foo.ts',
              old_str: 'const A = 1;',
              new_str: 'const B = 2;',
            }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    const disk = fs.readFileSync(filePath, 'utf-8');
    expect(disk).toContain('const B = 2;');
    expect(disk).not.toContain('const A = 1;');

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(toolResult?.content)).toContain('Edited src/foo.ts');
  });

  it('zero matches — is_error tool_result, file untouched on disk', async () => {
    const filePath = path.join(tmpDir, 'src', 'zero.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('ef2', 'edit_file', {
              path: 'src/zero.ts',
              old_str: 'DOES_NOT_EXIST',
              new_str: 'replacement',
            }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('const x = 1;\n');

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(toolResult?.is_error).toBe(true);
    expect(JSON.stringify(toolResult?.content)).toContain('old_str not found in src/zero.ts');
  });

  it('multiple matches — is_error naming the count, file untouched', async () => {
    const filePath = path.join(tmpDir, 'src', 'multi.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'foo\nfoo\n', 'utf-8');

    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('ef3', 'edit_file', {
              path: 'src/multi.ts',
              old_str: 'foo',
              new_str: 'bar',
            }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('foo\nfoo\n');

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(toolResult?.is_error).toBe(true);
    expect(JSON.stringify(toolResult?.content)).toContain('matches 2 times');
  });

  it('empty new_str deletes the matched text', async () => {
    const filePath = path.join(tmpDir, 'src', 'del.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'keep\ndelete_me\nkeep\n', 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(
          toolUseMessage('ef4', 'edit_file', {
            path: 'src/del.ts',
            old_str: 'delete_me\n',
            new_str: '',
          }),
        ),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('delete_me');
  });

  it('path jail rejects traversal — ERROR tool_result, no throw', async () => {
    const calls: Array<{ messages: Anthropic.MessageParam[] }> = [];
    mockCreateMessageStream.mockImplementation((params: { messages: Anthropic.MessageParam[] }) => {
      calls.push({ messages: params.messages.slice() });
      if (calls.length === 1)
        return Promise.resolve(
          makeStreamMock(
            toolUseMessage('ef5', 'edit_file', {
              path: '../evil.ts',
              old_str: 'x',
              new_str: 'y',
            }),
          ),
        );
      return Promise.resolve(makeStreamMock(endTurnMessage()));
    });

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir);

    const toolResult = (
      calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[]
    ).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(toolResult?.content)).toContain('ERROR:');
    expect(JSON.stringify(toolResult?.content)).toContain('escapes the worktree');
  });

  it('onToolCall receives edit with oldStrLength and newStrLength', async () => {
    const filePath = path.join(tmpDir, 'src', 'cb.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const oldStr = 'const OLD = 1;';
    const newStr = 'const NEW = 2;';
    fs.writeFileSync(filePath, oldStr + '\n', 'utf-8');

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(
          toolUseMessage('ef6', 'edit_file', {
            path: 'src/cb.ts',
            old_str: oldStr,
            new_str: newStr,
          }),
        ),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    const infos: ToolCallInfo[] = [];
    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (i) => {
      infos.push(i);
    });

    expect(infos[0]!.toolName).toBe('edit_file');
    expect(infos[0]!.path).toBe('src/cb.ts');
    expect(infos[0]!.oldStrLength).toBe(oldStr.length);
    expect(infos[0]!.newStrLength).toBe(newStr.length);
  });
});

// ── Turn cap respects ctx.maxTurns ────────────────────────────────────────────

describe('devAgent — turn cap respects maxTurns', () => {
  it('error message names the configured value (not hardcoded 40)', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(makeStreamMock(toolUseMessage('c1', 'unknown_tool', {})))
      .mockResolvedValueOnce(makeStreamMock(toolUseMessage('c2', 'unknown_tool', {})));
    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    await expect(
      runDevAgent('feat-cap', TASK, { ...CTX, maxTurns: 2 }, container, tmpDir),
    ).rejects.toThrow('Agent hit 2-turn safety cap without completing task t1');
  });
});

// ── onToolCall metadata (error-path variable hoisting) ────────────────────────

describe('devAgent — onToolCall metadata', () => {
  it('read_file ENOENT: onToolCall receives path and range even when file is not found', async () => {
    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(toolUseMessage('rf1', 'read_file', { path: 'src/missing.ts' })),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    const calls: import('../agents/devAgent.js').ToolCallInfo[] = [];

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (info) => {
      calls.push(info);
    });

    const readCall = calls.find((c) => c.toolName === 'read_file');
    expect(readCall).toBeDefined();
    expect(readCall!.path).toBe('src/missing.ts');
    expect(readCall!.range).toBe('full');
    expect(readCall!.resultSize).toBeGreaterThan(0);
  });

  it('read_file with start_line/end_line: range reflects input params on success', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
      'utf-8',
    );

    mockCreateMessageStream
      .mockResolvedValueOnce(
        makeStreamMock(
          toolUseMessage('rf2', 'read_file', {
            path: 'src/example.ts',
            start_line: 10,
            end_line: 20,
          } as unknown as Record<string, string>),
        ),
      )
      .mockResolvedValueOnce(makeStreamMock(endTurnMessage()));

    const container = makeContainer(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }));
    const calls: import('../agents/devAgent.js').ToolCallInfo[] = [];

    await runDevAgent('feat-1', TASK, CTX, container, tmpDir, undefined, undefined, (info) => {
      calls.push(info);
    });

    const readCall = calls.find((c) => c.toolName === 'read_file');
    expect(readCall).toBeDefined();
    expect(readCall!.path).toBe('src/example.ts');
    expect(readCall!.range).toBe('lines 10–20');
  });
});
