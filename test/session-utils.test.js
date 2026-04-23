import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDuration,
  parseJsonlLines,
  extractToolCallsFromMessages,
  estimateTokens,
  calculateSimilarityScore,
  classifyTaskType,
} from '../lib/session-utils.js';

// ─── formatDuration ───────────────────────────────────────────────────────────

test('formatDuration: sub-minute shows seconds', () => {
  assert.equal(formatDuration(5000), '5s');
});

test('formatDuration: exactly 1 minute', () => {
  assert.equal(formatDuration(60000), '1m 0s');
});

test('formatDuration: hours + minutes + seconds', () => {
  assert.equal(formatDuration(3661000), '1h 1m 1s');
});

test('formatDuration: zero ms returns 0s', () => {
  assert.equal(formatDuration(0), '0s');
});

// ─── parseJsonlLines ──────────────────────────────────────────────────────────

test('parseJsonlLines: parses valid JSONL', () => {
  const raw = '{"type":"user"}\n{"type":"assistant"}\n';
  const result = parseJsonlLines(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'user');
});

test('parseJsonlLines: drops malformed lines silently', () => {
  const raw = '{"type":"user"}\nNOT_JSON\n{"type":"assistant"}';
  const result = parseJsonlLines(raw);
  assert.equal(result.length, 2);
});

test('parseJsonlLines: returns empty array for empty string', () => {
  assert.deepEqual(parseJsonlLines(''), []);
});

test('parseJsonlLines: returns empty array for null input', () => {
  assert.deepEqual(parseJsonlLines(null), []);
});

test('parseJsonlLines: handles single-line JSONL', () => {
  const result = parseJsonlLines('{"a":1}');
  assert.equal(result.length, 1);
  assert.equal(result[0].a, 1);
});

// ─── extractToolCallsFromMessages ────────────────────────────────────────────

test('extractToolCallsFromMessages: extracts tool_use items', () => {
  const messages = [
    {
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00Z',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'ls' } },
        ],
      },
    },
  ];
  const calls = extractToolCallsFromMessages(messages);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'Bash');
  assert.equal(calls[0].id, 'tu1');
});

test('extractToolCallsFromMessages: ignores non-assistant messages', () => {
  const messages = [
    { type: 'user', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x', input: {} }] } },
  ];
  const calls = extractToolCallsFromMessages(messages);
  assert.equal(calls.length, 0);
});

test('extractToolCallsFromMessages: returns empty array for empty input', () => {
  assert.deepEqual(extractToolCallsFromMessages([]), []);
});

test('extractToolCallsFromMessages: handles messages without content', () => {
  const messages = [{ type: 'assistant', message: {} }];
  const calls = extractToolCallsFromMessages(messages);
  assert.deepEqual(calls, []);
});

// ─── estimateTokens ───────────────────────────────────────────────────────────

test('estimateTokens: estimates tokens for non-empty string', () => {
  // "hello" = 5 chars => ceil(5/4) = 2
  assert.equal(estimateTokens('hello'), 2);
});

test('estimateTokens: returns 0 for empty string', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: returns 0 for null', () => {
  assert.equal(estimateTokens(null), 0);
});

test('estimateTokens: 100 chars => ceil(100/4) = 25', () => {
  assert.equal(estimateTokens('a'.repeat(100)), 25);
});

// ─── calculateSimilarityScore ────────────────────────────────────────────────

test('calculateSimilarityScore: identical sets return 1.0', () => {
  const tools = new Set(['Bash', 'Read']);
  const words = new Set(['fix', 'bug']);
  const score = calculateSimilarityScore(tools, words, tools, words);
  assert.equal(score, 1.0);
});

test('calculateSimilarityScore: disjoint sets return 0', () => {
  const score = calculateSimilarityScore(
    new Set(['Bash']), new Set(['foo']),
    new Set(['Read']), new Set(['bar'])
  );
  assert.equal(score, 0);
});

test('calculateSimilarityScore: empty sets return 0', () => {
  const score = calculateSimilarityScore(
    new Set(), new Set(), new Set(), new Set()
  );
  assert.equal(score, 0);
});

test('calculateSimilarityScore: partial overlap returns value between 0 and 1', () => {
  const score = calculateSimilarityScore(
    new Set(['Bash', 'Read']), new Set(['fix', 'bug']),
    new Set(['Bash', 'Write']), new Set(['fix', 'test'])
  );
  assert.ok(score > 0 && score < 1, `expected score in (0,1), got ${score}`);
});

// ─── classifyTaskType ─────────────────────────────────────────────────────────

test('classifyTaskType: "review the code" => codeReview', () => {
  assert.equal(classifyTaskType('please review the code'), 'codeReview');
});

test('classifyTaskType: "fix the bug" => bugFix', () => {
  assert.equal(classifyTaskType('fix the bug in login'), 'bugFix');
});

test('classifyTaskType: "create a new feature" => newFeature', () => {
  assert.equal(classifyTaskType('create a new feature'), 'newFeature');
});

test('classifyTaskType: "find the issue" => research', () => {
  assert.equal(classifyTaskType('find the issue in the logs'), 'research');
});

test('classifyTaskType: unrecognized text => other', () => {
  assert.equal(classifyTaskType('hello world'), 'other');
});

test('classifyTaskType: non-string input => other', () => {
  assert.equal(classifyTaskType(null), 'other');
});
