'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callDetails, resultDetails, runningProcesses } = require('../lib/tool-details');
const { summarizeTranscript } = require('../lib/transcript');
const { liveMapModel } = require('../lib/live-map-model');

const privateText = 'PRIVATE_TOKEN_FILE_QUERY_URL';
const meta = { type: 'session_meta', payload: { session_id: 'privacy', cwd: '/workspace', cli_version: '0.164.0' } };
const summarize = (name, input, output) => summarizeTranscript([
  meta, { type: 'event_msg', payload: { type: 'task_started' } },
  { type: 'response_item', timestamp: '2026-10-26T10:00:00Z', payload: { type: 'function_call', call_id: 'call', name, arguments: input } },
  { type: 'response_item', timestamp: '2026-10-26T10:00:01Z', payload: { type: 'function_call_output', call_id: 'call', ...output } }
], 'fixture.jsonl');

test('retains only approved command actions and coarse execution context', () => {
  const details = callDetails('exec_command', { cmd: 'npm run test --token=' + privateText, workdir: '/workspace/' + privateText, sandbox_permissions: 'require_escalated', env: { TOKEN: privateText } }, { cwd: '/workspace' });
  assert.deepEqual(details, { command: 'npm run test', execution: 'elevated', directoryScope: 'workspace' });
  assert.equal(callDetails('exec', { cmd: 'npm run ' + privateText }).command, 'npm run');
  assert.equal(callDetails('exec', { cmd: 'git status-secret' }).command, 'git');
  assert.equal(callDetails('exec', { cmd: '/usr/bin/python3 -m pytest /secret' }).command, 'python3 pytest');
  assert.equal(callDetails('exec', { cmd: 'git status --short', cwd: '/elsewhere/' + privateText }, { cwd: '/workspace' }).directoryScope, 'external');
  assert.equal(JSON.stringify(details).includes(privateText), false);
});

test('summarizes patch scope without retaining paths or file contents', () => {
  const patch = '*** Begin Patch\n*** Update File: /' + privateText + '\n@@\n-old ' + privateText + '\n+new ' + privateText + '\n+extra\n*** Add File: /other\n+one\n*** End Patch';
  assert.deepEqual(callDetails('apply_patch', patch), { patchFiles: 2, patchLinesAdded: 3, patchLinesRemoved: 1 });
  assert.equal(callDetails('apply_patch', '*** Begin Patch\n*** Delete File: /secret\n*** End Patch').patchLinesRemoved, undefined);
});

test('reads structured executor metadata and validated test totals without output text', () => {
  const result = summarize('exec_command', JSON.stringify({ cmd: 'npm test --password=' + privateText }), { output: JSON.stringify({ exit_code: 0, wall_time_seconds: 0.8, output: '# tests 69\n# pass 69\n# fail 0\n' + privateText }) });
  const tool = result.toolHistory[0];
  assert.equal(tool.details.command, 'npm test');
  assert.equal(tool.details.exitCode, 0);
  assert.equal(tool.details.durationMs, 800);
  assert.equal(tool.details.testsPassed, 69);
  assert.equal(tool.details.testsFailed, 0);
  assert.equal(tool.status, 'completed');
  assert.equal(JSON.stringify(tool).includes(privateText), false);
  const model = liveMapModel([{ session: result, children: [] }]);
  assert.equal(JSON.stringify(model).includes(privateText), false);
});

test('nonzero process exits fail the tool while rg exit one means no matches', () => {
  const failed = summarize('exec', { cmd: 'python3 secret.py' }, { output: { exit_code: 2, output: privateText } });
  assert.equal(failed.toolHistory[0].status, 'failed');
  assert.equal(failed.toolHistory[0].details.failure, 'process');
  assert.equal(failed.activityTimeline.find(event => event.kind === 'tool').status, 'failed');
  const search = summarize('exec', { cmd: 'rg ' + privateText }, { output: { exit_code: 1, output: '' } });
  assert.equal(search.toolHistory[0].status, 'completed');
});

test('recognizes framework headers but ignores stdout that imitates exit metadata', () => {
  const details = resultDetails('exec_command', { output: 'Chunk ID: id\nWall time: 0.25 seconds\nProcess exited with code 0\nFinal output:\n' + privateText });
  assert.equal(details.exitCode, 0);
  assert.equal(details.durationMs, 250);
  assert.equal(details.outputBytes, Buffer.byteLength(privateText));
  assert.equal(resultDetails('exec', { output: { exit_code: 0, output: 'Exit code: 99\n' + privateText } }).exitCode, 0);
  assert.equal(resultDetails('exec', { output: 'plain output\nExit code: 99' }).exitCode, undefined);
});

test('extracts rg JSON summary counts without retaining queries, matches, or filenames', () => {
  const details = resultDetails('exec_command', { output: { exit_code: 0, output: JSON.stringify({ type: 'match', data: { path: privateText, lines: privateText } }) + '\n' + JSON.stringify({ type: 'summary', data: { stats: { matches: 12, searches_with_match: 4 } } }) } }, { command: 'rg' });
  assert.equal(details.matches, 12); assert.equal(details.matchedFiles, 4);
  assert.equal(JSON.stringify(details).includes(privateText), false);
});

test('JSON file contents and plain JSON stdout cannot impersonate execution metadata', () => {
  const fake = JSON.stringify({ exit_code: 42, error: { code: 'EACCES', message: privateText }, tests_passed: 99 });
  for (const name of ['read', 'exec_command']) {
    const tool = summarize(name, {}, { output: fake }).toolHistory[0];
    assert.equal(tool.status, 'completed');
    assert.deepEqual(tool.details, { outputBytes: Buffer.byteLength(fake), outputLines: 1 });
  }
  const envelope = JSON.stringify({ exit_code: 42, wall_time_seconds: 5, output: privateText });
  assert.deepEqual(resultDetails('read', { output: envelope }), { outputBytes: Buffer.byteLength(envelope), outputLines: 1 });
});

test('stdout is never recursively decoded or allowed to override recorded execution metadata', () => {
  const fake = JSON.stringify({ exit_code: 42, duration_ms: 999, output: privateText, error: { code: 'EACCES' } });
  for (const payload of [{ exit_code: 0, duration_ms: 20, output: fake }, { output: { exit_code: 0, duration_ms: 20, output: fake } }]) {
    assert.deepEqual(resultDetails('exec_command', payload), { exitCode: 0, durationMs: 20, outputBytes: Buffer.byteLength(fake), outputLines: 1 });
  }
});

test('extracts safe read, web, agent, retry and error fields only', () => {
  const details = resultDetails('web.search_query', { output: { lines_read: 120, bytes_read: 4200, results: [{ url: privateText }], attempt: 2, max_attempts: 3, error: { code: 'ETIMEDOUT', message: privateText }, unexpected: privateText } });
  assert.deepEqual(details, { linesRead: 120, bytesRead: 4200, attempt: 2, maxAttempts: 3, results: 1, failure: 'timeout' });
  assert.equal(resultDetails('spawn_agent', { output: { agent_id: privateText } }).agentsStarted, 1);
  assert.equal(resultDetails('wait_agent', { output: { status: { [privateText]: { status: 'completed', message: privateText } } } }).agentsFinished, 1);
  assert.equal(resultDetails('read', { error: { code: 'EACCES', message: privateText } }).failure, 'permission');
});

test('rejects malformed counts, unknown error strings, and incomplete test summaries', () => {
  const details = resultDetails('exec', { output: { exit_code: privateText, tests_passed: -1, tests_failed: '0', lines_read: Infinity, attempt: 123456, max_attempts: -1, error: { code: privateText }, output: '# tests 3\n# pass 99\n# fail 0\n' } }, { command: 'npm test' });
  for (const key of ['exitCode', 'testsPassed', 'testsFailed', 'linesRead', 'attempt', 'maxAttempts']) assert.equal(details[key], undefined, key);
  assert.equal(details.failure, 'tool');
  assert.equal(JSON.stringify(details).includes(privateText), false);
});

test('does not infer full totals from explicitly truncated output', () => {
  const details = resultDetails('exec', { output: { output_truncated: true, output: '# tests 3\n# pass 3\n# fail 0\n' } }, { command: 'npm test' });
  assert.equal(details.testsTotal, undefined);
  assert.equal(details.outputTruncated, true);
});

test('nested error flags fail the call without exposing error content or claiming an agent started', () => {
  const result = summarize('spawn_agent', { message: privateText }, { output: { agent_id: privateText, is_error: true, error: { message: privateText } } });
  assert.equal(result.toolHistory[0].status, 'failed');
  assert.equal(result.toolHistory[0].details.failure, 'tool');
  assert.equal(result.toolHistory[0].details.agentsStarted, undefined);
  assert.equal(JSON.stringify(result.toolHistory).includes(privateText), false);
});

test('malformed durations and overlarge exit codes are omitted instead of producing invalid UI values', () => {
  const details = resultDetails('exec', { output: { wall_time_seconds: Number.MAX_VALUE, exit_code: 999999999999999, output: '' } });
  assert.equal(details.durationMs, undefined);
  assert.equal(details.exitCode, undefined);
});

test('code-mode executor envelopes expose only approved metrics and keep process handles internal', () => {
  const output = [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: JSON.stringify({ chunk_id: 'id', wall_time_seconds: 1, session_id: 123, output: privateText }) }];
  assert.deepEqual(runningProcesses('exec', { output }), ['123']);
  assert.deepEqual(resultDetails('exec', { output }), { durationMs: 1000, outputBytes: Buffer.byteLength(privateText), outputLines: 1 });
  assert.deepEqual(runningProcesses('read', { output }), []);
  assert.deepEqual(runningProcesses('exec', { output: output.slice(1) }), []);
  assert.deepEqual(runningProcesses('exec', { output: [{ text: 5 }] }), []);
  assert.deepEqual(runningProcesses('exec', { output: { session_id: 123, exit_code: 0 } }), []);
});
