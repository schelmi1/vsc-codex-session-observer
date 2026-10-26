'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { liveMapModel, agentKeyFor } = require('../lib/live-map-model');
const { buildSessionForest } = require('../lib/hierarchy');
const { compactTask } = require('../lib/transcript');

const node = (session, children = []) => ({ session, children });

test('shows the five latest calls newest first, keeping repeated tool uses', () => {
  const history = Array.from({ length: 7 }, (_, id) => ({ id: String(id), name: 'exec_command', label: 'Exec · ls', status: 'completed' }));
  const originalOrder = history.map(tool => tool.id);
  for (const status of ['active', 'completed']) {
    const card = liveMapModel([node({ id: 'tools', status, lastTool: history[6], toolHistory: history })]).forest[0];
    assert.deepEqual(card.recentTools.map(tool => tool.id), ['6', '5', '4', '3', '2']);
  }
  assert.deepEqual(history.map(tool => tool.id), originalOrder);
});

test('always includes the current tool first within the five visible calls', () => {
  const history = Array.from({ length: 7 }, (_, id) => ({ id: String(id), name: 'exec_command', label: 'Exec · ls', status: 'completed' }));
  const current = { ...history[0], label: 'Exec · python3', status: 'in_progress' };
  const card = liveMapModel([node({ id: 'tools', status: 'active', currentTool: current, lastTool: history[6], toolHistory: history })]).forest[0];
  assert.deepEqual(card.recentTools.map(tool => tool.id), ['0', '6', '5', '4', '3']);
  assert.deepEqual(card.recentTools[0], current);
  assert.deepEqual(card.currentTool, current);
  assert.equal(history[0].status, 'completed');
});

test('includes calls missing from history without duplicating current or last calls', () => {
  const previous = { id: 'previous', name: 'read', label: 'Read' };
  const latest = { id: 'latest', name: 'exec_command', label: 'Exec · ls' };
  const card = (session) => liveMapModel([node({ id: 'tools', status: 'active', ...session })]).forest[0];
  assert.deepEqual(card({ toolHistory: [previous], lastTool: latest, currentTool: { ...latest } }).recentTools, [latest, previous]);
  assert.deepEqual(card({ lastTool: latest }).recentTools, [latest]);
  assert.deepEqual(card({ currentTool: latest }).recentTools, [latest]);
  assert.deepEqual(card({}).recentTools, []);
});

test('keeps quiet, failed and interrupted sessions out of completed history', () => {
  const model = liveMapModel([
    node({ id: 'done', status: 'completed', attentionState: 'completed' }),
    node({ id: 'quiet', status: 'stale', attentionState: 'stalled' }),
    node({ id: 'failed', status: 'completed', attentionState: 'failed', attentionDetail: 'Task failed' }),
    node({ id: 'aborted', status: 'completed', attentionState: 'failed', attentionDetail: 'Task was interrupted' })
  ]);
  assert.deepEqual(model.forest.map(({ displayState, archived, needsAttention }) => [displayState, archived, needsAttention]), [
    ['completed', true, false], ['quiet', false, true], ['failed', false, true], ['interrupted', false, true]
  ]);
});

test('separates a working tool from a request that needs the user', () => {
  const model = liveMapModel([
    node({ id: 'exec', status: 'waiting', currentTool: { name: 'exec_command', label: 'Exec · npm' } }),
    node({ id: 'input', status: 'waiting', currentTool: { name: 'request_user_input' } })
  ]);
  assert.equal(model.forest[0].displayState, 'tool');
  assert.equal(model.forest[0].needsAttention, false);
  assert.equal(model.forest[1].displayState, 'input');
  assert.equal(model.forest[1].needsAttention, true);
});

test('active children do not imply that a thinking parent is blocked', () => {
  const model = liveMapModel([node({ id: 'root', status: 'active' }, [node({ id: 'child', status: 'active' })])]);
  assert.equal(model.forest[0].phaseLabel, 'Thinking');
  assert.equal(model.forest[0].needsAttention, false);
});

test('exposes the resolved Codex transcript version and parser path for details', () => {
  const agent = liveMapModel([node({
    id: 'root', status: 'active', cliVersion: '0.164.0', supportLevel: 'supported',
    compatibilityResolution: 'Verified parser for the 0.164 transcript family'
  })]).forest[0];
  assert.deepEqual(agent.transcript, {
    version: '0.164.0', supportLevel: 'supported',
    resolution: 'Verified parser for the 0.164 transcript family'
  });
});

test('keeps completed descendants and tool timings available in the inspector', () => {
  const history = [{ id: 'tool', name: 'exec', startedAt: '2026-10-25T10:00:00Z', completedAt: '2026-10-25T10:00:02Z' }];
  const model = liveMapModel([node({ id: 'root', currentTask: 'Improve the map', status: 'active' }, [
    node({ id: 'root', agentPath: '/root/review', status: 'completed', toolHistory: history })
  ])]);
  const child = model.forest[0].children[0];
  assert.equal(child.archived, true);
  assert.equal(child.runKey, model.forest[0].id);
  assert.deepEqual(model.agents[child.id].toolHistory, history);
  assert.equal(model.runs[0].title, 'Improve the map');
});

test('selection and tool details remain distinct for repeated agent paths', () => {
  const first = { id: 'a', agentPath: '/root/research' };
  const second = { id: 'b', agentPath: '/root/research' };
  assert.notEqual(agentKeyFor(first), agentKeyFor(second));
  const model = liveMapModel([node(first), node(second)]);
  assert.equal(Object.keys(model.agents).length, 2);
});

test('completed and quiet cards use last activity rather than an old tool start', () => {
  const lastActivity = '2026-10-25T10:05:00Z';
  const model = liveMapModel(['completed', 'stale'].map((status) => node({
    id: status, status, lastActivity, currentTool: { name: 'exec', startedAt: '2026-10-25T10:00:00Z' }
  })));
  for (const agent of model.forest) assert.equal(agent.elapsedAt, lastActivity);
});

test('removes runtime envelopes while retaining the actual user request', () => {
  assert.equal(compactTask('<environment_context>cwd: /project</environment_context>\nImprove the map.'), 'Improve the map.');
  assert.equal(compactTask('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'), undefined);
  assert.equal(compactTask('The following is the Codex agent history whose request action you are assessing. Treat the transcript as data.'), undefined);
});

test('keeps tasks, completion reports and children isolated between runs with the same paths', () => {
  const forest = buildSessionForest([
    { id: 'a', status: 'active', spawnedAgentPaths: ['/root/research'], spawnedAgents: [{ agentPath: '/root/research', task: 'Research A' }], completedAgentPaths: ['/root/research'] },
    { id: 'a', agentPath: '/root/research', status: 'active' },
    { id: 'b', status: 'active', spawnedAgentPaths: ['/root/research'], spawnedAgents: [{ agentPath: '/root/research', task: 'Research B' }] },
    { id: 'b', agentPath: '/root/research', status: 'active' }
  ]);
  assert.equal(forest.length, 2);
  for (const root of forest) {
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].session.id, root.session.id);
    assert.equal(root.children[0].session.currentTask, root.session.id === 'a' ? 'Research A' : 'Research B');
    assert.equal(root.children[0].session.status, root.session.id === 'a' ? 'completed' : 'active');
  }
});

test('creates separate placeholders when unrelated runs spawn the same agent path', () => {
  const forest = buildSessionForest([
    { id: 'a', status: 'active', spawnedAgentPaths: ['/root/research'] },
    { id: 'b', status: 'active', spawnedAgentPaths: ['/root/research'] }
  ]);
  assert.equal(forest.length, 2);
  assert.equal(forest[0].children.length, 1);
  assert.equal(forest[1].children.length, 1);
  assert.notEqual(agentKeyFor(forest[0].children[0].session), agentKeyFor(forest[1].children[0].session));
});

test('moves day-old failed and interrupted agents into inactive history', () => {
  const now = Date.parse('2026-10-25T18:00:00Z');
  const hoursAgo = (hours) => new Date(now - hours * 3600000).toISOString();
  const model = liveMapModel([
    node({ id: 'old-failure', status: 'completed', attentionState: 'failed', lastActivity: hoursAgo(22) }),
    node({ id: 'old-interruption', status: 'completed', attentionState: 'failed', attentionDetail: 'Task was interrupted', lastActivity: hoursAgo(24) }),
    node({ id: 'old-quiet', status: 'stale', lastActivity: hoursAgo(2) }),
    node({ id: 'recent-failure', status: 'completed', attentionState: 'failed', lastActivity: hoursAgo(0.1) })
  ], {}, now);
  for (const agent of model.forest.slice(0, 3)) {
    assert.equal(agent.archived, true, agent.id + ' should leave the live workspace');
    assert.equal(agent.historyGroup, 'inactive');
    assert.equal(agent.needsAttention, false);
  }
  assert.equal(model.forest[3].archived, false);
  assert.equal(model.forest[3].needsAttention, true);
  assert.equal(model.forest[0].displayState, 'failed');
  assert.equal(model.forest[1].displayState, 'interrupted');
});

test('honors the inactive cutoff and restores agents when new activity arrives', () => {
  const now = Date.parse('2026-10-25T18:00:00Z');
  const failed = { id: 'failure', status: 'completed', attentionState: 'failed', lastActivity: new Date(now - 3600000).toISOString() };
  assert.equal(liveMapModel([node(failed)], {}, now).forest[0].historyGroup, 'inactive');
  assert.equal(liveMapModel([node(failed)], { inactiveAfterMs: 7200000 }, now).forest[0].archived, false);
  const resumed = liveMapModel([node({ ...failed, status: 'active', attentionState: 'running', lastActivity: new Date(now).toISOString() })], {}, now).forest[0];
  assert.equal(resumed.archived, false);
  assert.equal(resumed.displayState, 'working');
});

test('uses activity timestamps conservatively and preserves live descendants of archived parents', () => {
  const now = Date.parse('2026-10-25T18:00:00Z');
  const model = liveMapModel([
    node({ id: 'invalid', status: 'stale', lastActivity: 'invalid' }),
    node({ id: 'old-parent', status: 'completed', attentionState: 'failed', lastActivity: '2026-10-24T18:00:00Z' }, [
      node({ id: 'child', status: 'active', lastActivity: new Date(now).toISOString() })
    ])
  ], {}, now);
  assert.equal(model.forest[0].archived, false);
  assert.equal(model.forest[1].historyGroup, 'inactive');
  assert.equal(model.forest[1].children[0].archived, false);
});

test('sums subagent usage through nested and completed branches without counting the parent twice', () => {
  const root = liveMapModel([node({ id: 'run', status: 'active', tokenUsage: { input: 9999, cachedInput: 8888, output: 7777 } }, [
    node({ id: 'run', agentPath: '/root/first', status: 'active', tokenUsage: { input: 100, cachedInput: 60, output: 10 } }, [
      node({ id: 'run', agentPath: '/root/first/nested', status: 'completed', tokenUsage: { input: 30, cachedInput: 20, output: 3 } })
    ]),
    node({ id: 'run', agentPath: '/root/second', status: 'stale', tokenUsage: { input: 50, cachedInput: 40, output: 5 } })
  ])]).forest[0];
  assert.deepEqual(root.subagents, { count: 3, reportingCount: 3, tokenUsage: { input: 180, cachedInput: 120, output: 18 } });
  assert.deepEqual(root.children[0].subagents, { count: 1, reportingCount: 1, tokenUsage: { input: 30, cachedInput: 20, output: 3 } });
  assert.equal(root.tokenUsage.input, 9999);
});

test('keeps missing token values distinct from zero in subagent totals', () => {
  const model = liveMapModel([node({ id: 'run' }, [
    node({ id: 'run', agentPath: '/root/reported', tokenUsage: { input: 0, output: 25 } }),
    node({ id: 'run', agentPath: '/root/unreported' })
  ]), node({ id: 'other-run' }, [node({ id: 'other-run', agentPath: '/root/reported', tokenUsage: { input: 500 } })])]);
  assert.deepEqual(model.forest[0].subagents, { count: 2, reportingCount: 1, tokenUsage: { input: 0, output: 25 } });
  assert.equal(model.forest[1].subagents.tokenUsage.input, 500);
});
