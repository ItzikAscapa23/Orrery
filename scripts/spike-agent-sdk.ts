#!/usr/bin/env tsx
/**
 * Slice 4b spike — proves the Messages API tool-use loop works end-to-end
 * through the corporate Bedrock setup (BEDROCK_MODEL_ID, NODE_EXTRA_CA_CERTS).
 *
 * Run:
 *   NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem \
 *   tsx --env-file=.env scripts/spike-agent-sdk.ts
 *
 * Success criteria:
 *   1. Prints "✅ SPIKE PASSED"
 *   2. /tmp/spike-4b/hello.txt contains "hello from spike 4b"
 *   3. Bedrock token counts logged to stderr (real API call confirmed)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

// Import through the existing wrapper — inherits BEDROCK_MODEL_ID normalisation,
// CA cert injection, and expired-token detection automatically.
import { createMessage } from '../apps/server/src/lib/anthropic.js';

const WORKDIR = '/tmp/spike-4b';
const MAX_TURNS = 10; // safety cap

// ── Tool definition ───────────────────────────────────────────────────────────

const BASH_TOOL: Anthropic.Tool = {
  name: 'bash',
  description:
    'Execute a shell command in the spike working directory. Returns stdout and stderr.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  },
};

// ── Tool executor ─────────────────────────────────────────────────────────────

function executeBash(command: string): string {
  try {
    const stdout = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return stdout || '(no output)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n');
    return `ERROR: ${out || String(err)}`;
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async function runSpike(): Promise<void> {
  fs.mkdirSync(WORKDIR, { recursive: true });
  console.log(`Working directory: ${WORKDIR}`);

  const taskPrompt =
    "Create a file called hello.txt containing exactly 'hello from spike 4b', " +
    'then read it back and confirm the content is correct. ' +
    'Use only the bash tool.';

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: taskPrompt }];

  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;
    console.log(`\n— turn ${turn} —`);

    const response = await createMessage(
      {
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        tools: [BASH_TOOL],
        messages,
      },
      undefined, // no featureId — spike is standalone
    );

    console.log(`stop_reason: ${response.stop_reason}`);

    // Collect the assistant turn content
    const assistantContent: Anthropic.ContentBlock[] = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    if (response.stop_reason === 'end_turn') {
      const finalText = assistantContent
        .filter((b) => b.type === 'text')
        .map((b) => (b as Anthropic.TextBlock).text)
        .join('');
      console.log(`\nFinal assistant message:\n${finalText}`);
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;
        const input = block.input as { command?: string };
        const command = input.command ?? '';
        console.log(`  tool: ${block.name}  command: ${command}`);
        const result = executeBash(command);
        console.log(`  result: ${result.slice(0, 200)}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    console.error(`Unexpected stop_reason: ${response.stop_reason}`);
    process.exit(1);
  }

  if (turn >= MAX_TURNS) {
    console.error(`❌ SPIKE FAILED — hit ${MAX_TURNS}-turn safety cap`);
    process.exit(1);
  }
}

// ── Main — wrapped in async IIFE so tsx treats this as CJS-compatible ─────────

void (async () => {
  try {
    await runSpike();

    // Verify the file was actually created
    const filePath = path.join(WORKDIR, 'hello.txt');
    if (!fs.existsSync(filePath)) {
      console.error(`❌ SPIKE FAILED — ${filePath} was not created`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content !== 'hello from spike 4b') {
      console.error(`❌ SPIKE FAILED — unexpected content: "${content}"`);
      process.exit(1);
    }

    console.log('\n✅ SPIKE PASSED — tool-use loop works through Bedrock');
    console.log(`   ${filePath} = "${content}"`);
  } catch (err) {
    console.error('\n❌ SPIKE FAILED:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();
