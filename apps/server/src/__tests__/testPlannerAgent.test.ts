import { describe, expect, it, vi } from 'vitest';

process.env['ANTHROPIC_PROVIDER'] = 'anthropic';
process.env['ANTHROPIC_API_KEY'] = 'test-key';

const { mockCreateMessageStream } = vi.hoisted(() => ({
  mockCreateMessageStream: vi.fn(),
}));

vi.mock('../lib/anthropic.js', () => ({
  createMessageStream: mockCreateMessageStream,
}));

import { runTestPlannerAgent } from '../agents/testPlannerAgent.js';
import type { TaskSummary } from '../agents/testPlannerAgent.js';

function makeMockStream(responseText: string) {
  return Promise.resolve({
    finalMessage: vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: responseText }],
    }),
  });
}

const TASKS: TaskSummary[] = [
  { id: 'task-1', title: 'Add POST /items endpoint', specRefs: ['API endpoints'] },
  { id: 'task-2', title: 'Run DB migration', specRefs: ['Database schema'] },
];

describe('testPlannerAgent — prompt context', () => {
  function setupMockAndRun(tasks = TASKS) {
    mockCreateMessageStream.mockImplementationOnce(() =>
      makeMockStream(JSON.stringify({
        coverage: tasks.map((t) => ({ taskId: t.id, covered: true, behaviour: 'test' })),
      })),
    );
    return runTestPlannerAgent('feat-1', '# Spec', 'openapi: 3.0.0', tasks);
  }

  it('system prompt instructs agent to mark tasks covered or skipped', async () => {
    await setupMockAndRun();
    const [streamArgs] = mockCreateMessageStream.mock.calls[0] as [{ system: string }];
    const systemPrompt = streamArgs.system;
    expect(systemPrompt).toContain('covered');
    expect(systemPrompt).toContain('skipped');
    expect(systemPrompt.toLowerCase()).toContain('observable public behaviour');
  });

  it('system prompt explicitly says no implementation descriptions are provided', async () => {
    await setupMockAndRun();
    const [streamArgs] = mockCreateMessageStream.mock.calls[0] as [{ system: string }];
    const systemLower = streamArgs.system.toLowerCase();
    // The prompt must exclude implementation descriptions
    expect(systemLower).toContain('never');
    expect(systemLower).toContain('implementation');
  });

  it('user content includes task IDs, titles, and specRefs', async () => {
    await setupMockAndRun();
    const [streamArgs] = mockCreateMessageStream.mock.calls[0] as [{ messages: Array<{ content: string }> }];
    const userContent = streamArgs.messages[0]!.content as string;
    expect(userContent).toContain('task-1');
    expect(userContent).toContain('Add POST /items endpoint');
    expect(userContent).toContain('API endpoints');
  });

  it('user content does NOT include task descriptions', async () => {
    const tasksWithDescriptions = TASKS.map((t) => ({ ...t, description: 'This is the description' }));
    mockCreateMessageStream.mockImplementationOnce(() =>
      makeMockStream(JSON.stringify({
        coverage: tasksWithDescriptions.map((t) => ({ taskId: t.id, covered: true, behaviour: 'test' })),
      })),
    );
    // runTestPlannerAgent receives TaskSummary[] — no description field on that type
    await runTestPlannerAgent('feat-1', '# Spec', 'openapi: 3.0.0', tasksWithDescriptions as TaskSummary[]);

    const [streamArgs] = mockCreateMessageStream.mock.calls[0] as [{ messages: Array<{ content: string }> }];
    const userContent = streamArgs.messages[0]!.content as string;
    expect(userContent).not.toContain('This is the description');
  });

  it('parses valid JSON response into TestPlanOutput', async () => {
    const mockOutput = {
      coverage: [
        { taskId: 'task-1', covered: true, behaviour: 'POST /items returns 201' },
        { taskId: 'task-2', covered: false, skipReason: 'Migration only' },
      ],
    };
    mockCreateMessageStream.mockImplementationOnce(() =>
      makeMockStream(JSON.stringify(mockOutput)),
    );

    const result = await runTestPlannerAgent('feat-1', '# Spec', 'openapi: 3.0.0', TASKS);
    expect(result.coverage).toHaveLength(2);
    expect(result.coverage[0]!.taskId).toBe('task-1');
    expect(result.coverage[0]!.covered).toBe(true);
    expect(result.coverage[1]!.covered).toBe(false);
    expect(result.coverage[1]!.skipReason).toBe('Migration only');
  });

  it('falls back to all-covered when JSON parse fails', async () => {
    mockCreateMessageStream.mockImplementationOnce(() =>
      makeMockStream('Sorry, I cannot help with that.'),
    );

    const result = await runTestPlannerAgent('feat-1', '# Spec', 'openapi: 3.0.0', TASKS);
    expect(result.coverage).toHaveLength(TASKS.length);
    expect(result.coverage.every((c) => c.covered)).toBe(true);
  });

  it('system prompt includes chain-coverage rule for dependency chains', async () => {
    await setupMockAndRun();
    const [streamArgs] = mockCreateMessageStream.mock.calls[0] as [{ system: string }];
    const systemPrompt = streamArgs.system;
    expect(systemPrompt).toContain('dependency chain');
    expect(systemPrompt.toLowerCase()).toContain('observable');
  });

  it('system prompt instructs skipped intermediate tasks to name the covering task', async () => {
    await setupMockAndRun();
    const [streamArgs] = mockCreateMessageStream.mock.calls[0] as [{ system: string }];
    const systemPrompt = streamArgs.system;
    expect(systemPrompt).toContain('Covered by acceptance test for');
  });

  it('a chain of tasks with one observable behaviour yields one covered task and named skip reasons', async () => {
    const chainTasks: TaskSummary[] = [
      { id: 'task-a', title: 'Implement parallel DCS call orchestration', specRefs: ['S1'] },
      { id: 'task-b', title: 'Implement maxStrongIdentificationCreditLimit computation', specRefs: ['S2'] },
      { id: 'task-c', title: 'Implement club items merge logic', specRefs: ['S3'] },
      { id: 'task-d', title: 'Integrate merge and computation into orderCardClubsList resolver', specRefs: ['S4'] },
    ];
    const mockOutput = {
      coverage: [
        { taskId: 'task-a', covered: false, skipReason: 'Covered by acceptance test for task-d — Integrate merge and computation into orderCardClubsList resolver' },
        { taskId: 'task-b', covered: false, skipReason: 'Covered by acceptance test for task-d — Integrate merge and computation into orderCardClubsList resolver' },
        { taskId: 'task-c', covered: false, skipReason: 'Covered by acceptance test for task-d — Integrate merge and computation into orderCardClubsList resolver' },
        { taskId: 'task-d', covered: true, behaviour: 'orderCardClubsList GraphQL resolver returns merged items with credit limit applied' },
      ],
    };
    mockCreateMessageStream.mockImplementationOnce(() => makeMockStream(JSON.stringify(mockOutput)));
    const result = await runTestPlannerAgent('feat-chain', '# Spec', 'openapi: 3.0.0', chainTasks);

    expect(result.coverage).toHaveLength(4);
    const coveredTasks = result.coverage.filter((c) => c.covered);
    expect(coveredTasks).toHaveLength(1);
    expect(coveredTasks[0]!.taskId).toBe('task-d');
    const skippedTasks = result.coverage.filter((c) => !c.covered);
    expect(skippedTasks).toHaveLength(3);
    skippedTasks.forEach((t) => {
      expect(t.skipReason).toContain('Covered by acceptance test for task-d');
    });
  });

  it('two independently observable tasks remain separately covered', async () => {
    const twoTasks: TaskSummary[] = [
      { id: 'task-e', title: 'Implement GET /clubs endpoint', specRefs: ['S1'] },
      { id: 'task-f', title: 'Implement POST /clubs endpoint', specRefs: ['S2'] },
    ];
    const mockOutput = {
      coverage: [
        { taskId: 'task-e', covered: true, behaviour: 'GET /clubs returns list of clubs' },
        { taskId: 'task-f', covered: true, behaviour: 'POST /clubs creates a new club and returns 201' },
      ],
    };
    mockCreateMessageStream.mockImplementationOnce(() => makeMockStream(JSON.stringify(mockOutput)));
    const result = await runTestPlannerAgent('feat-two', '# Spec', 'openapi: 3.0.0', twoTasks);

    expect(result.coverage).toHaveLength(2);
    expect(result.coverage.every((c) => c.covered)).toBe(true);
    expect(result.coverage[0]!.behaviour).toBe('GET /clubs returns list of clubs');
    expect(result.coverage[1]!.behaviour).toBe('POST /clubs creates a new club and returns 201');
  });

  it('single-task feature is unaffected — still covered', async () => {
    const singleTask: TaskSummary[] = [
      { id: 'task-g', title: 'Implement GET /health endpoint', specRefs: ['S1'] },
    ];
    const mockOutput = {
      coverage: [
        { taskId: 'task-g', covered: true, behaviour: 'GET /health returns 200 with status ok' },
      ],
    };
    mockCreateMessageStream.mockImplementationOnce(() => makeMockStream(JSON.stringify(mockOutput)));
    const result = await runTestPlannerAgent('feat-single', '# Spec', 'openapi: 3.0.0', singleTask);

    expect(result.coverage).toHaveLength(1);
    expect(result.coverage[0]!.covered).toBe(true);
    expect(result.coverage[0]!.taskId).toBe('task-g');
  });
});
