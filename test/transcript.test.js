'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { summarizeTranscript, loadSessions, toolLabel } = require('../lib/transcript');
const { buildSessionForest } = require('../lib/hierarchy');
const { liveMapModel } = require('../lib/live-map-model');

const meta = { type: 'session_meta', timestamp: '2026-10-24T10:00:00Z', payload: { session_id: 'root', cwd: '/project', cli_version: '0.162.0-alpha.17.2' } };

test('reports a completed 0.162 transcript', () => {
  const result = summarizeTranscript([meta, { type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } }, { type: 'event_msg', timestamp: '2026-10-24T10:02:00Z', payload: { type: 'task_complete' } }], 'fixture.jsonl');
  assert.equal(result.status, 'completed');
  assert.equal(result.attentionState, 'completed');
  assert.equal(result.id, 'root');
});

test('a newly started turn clears an older failure attention state', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'old', name: 'exec' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'old', status: 'failed' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'event_msg', payload: { type: 'task_started' } }
  ], 'fixture.jsonl');
  assert.equal(result.attentionState, 'running');
});

test('shows a terminal task error as failed rather than completed', () => {
  const result = summarizeTranscript([meta, { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'event_msg', payload: { type: 'task_complete', error: { message: 'model unavailable' } } }], 'fixture.jsonl');
  assert.equal(result.status, 'completed');
  assert.equal(result.attentionState, 'failed');
  assert.match(result.attentionDetail, /model unavailable/);
});

test('does not show an earlier failed tool as failed after normal completion', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', status: 'failed' } },
    { type: 'event_msg', payload: { type: 'task_complete' } }
  ], 'fixture.jsonl');
  assert.equal(result.attentionState, 'completed');
  assert.equal(result.toolHistory[0].status, 'failed');
});

test('captures the latest meaningful user task in compact form', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignored</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '  Inspect   the parser\nthen report the result.  ' }] } }
  ], 'fixture.jsonl');
  assert.equal(result.currentTask, 'Inspect the parser then report the result.');
});

test('keeps compact assistant progress separate from the original task', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'response_item', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a session observer.' }] } },
    { type: 'response_item', timestamp: '2026-10-24T10:02:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I am inspecting the transcript parser and will add a compact progress field.' }] } }
  ], 'fixture.jsonl');
  assert.equal(result.currentTask, 'Build a session observer.');
  assert.deepEqual(result.currentProgress, { text: 'I am inspecting the transcript parser and will add a compact progress field.', timestamp: '2026-10-24T10:02:00Z', source: 'assistant' });
});

test('captures cumulative input, cached-input, and output token usage', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'token_usage_record', payload: { usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 2 }, thread_token_usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 55 } } }
  ], 'fixture.jsonl');
  assert.deepEqual(result.tokenUsage, { input: 1200, cachedInput: 900, output: 55 });
});

test('uses the latest concise timeline event when there is no assistant commentary', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: '2026-10-24T10:02:00Z', payload: { type: 'function_call', call_id: 'call-1', name: 'exec' } },
    { type: 'response_item', timestamp: '2026-10-24T10:03:00Z', payload: { type: 'function_call_output', call_id: 'call-1', output: 'done' } }
  ], 'fixture.jsonl');
  assert.deepEqual(result.currentProgress, { text: 'Finished tool: exec', timestamp: '2026-10-24T10:03:00Z', source: 'tool' });
});

test('reports a running tool as waiting, not completed', () => {
  const result = summarizeTranscript([meta, { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'functions.exec', status: 'in_progress' } }], 'fixture.jsonl');
  assert.equal(result.status, 'waiting');
  assert.equal(result.lastTool.name, 'functions.exec');
  assert.equal(result.currentTool.name, 'functions.exec');
  assert.equal(result.attentionState, 'waiting');
  assert.match(result.attentionDetail, /Waiting for tool/);
});

test('only reports input/approval waiting when the outstanding tool proves it', () => {
  const result = summarizeTranscript([meta, { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'response_item', payload: { type: 'function_call', call_id: 'input-1', name: 'request_user_input' } }], 'fixture.jsonl');
  assert.equal(result.attentionState, 'waiting');
  assert.match(result.attentionDetail, /Awaiting input or approval/);
});

test('treats a function call without output as a running tool', () => {
  const result = summarizeTranscript([meta, { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec' } }], 'fixture.jsonl');
  assert.equal(result.status, 'waiting');
  assert.equal(result.currentTool.name, 'exec');
});

test('clears a function tool once its matching output is recorded', () => {
  const result = summarizeTranscript([meta, { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec' } }, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'done' } }], 'fixture.jsonl');
  assert.equal(result.status, 'active');
  assert.equal(result.currentTool, undefined);
  assert.deepEqual(result.toolHistory[0], { id: 'call-1', name: 'exec', label: 'Exec', status: 'completed', timestamp: undefined, startedAt: undefined, completedAt: undefined, details: { outputBytes: 4, outputLines: 1 } });
});

test('builds a compact activity timeline without tool contents', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: '2026-10-24T10:02:00Z', payload: { type: 'function_call', call_id: 'tool-1', name: 'exec' } },
    { type: 'response_item', timestamp: '2026-10-24T10:03:00Z', payload: { type: 'function_call_output', call_id: 'tool-1', output: 'private output' } },
    { type: 'response_item', timestamp: '2026-10-24T10:04:00Z', payload: { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-1', arguments: '{"task_name":"research"}' } },
    { type: 'response_item', timestamp: '2026-10-24T10:05:00Z', payload: { type: 'function_call_output', call_id: 'spawn-1', output: '{"task_name":"/root/research"}' } },
    { type: 'event_msg', timestamp: '2026-10-24T10:06:00Z', payload: { type: 'task_complete' } }
  ], 'fixture.jsonl');
  assert.deepEqual(result.activityTimeline, [
    { kind: 'task', label: 'Task started', timestamp: '2026-10-24T10:01:00Z' },
    { kind: 'tool', label: 'exec', status: 'completed', timestamp: '2026-10-24T10:02:00Z', completedAt: '2026-10-24T10:03:00Z' },
    { kind: 'tool', label: 'spawn_agent', status: 'completed', timestamp: '2026-10-24T10:04:00Z', completedAt: '2026-10-24T10:05:00Z' },
    { kind: 'delegation', label: 'Delegated to research', timestamp: '2026-10-24T10:05:00Z', target: '/root/research' },
    { kind: 'completed', label: 'Task completed', timestamp: '2026-10-24T10:06:00Z' }
  ]);
});

test('captures private-safe timing and failure information for a tool', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'function_call', call_id: 'call-1', name: 'exec' } },
    { type: 'response_item', timestamp: '2026-10-24T10:01:04Z', payload: { type: 'function_call_output', call_id: 'call-1', status: 'failed', output: 'private command output' } }
  ], 'fixture.jsonl');
  assert.deepEqual(result.toolHistory[0], {
    id: 'call-1', name: 'exec', label: 'Exec', status: 'failed',
    timestamp: '2026-10-24T10:01:00Z', startedAt: '2026-10-24T10:01:00Z', completedAt: '2026-10-24T10:01:04Z', details: { outputBytes: 22, outputLines: 1, failure: 'tool' }
  });
  assert.equal(JSON.stringify(result.toolHistory[0]).includes('private command output'), false);
  assert.equal(result.attentionState, 'failed');
  assert.match(result.attentionDetail, /Last tool failed: exec/);
});

test('uses privacy-safe labels for native tools and exec command categories', () => {
  assert.equal(toolLabel('view_image'), 'View image');
  assert.equal(toolLabel('read'), 'Read');
  assert.equal(toolLabel('exec', '{"cmd":"git status --short"}'), 'Exec · git');
  assert.equal(toolLabel('exec', '{"cmd":"rg secret src"}'), 'Exec · rg');
  assert.equal(toolLabel('exec', '{"cmd":"echo a-token"}'), 'Exec');
  assert.equal(toolLabel('functions.exec_command', { cmd: 'ls -la /private/path' }), 'Exec · ls');
  assert.equal(toolLabel('functions.exec', 'const result = await tools.exec_command({cmd: "python3 /private/script.py"});'), 'Exec · python3');
});

test('marks an unrecognized future transcript schema unsupported', () => {
  const result = summarizeTranscript([{ ...meta, payload: { ...meta.payload, cli_version: '0.163.0' } }], 'fixture.jsonl');
  assert.equal(result.supportLevel, 'unsupported');
  assert.match(result.unsupportedReason, /Unrecognized Codex transcript schema/);
});

test('parses recognizable newer transcripts in best-effort mode through generic tool adapters', () => {
  const newerMeta = { ...meta, payload: { ...meta.payload, cli_version: '0.170.0' } };
  const result = summarizeTranscript([
    newerMeta,
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'tool_call', tool_call_id: 'image-1', function: { name: 'view_image', arguments: '{}' }, status: 'in_progress' } },
    { type: 'response_item', payload: { type: 'tool_output', tool_call_id: 'image-1', status: 'completed' } }
  ], 'fixture.jsonl');
  assert.equal(result.supportLevel, 'best_effort');
  assert.match(result.compatibilityDetail, /unverified Codex transcript version 0\.170\.0/);
  assert.equal(result.unsupportedReason, undefined);
  assert.equal(result.status, 'active');
  assert.equal(result.currentTool, undefined);
  assert.equal(result.toolHistory[0].label, 'View image');
});

test('supports the 0.164 transcript family', () => {
  for (const cli_version of ['0.164.0', '0.164.0-alpha.11.1']) {
    const v164Meta = { ...meta, payload: { ...meta.payload, cli_version } };
    const result = summarizeTranscript([v164Meta, { type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } }, { type: 'event_msg', timestamp: '2026-10-24T10:02:00Z', payload: { type: 'task_complete' } }], 'fixture.jsonl');
    assert.equal(result.unsupportedReason, undefined);
    assert.equal(result.status, 'completed');
    assert.equal(result.cliVersion, cli_version);
  }
});

test('keeps a last-activity timestamp on unsupported transcripts', () => {
  const stat = { mtime: new Date('2026-10-24T10:00:00Z') };
  const result = summarizeTranscript([{ ...meta, payload: { ...meta.payload, cli_version: '0.163.0' } }], 'fixture.jsonl', stat);
  assert.equal(result.lastActivity, '2026-10-24T10:00:00.000Z');
});

test('a self-parented session is not considered a child', () => {
  const tree = buildSessionForest([{ id: 'root', parentId: 'root' }]);
  assert.deepEqual(tree.map((node) => node.session.id), ['root']);
  assert.equal(tree[0].children.length, 0);
});

test('a multi-session parent cycle is rendered as independent roots', () => {
  const tree = buildSessionForest([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]);
  assert.deepEqual(tree.map((node) => node.session.id).sort(), ['a', 'b']);
});

test('prefers a real session rollout over an unknown auxiliary fragment', () => {
  const tree = buildSessionForest([
    { id: 'root', status: 'unknown', lastActivity: '2026-10-24T10:02:00Z' },
    { id: 'root', status: 'active', lastActivity: '2026-10-24T10:01:00Z' }
  ]);
  assert.equal(tree[0].session.status, 'active');
});

test('internal guardian reviews cannot replace a running tool or appear as user agents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-guardian-'));
  const write = (name, records) => fs.writeFileSync(path.join(root, 'rollout-' + name + '.jsonl'), records.map(record => JSON.stringify(record)).join('\n'));
  const started = { type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } };
  const finished = { type: 'event_msg', timestamp: '2026-10-24T10:02:00Z', payload: { type: 'task_complete' } };
  try {
    write('main', [meta, started, { type: 'response_item', timestamp: started.timestamp, payload: { type: 'custom_tool_call', name: 'exec', input: 'python3 simulation.py', call_id: 'running', status: 'completed' } }]);
    for (const id of ['root', 'independent-review']) write('guardian-' + id, [
      { ...meta, payload: { ...meta.payload, session_id: id, parent_thread_id: 'root', source: { subagent: { other: 'guardian' } } } }, started, finished
    ]);
    write('reviewer', [{ ...meta, payload: { ...meta.payload, session_id: 'reviewer', parent_thread_id: 'root', agent_path: '/root/reviewer', source: { subagent: { other: 'custom' } } } }, started]);
    const sessions = loadSessions(root, undefined, Date.parse(finished.timestamp));
    assert.equal(sessions.length, 2);
    const card = liveMapModel(buildSessionForest(sessions)).forest[0];
    assert.equal(card.displayState, 'tool');
    assert.equal(card.phaseLabel, 'Using Exec · python3');
    assert.equal(card.currentTool.id, 'running');
    assert.equal(card.children.length, 1);
    assert.equal(card.children[0].agentPath, '/root/reviewer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keeps dormant child agents nested under a running root from another rollout fragment', () => {
  const tree = buildSessionForest([
    { id: 'root', status: 'active', lastActivity: '2026-10-24T10:02:00Z' },
    { id: 'root', status: 'completed', spawnedAgentPaths: ['/root/dormant'], lastActivity: '2026-10-24T10:01:00Z' },
    { id: 'root', agentPath: '/root/dormant', status: 'stale' }
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].session.status, 'active');
  assert.equal(tree[0].children[0].session.agentPath, '/root/dormant');
});

test('attaches a self-parented subagent to the root with its shared session id', () => {
  const tree = buildSessionForest([
    { id: 'first-root', status: 'active', spawnedAgentPaths: ['/root/unrelated'] },
    { id: 'second-root', status: 'active' },
    { id: 'second-root', parentId: 'second-root', agentPath: '/root/child', status: 'stale' }
  ]);
  const second = tree.find((node) => node.session.id === 'second-root');
  assert.equal(second.children[0].session.agentPath, '/root/child');
});

test('links an agent transcript to the parent spawn event', () => {
  const tree = buildSessionForest([
    { id: 'parent', spawnedAgentPaths: ['/root/research'] },
    { id: 'child', agentPath: '/root/research' }
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].session.id, 'parent');
  assert.equal(tree[0].children[0].session.id, 'child');
});

test('extracts a canonical spawned-agent path', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'response_item', payload: { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-1', arguments: '{"task_name":"research"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn-1', output: '{"task_name":"/root/research"}' } }
  ], 'fixture.jsonl');
  assert.deepEqual(result.spawnedAgentPaths, ['/root/research']);
});

test('shows a child the parent-assigned subtask instead of inherited root task', () => {
  const result = summarizeTranscript([
    meta,
    { type: 'response_item', payload: { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-1', arguments: '{"task_name":"research","message":"Inspect parser edge cases."}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn-1', output: '{"task_name":"/root/research"}' } }
  ], 'fixture.jsonl');
  const tree = buildSessionForest([{ id: 'root', spawnedAgentPaths: result.spawnedAgentPaths, spawnedAgents: result.spawnedAgents }, { id: 'root', agentPath: '/root/research', currentTask: 'Inherited root task' }]);
  assert.equal(tree[0].children[0].session.currentTask, 'Inspect parser edge cases.');
});

test('shows a starting agent before its transcript exists', () => {
  const tree = buildSessionForest([{ id: 'parent', spawnedAgentPaths: ['/root/research'] }]);
  assert.equal(tree[0].children[0].session.status, 'starting');
  assert.equal(tree[0].children[0].session.agentName, 'research');
});

test('uses an explicit final child report to complete an otherwise placeholder agent', () => {
  const result = summarizeTranscript([meta, { type: 'response_item', payload: { type: 'agent_message', author: '/root/research', message_type: 'FINAL_ANSWER' } }], 'fixture.jsonl');
  const tree = buildSessionForest([{ id: 'parent', spawnedAgentPaths: ['/root/research'], completedAgentPaths: result.completedAgentPaths }]);
  assert.equal(tree[0].children[0].session.status, 'completed');
  assert.equal(tree[0].children[0].session.completionSource, 'agent_report');
});

test('parses nested-agent relay messages without completing the reporting parent', () => {
  const result = summarizeTranscript([meta, { type: 'response_item', payload: { type: 'agent_message', author: '/root/parent', content: [{ type: 'input_text', text: '[codex-observer] spawn /root/parent/child\n[codex-observer] complete /root/parent/child' }] } }], 'fixture.jsonl');
  assert.deepEqual(result.completedAgentPaths, []);
  assert.deepEqual(result.agentReports[0], { agentPath: '/root/parent', spawnedAgentPaths: ['/root/parent/child'], completedAgentPaths: ['/root/parent/child'] });
});

test('renders relayed agents recursively below their reporting parent', () => {
  const tree = buildSessionForest([{ id: 'root', spawnedAgentPaths: ['/root/parent'], agentReports: [{ agentPath: '/root/parent', spawnedAgentPaths: ['/root/parent/child'], completedAgentPaths: [] }] }]);
  assert.equal(tree[0].children[0].session.agentPath, '/root/parent');
  assert.equal(tree[0].children[0].children[0].session.agentPath, '/root/parent/child');
});

test('uses canonical task paths to nest spawns recorded in one root transcript', () => {
  const tree = buildSessionForest([{ id: 'root', spawnedAgentPaths: ['/root/parent', '/root/parent/child'] }]);
  assert.equal(tree[0].children[0].session.agentPath, '/root/parent');
  assert.equal(tree[0].children[0].children[0].session.agentPath, '/root/parent/child');
});

test('a parent completion report overrides a stale child rollout state', () => {
  const tree = buildSessionForest([
    { id: 'root', spawnedAgentPaths: ['/root/child'], completedAgentPaths: ['/root/child'] },
    { id: 'root', agentPath: '/root/child', status: 'active' }
  ]);
  assert.equal(tree[0].children[0].session.status, 'completed');
});

test('keeps live sessions above completed sessions, newest first within each group', () => {
  const tree = buildSessionForest([
    { id: 'old-live', status: 'active', lastActivity: '2026-10-24T10:00:00Z' },
    { id: 'new-live', status: 'waiting', lastActivity: '2026-10-24T11:00:00Z' },
    { id: 'new-complete', status: 'completed', lastActivity: '2026-10-24T12:00:00Z' },
    { id: 'old-complete', status: 'completed', lastActivity: '2026-10-24T09:00:00Z' }
  ]);
  assert.deepEqual(tree.map((node) => node.session.id), ['new-live', 'old-live', 'new-complete', 'old-complete']);
});

test('shows a completed parent as delegating while a child remains live', () => {
  const tree = buildSessionForest([{ id: 'root', status: 'completed', spawnedAgentPaths: ['/root/child'] }, { id: 'root', agentPath: '/root/child', status: 'active' }]);
  assert.equal(tree[0].session.status, 'delegating');
});

test('marks an interrupted, quiet transcript stale instead of live', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-test-'));
  const file = path.join(root, 'rollout-fixture.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify({ type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } })}\n`);
  try {
    const [session] = loadSessions(root, 60000, Date.parse('2026-10-24T10:03:00Z'));
    assert.equal(session.status, 'stale');
    assert.equal(session.attentionState, 'stalled');
    assert.match(session.staleReason, /120 seconds/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allows normal quiet gaps before the default stalled timeout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-test-'));
  const file = path.join(root, 'rollout-fixture.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify({ type: 'event_msg', timestamp: '2026-10-24T10:01:00Z', payload: { type: 'task_started' } })}\n`);
  try {
    const [session] = loadSessions(root, undefined, Date.parse('2026-10-24T10:10:00Z'));
    assert.equal(session.status, 'active');
    assert.equal(session.attentionState, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps a just-completed run live for five seconds so parallel runs do not jump', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-observer-completion-grace-'));
  const write = (name, records) => fs.writeFileSync(path.join(root, `rollout-${name}.jsonl`), records.map(record => JSON.stringify(record)).join('\n'));
  const completed = { type: 'event_msg', timestamp: '2026-10-24T10:00:01Z', payload: { type: 'task_complete' } };
  const stillWorking = { type: 'event_msg', timestamp: '2026-10-24T10:00:00.500Z', payload: { type: 'task_started' } };
  try {
    write('just-completed', [{ ...meta, payload: { ...meta.payload, session_id: 'just-completed' } }, { type: 'event_msg', timestamp: meta.timestamp, payload: { type: 'task_started' } }, completed]);
    write('still-working', [{ ...meta, payload: { ...meta.payload, session_id: 'still-working' } }, stillWorking]);

    const duringGrace = loadSessions(root, undefined, Date.parse('2026-10-24T10:00:05.999Z'));
    assert.deepEqual(buildSessionForest(duringGrace).map(node => node.session.id), ['just-completed', 'still-working']);
    const pending = liveMapModel(buildSessionForest(duringGrace)).forest[0];
    assert.equal(pending.status, 'active');
    assert.equal(pending.phaseLabel, 'Waiting for next heartbeat');

    const afterGrace = loadSessions(root, undefined, Date.parse('2026-10-24T10:00:06Z'));
    assert.deepEqual(buildSessionForest(afterGrace).map(node => node.session.id), ['still-working', 'just-completed']);
    assert.equal(afterGrace.find(session => session.id === 'just-completed').status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale descendant does not keep a completed parent delegating', () => {
  const tree = buildSessionForest([{ id: 'root', status: 'completed', spawnedAgentPaths: ['/root/child'] }, { id: 'root', agentPath: '/root/child', status: 'stale' }]);
  assert.equal(tree[0].session.status, 'completed');
});
