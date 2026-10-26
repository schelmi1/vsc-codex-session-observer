'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTranscript } = require('../lib/transcript');
const { buildSessionForest } = require('../lib/hierarchy');
const { liveMapModel } = require('../lib/live-map-model');
const meta = { type: 'session_meta', timestamp: '2026-10-25T10:00:00Z', payload: { session_id: 'run', cli_version: '0.164.0', cwd: '/project' } };
const event = (type, turn_id, timestamp = '2026-10-25T10:00:00Z') => ({ type: 'event_msg', timestamp, payload: { type, turn_id } });

test('a progress message does not move a working reviewer into completed history', () => {
  const parent = summarizeTranscript([
    meta, event('task_started', 'parent'),
    { type: 'response_item', payload: { type: 'agent_message', author: '/root/reviewer', message_type: 'MESSAGE', content: [{ type: 'input_text', text: 'I am still reviewing.' }] } }
  ], 'parent.jsonl');
  assert.deepEqual(parent.completedAgentPaths, []);
  const forest = buildSessionForest([
    { ...parent, spawnedAgentPaths: ['/root/reviewer'] },
    { id: 'run', agentPath: '/root/reviewer', status: 'active' }
  ]);
  assert.equal(forest[0].children[0].session.status, 'active');
});

test('a forked child completes its own turn despite an inherited unfinished parent turn', () => {
  const child = summarizeTranscript([
    { ...meta, payload: { ...meta.payload, agent_path: '/root/reviewer' } },
    event('task_started', 'parent'), event('task_started', 'child'), event('task_complete', 'child')
  ], 'child.jsonl');
  assert.equal(child.status, 'completed');
});

test('an unrelated completion does not terminate the current turn', () => {
  const child = summarizeTranscript([
    meta, event('task_started', 'parent'), event('task_started', 'child'),
    event('task_complete', 'parent'), event('task_complete', 'parent')
  ], 'child.jsonl');
  assert.equal(child.status, 'active');
});

test('aborted tools and input requests do not leak into the next turn', () => {
  for (const name of ['exec', 'request_user_input']) {
    const result = summarizeTranscript([
      meta, event('task_started', 'first'),
      { type: 'response_item', payload: { type: 'function_call', call_id: 'unfinished', name } },
      event('turn_aborted', 'first'), event('task_started', 'second')
    ], 'fixture.jsonl');
    assert.equal(result.status, 'active', name);
    assert.equal(result.currentTool, undefined, name);
    assert.equal(result.attentionState, 'running', name);
  }
});

test('completed tasks do not retain outstanding tools', () => {
  const result = summarizeTranscript([
    meta, event('task_started', 'first'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'unfinished', name: 'exec' } },
    event('task_complete', 'first')
  ], 'fixture.jsonl');
  assert.equal(result.currentTool, undefined);
});

const agentMessage = (type, timestamp, extra = '') => ({ type: 'response_item', timestamp, payload: {
  type: 'agent_message', author: '/root/reviewer', content: [{ type: 'input_text', text: `Message Type: ${type}\nTask name: /root\nSender: /root/reviewer\nPayload:\n${extra}` }]
} });
const childAt = (timestamp, ...events) => summarizeTranscript([
  { ...meta, payload: { ...meta.payload, agent_path: '/root/reviewer' } }, event('task_started', 'child', timestamp), ...events
], 'child.jsonl');
const forestFor = (parent, child) => buildSessionForest([{ ...parent, spawnedAgentPaths: ['/root/reviewer'] }, ...(child ? [child] : [])]);

test('explicit final envelopes complete placeholders, while untyped messages do not', () => {
  const final = summarizeTranscript([meta, agentMessage('FINAL_ANSWER', '2026-10-25T10:01:00Z', 'Review complete.')], 'parent.jsonl');
  assert.deepEqual(final.completedAgentPaths, ['/root/reviewer']);
  assert.equal(forestFor(final)[0].children[0].session.status, 'completed');
  const untyped = summarizeTranscript([meta, { type: 'response_item', payload: { type: 'agent_message', author: '/root/reviewer', content: 'An ordinary message mentioning Message Type: FINAL_ANSWER in its body.' } }], 'parent.jsonl');
  assert.deepEqual(untyped.completedAgentPaths, []);
});

test('an older final report cannot complete a resumed child', () => {
  const parent = summarizeTranscript([meta, agentMessage('FINAL_ANSWER', '2026-10-25T10:01:00Z')], 'parent.jsonl');
  const child = childAt('2026-10-25T10:05:00Z');
  assert.equal(forestFor(parent, child)[0].children[0].session.status, 'active');
});

test('a newer explicit final report can close an unfinished child rollout', () => {
  const parent = summarizeTranscript([meta, agentMessage('FINAL_ANSWER', '2026-10-25T10:02:00Z')], 'parent.jsonl');
  const child = childAt('2026-10-25T10:01:00Z');
  assert.equal(forestFor(parent, child)[0].children[0].session.status, 'completed');
});

test('new progress invalidates old completion even across parent rollout fragments', () => {
  const old = summarizeTranscript([meta, agentMessage('FINAL_ANSWER', '2026-10-25T10:01:00Z')], 'old.jsonl');
  const recent = summarizeTranscript([meta, agentMessage('MESSAGE', '2026-10-25T10:05:00Z')], 'recent.jsonl');
  for (const sessions of [[recent, old], [old, recent]]) {
    const forest = buildSessionForest(sessions.map((session) => ({ ...session, spawnedAgentPaths: ['/root/reviewer'] })));
    assert.equal(forest[0].children[0].session.status, 'active');
  }
});

test('an unconfirmed completion report cannot override a recorded child failure', () => {
  const parent = summarizeTranscript([meta, agentMessage('FINAL_ANSWER', '2026-10-25T10:02:00Z')], 'parent.jsonl');
  const child = childAt('2026-10-25T10:00:00Z', event('turn_aborted', 'child', '2026-10-25T10:01:00Z'));
  assert.equal(forestFor(parent, child)[0].children[0].session.attentionState, 'failed');
});

test('fork boundaries exclude inherited tools, lifecycle and progress before the local turn begins', () => {
  const inherited = [
    { ...meta, payload: { ...meta.payload, agent_path: '/root/reviewer', subagent_history_start_ordinal: 4 } },
    meta, event('task_started', 'parent'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'parent-tool', name: 'exec' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Old parent progress' } }
  ];
  const beforeStart = summarizeTranscript(inherited, 'child.jsonl');
  assert.equal(beforeStart.status, 'unknown');
  assert.equal(beforeStart.currentTool, undefined);
  assert.equal(beforeStart.currentProgress, undefined);
  assert.deepEqual(beforeStart.toolHistory, []);
  const completed = summarizeTranscript([...inherited, event('task_started', 'child'), event('task_complete', 'child')], 'child.jsonl');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.currentTool, undefined);
});

test('a delayed terminal event for another turn leaves current tools running', () => {
  const result = summarizeTranscript([
    meta, event('task_started', 'old'), event('task_started', 'new'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'new-tool', name: 'exec' } },
    event('turn_aborted', 'old')
  ], 'fixture.jsonl');
  assert.equal(result.status, 'waiting');
  assert.equal(result.currentTool.id, 'new-tool');
  assert.equal(result.attentionDetail, 'Waiting for tool: exec');
});

test('custom tool calls without a status remain running until their output arrives', () => {
  const records = [meta, event('task_started', 'turn'), { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call', name: 'functions.exec' } }];
  assert.equal(summarizeTranscript(records, 'fixture.jsonl').status, 'waiting');
  assert.equal(summarizeTranscript([...records, { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call' } }], 'fixture.jsonl').status, 'active');
});

test('completed call envelopes keep the card on tool use until the execution result arrives', () => {
  for (const type of ['custom_tool_call', 'function_call', 'tool_call']) {
    const records = [meta, event('task_started', 'turn'), { type: 'response_item', timestamp: '2026-10-25T10:00:00Z', payload: {
      type, call_id: 'slow-call', name: 'exec', status: 'completed', input: 'python3 simulation.py'
    } }];
    const cardAt = timestamp => liveMapModel(buildSessionForest([summarizeTranscript(records, 'fixture.jsonl')]), {}, Date.parse(timestamp)).forest[0];
    for (const seconds of ['00', '05', '15', '30']) {
      const card = cardAt('2026-10-25T10:00:' + seconds + 'Z');
      assert.equal(card.displayState, 'tool', type);
      assert.equal(card.phaseLabel, 'Using Exec · python3', type);
      assert.equal(card.currentTool.status, 'in_progress', type);
      assert.equal(card.recentTools[0].id, 'slow-call', type);
    }
    records.push({ type: 'response_item', timestamp: '2026-10-25T10:00:30Z', payload: {
      type: type === 'custom_tool_call' ? 'custom_tool_call_output' : type === 'tool_call' ? 'tool_output' : 'function_call_output',
      call_id: 'slow-call', output: 'Simulation finished'
    } });
    const finished = cardAt('2026-10-25T10:00:31Z');
    assert.equal(finished.phaseLabel, 'Thinking', type);
    assert.equal(finished.currentTool, undefined, type);
    assert.equal(finished.recentTools[0].status, 'completed', type);
  }
});

test('a yielded process stays current until its native execution completion arrives', () => {
  const records = [meta, event('task_started', 'turn'),
    { type: 'response_item', timestamp: meta.timestamp, payload: { type: 'custom_tool_call', call_id: 'slow', name: 'exec', status: 'completed', input: 'python3 simulation.py' } },
    { type: 'response_item', timestamp: '2026-10-25T10:00:01Z', payload: { type: 'custom_tool_call_output', call_id: 'slow', output: [
      { type: 'input_text', text: 'Script completed' },
      { type: 'input_text', text: JSON.stringify({ chunk_id: 'abc', wall_time_seconds: 1, session_id: 75573, output: 'Tool active: 1/10 seconds' }) }
    ] } }
  ];
  const card = () => liveMapModel(buildSessionForest([summarizeTranscript(records, 'simulation.jsonl')])).forest[0];
  assert.equal(card().phaseLabel, 'Using Exec · python3');
  assert.equal(card().currentTool.status, 'in_progress');
  assert.equal(card().currentTool.completedAt, undefined);
  assert.equal(card().activityTimeline.find(item => item.kind === 'tool').completedAt, undefined);
  assert.equal(JSON.stringify(card()).includes('75573'), false, 'process handles stay private');
  records.push({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', process_id: 'other', status: 'completed', exit_code: 0 } } });
  assert.equal(card().phaseLabel, 'Using Exec · python3');
  records.push({ type: 'event_msg', timestamp: '2026-10-25T10:00:10Z', payload: { type: 'item_completed', item: { type: 'CommandExecution', process_id: '75573', status: 'completed', exit_code: 0, duration: { secs: 10, nanos: 0 }, aggregated_output: 'PRIVATE OUTPUT' } } });
  assert.equal(card().phaseLabel, 'Thinking');
  assert.equal(card().currentTool, undefined);
  assert.equal(card().toolHistory[0].details.durationMs, 10000);
  assert.equal(card().toolHistory[0].status, 'completed');
  assert.equal(JSON.stringify(card()).includes('PRIVATE OUTPUT'), false);
});

test('yielded processes survive polling, wait for all completions, and clear at a turn boundary', () => {
  const records = [meta, event('task_started', 'turn'),
    { type: 'response_item', payload: { type: 'function_call', call_id: 'work', name: 'exec_command', arguments: { cmd: 'python3 simulation.py' } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'work', output: { session_id: 101 } } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'poll', name: 'write_stdin' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'poll', output: { session_id: 101 } } }
  ];
  const summary = () => summarizeTranscript(records, 'fixture.jsonl');
  assert.equal(summary().currentTool.id, 'work');
  assert.equal(summary().toolHistory[1].status, 'completed');
  const completion = (process_id, exit_code) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', process_id, exit_code, status: 'completed' } } });
  records.push(completion('101', 2));
  assert.equal(summary().currentTool, undefined);
  assert.equal(summary().toolHistory[0].status, 'failed');
  records.push(event('task_started', 'next'),
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'parallel', name: 'exec' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'parallel', output: [
      { type: 'input_text', text: 'Script completed' },
      ...[201, 202].map(session_id => ({ type: 'input_text', text: JSON.stringify({ chunk_id: 'batch', wall_time_seconds: 1, session_id, output: '' }) }))
    ] } }, completion('201', 0));
  assert.equal(summary().currentTool.id, 'parallel');
  records.push(event('turn_aborted', 'next'), event('task_started', 'last'), completion('202', 0));
  assert.equal(summary().currentTool, undefined);
  assert.equal(summary().toolHistory.at(-1).status, 'cancelled');
});

test('a final response can report nested completions and finish its own agent', () => {
  const result = summarizeTranscript([meta, agentMessage('FINAL_ANSWER', '2026-10-25T10:02:00Z', '[codex-observer] complete /root/reviewer/nested')], 'parent.jsonl');
  assert.deepEqual(result.completedAgentPaths, ['/root/reviewer']);
  assert.equal(result.agentObservations.find((item) => item.agentPath === '/root/reviewer/nested').status, 'completed');
});
