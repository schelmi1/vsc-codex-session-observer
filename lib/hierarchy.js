'use strict';

const path = require('node:path');

function compareSessions(left, right) {
  const leftInactive = ['completed', 'stale'].includes(left.status);
  const rightInactive = ['completed', 'stale'].includes(right.status);
  if (leftInactive !== rightInactive) return leftInactive ? 1 : -1;
  return String(right.lastActivity || '').localeCompare(String(left.lastActivity || ''));
}

// Build a forest from transcript metadata without trusting parent_thread_id.
// Codex 0.162 can emit self-parented session metadata, and interrupted
// subagents may leave larger cycles. Those sessions are safely shown as roots.
function buildSessionForest(sessions) {
  // Agent paths repeat between runs. Resolve each connected run separately so
  // its task assignments, completion reports and placeholders remain local.
  const keys = sessions.map((session, index) => session.id || session.file || `anonymous:${index}`);
  const parents = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root);
    while (key !== root) { const next = parents.get(key); parents.set(key, root); key = next; }
    return root;
  };
  const join = (left, right) => parents.set(find(left), find(right));
  sessions.forEach((session, index) => {
    if (session.parentId && parents.has(session.parentId)) join(keys[index], session.parentId);
  });
  const owners = new Map();
  sessions.forEach((session, index) => {
    const paths = [...(session.spawnedAgentPaths || []), ...(session.agentReports || []).flatMap((report) => report.spawnedAgentPaths || [])];
    for (const agentPath of paths) {
      if (!owners.has(agentPath)) owners.set(agentPath, new Set());
      owners.get(agentPath).add(keys[index]);
    }
  });
  sessions.forEach((session, index) => {
    const candidates = new Set([...(owners.get(session.agentPath) || [])].map(find));
    if (candidates.size === 1) join(keys[index], [...candidates][0]);
  });
  const groups = new Map();
  sessions.forEach((session, index) => {
    const key = find(keys[index]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  });
  return [...groups.values()].flatMap(buildSessionForestGroup).sort((left, right) => compareSessions(left.session, right.session));
}

function buildSessionForestGroup(sessions) {
  // A multi-agent Codex run shares a session_id across rollout files. The
  // agent_path is therefore part of an observer node's identity.
  const byNodeKey = new Map();
  for (const session of sessions) {
    const nodeKey = `${session.id || session.file}\u0000${session.agentPath || ''}`;
    const existing = byNodeKey.get(nodeKey);
    // Codex can write a short guardian/auxiliary rollout with the same root
    // session id but no lifecycle records. Never let that `unknown` fragment
    // replace the real session simply because it was written a moment later.
    if (!existing || (existing.status === 'unknown' && session.status !== 'unknown')) byNodeKey.set(nodeKey, { ...session, nodeKey });
  }
  // A root run is often persisted as several rollout fragments. Keep the
  // newest lifecycle state selected above, but merge its historical spawn
  // metadata so a still-running parent retains edges to dormant children.
  for (const session of sessions) {
    const nodeKey = `${session.id || session.file}\u0000${session.agentPath || ''}`;
    const target = byNodeKey.get(nodeKey);
    if (!target || target === session) continue;
    target.spawnedAgentPaths = [...new Set([...(target.spawnedAgentPaths || []), ...(session.spawnedAgentPaths || [])])];
    target.completedAgentPaths = [...new Set([...(target.completedAgentPaths || []), ...(session.completedAgentPaths || [])])];
    const agents = new Map((target.spawnedAgents || []).map((agent) => [agent.agentPath, agent]));
    for (const agent of session.spawnedAgents || []) if (!agents.has(agent.agentPath)) agents.set(agent.agentPath, agent);
    target.spawnedAgents = [...agents.values()];
    target.agentReports = [...(target.agentReports || []), ...(session.agentReports || [])];
    target.agentObservations = [...(target.agentObservations || []), ...(session.agentObservations || [])];
  }
  const uniqueSessions = [...byNodeKey.values()];
  const byId = new Map();
  for (const session of uniqueSessions) {
    // Prefer the root rollout for an id; subagent rollouts frequently carry
    // that same id and would otherwise become the false parent.
    if (session.id && (!byId.has(session.id) || (!session.agentPath && byId.get(session.id).agentPath))) byId.set(session.id, session);
  }
  const reportsByAgentPath = new Map();
  const observationsByAgentPath = new Map();
  const assignedTaskByAgentPath = new Map();
  for (const session of uniqueSessions) {
    for (const observation of session.agentObservations || []) {
      const existing = observationsByAgentPath.get(observation.agentPath);
      if (!existing || Date.parse(observation.timestamp) > (Date.parse(existing.timestamp) || -Infinity)) observationsByAgentPath.set(observation.agentPath, observation);
    }
    for (const spawned of session.spawnedAgents || []) {
      if (spawned.agentPath && spawned.task && !assignedTaskByAgentPath.has(spawned.agentPath)) assignedTaskByAgentPath.set(spawned.agentPath, spawned.task);
    }
    for (const report of session.agentReports || []) {
      const existing = reportsByAgentPath.get(report.agentPath) || { agentPath: report.agentPath, spawnedAgentPaths: new Set(), completedAgentPaths: new Set() };
      for (const childPath of report.spawnedAgentPaths || []) existing.spawnedAgentPaths.add(childPath);
      for (const childPath of report.completedAgentPaths || []) existing.completedAgentPaths.add(childPath);
      reportsByAgentPath.set(report.agentPath, existing);
    }
  }
  const rootAgentPaths = new Map();
  for (const session of uniqueSessions) {
    if (session.agentPath) continue;
    const directChild = (session.spawnedAgentPaths || []).find((agentPath) => agentPath.split('/').filter(Boolean).length === 2);
    if (directChild) rootAgentPaths.set(session.nodeKey, path.dirname(directChild));
  }
  const sessionPath = (session) => session.agentPath || rootAgentPaths.get(session.nodeKey);
  const spawnedByParentPath = new Map();
  const completedAgentPaths = new Set();
  for (const session of uniqueSessions) {
    for (const agentPath of session.spawnedAgentPaths || []) {
      const parentPath = path.dirname(agentPath);
      const childrenAtPath = spawnedByParentPath.get(parentPath) || new Set();
      childrenAtPath.add(agentPath); spawnedByParentPath.set(parentPath, childrenAtPath);
    }
    for (const agentPath of session.completedAgentPaths || []) completedAgentPaths.add(agentPath);
  }
  for (const report of reportsByAgentPath.values()) {
    for (const agentPath of report.spawnedAgentPaths) {
      const parentPath = path.dirname(agentPath);
      const childrenAtPath = spawnedByParentPath.get(parentPath) || new Set();
      childrenAtPath.add(agentPath); spawnedByParentPath.set(parentPath, childrenAtPath);
    }
    for (const agentPath of report.completedAgentPaths) completedAgentPaths.add(agentPath);
  }
  // A later progress report invalidates older completion evidence, including
  // completion metadata merged from an earlier rollout fragment.
  for (const observation of observationsByAgentPath.values()) {
    if (observation.status === 'completed') completedAgentPaths.add(observation.agentPath);
    else completedAgentPaths.delete(observation.agentPath);
  }
  const completionApplies = (session) => {
    if (!completedAgentPaths.has(session.agentPath)) return false;
    // A recorded local terminal event is authoritative, including failures.
    if (session.hasLifecycle && session.status === 'completed') return false;
    const reportAt = Date.parse(observationsByAgentPath.get(session.agentPath)?.timestamp);
    const activityAt = Date.parse(session.lastActivity || session.turnStartedAt);
    if (Number.isFinite(reportAt) && Number.isFinite(activityAt)) return reportAt >= activityAt;
    // Legacy reports without timestamps cannot override a proven lifecycle.
    return !session.hasLifecycle && !Number.isFinite(activityAt);
  };
  const spawnedByPath = new Map();
  for (const session of uniqueSessions) {
    for (const childPath of session.spawnedAgentPaths || []) {
      if (!spawnedByPath.has(childPath)) spawnedByPath.set(childPath, session.nodeKey);
    }
  }
  const parentFor = (session) => {
    if (session.parentId && byId.has(session.parentId)) {
      const parent = byId.get(session.parentId);
      if (parent.nodeKey !== session.nodeKey) return parent.nodeKey;
    }
    const parentPath = session.agentPath && path.dirname(session.agentPath);
    const parentSession = parentPath && uniqueSessions.find((candidate) => sessionPath(candidate) === parentPath);
    if (parentSession && parentSession.nodeKey !== session.nodeKey) return parentSession.nodeKey;
    const spawnedParent = session.agentPath && spawnedByPath.get(session.agentPath);
    return spawnedParent && spawnedParent !== session.nodeKey && byNodeKey.has(spawnedParent) ? spawnedParent : undefined;
  };
  const children = new Map();
  const roots = [];
  const isAttachable = (session) => {
    const seen = new Set([session.nodeKey]);
    let parentId = parentFor(session);
    while (parentId && byNodeKey.has(parentId)) {
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      parentId = parentFor(byNodeKey.get(parentId));
    }
    return Boolean(parentFor(session));
  };
  for (const session of uniqueSessions) {
    if (isAttachable(session)) {
      const parentId = parentFor(session);
      const list = children.get(parentId) || [];
      list.push(session); children.set(parentId, list);
    } else roots.push(session);
  }
  const knownAgentPaths = new Set(uniqueSessions.map((session) => session.agentPath).filter(Boolean));
  const childSessionsFor = (parent) => {
    const directChildren = children.get(parent.nodeKey) || [];
    const directPaths = new Set(directChildren.map((child) => child.agentPath).filter(Boolean));
    const placeholders = [];
    const parentPath = sessionPath(parent);
    const paths = parentPath ? spawnedByParentPath.get(parentPath) || new Set() : new Set(parent.spawnedAgentPaths || []);
    for (const agentPath of paths) {
      if (knownAgentPaths.has(agentPath) || directPaths.has(agentPath)) continue;
      const report = reportsByAgentPath.get(agentPath);
      const observation = observationsByAgentPath.get(agentPath);
      const completed = completedAgentPaths.has(agentPath);
      placeholders.push({
        id: `${parent.nodeKey}:placeholder:${agentPath}`,
        agentName: path.basename(agentPath),
        agentPath,
        status: completed ? 'completed' : parent.status === 'stale' ? 'stale' : report || observation ? 'active' : 'starting',
        attentionState: completed ? 'completed' : parent.status === 'stale' ? 'stalled' : report || observation ? 'running' : 'waiting',
        attentionDetail: completed ? 'Task completed (agent report received)' : parent.status === 'stale' ? 'Transcript has stopped updating' : report || observation ? 'Working (agent report received)' : 'Waiting for transcript',
        completionSource: completed ? 'agent_report' : undefined,
        spawnedAgentPaths: report ? [...report.spawnedAgentPaths] : [],
        completedAgentPaths: report ? [...report.completedAgentPaths] : [],
        isPlaceholder: true,
        cwd: parent.cwd,
        currentTask: assignedTaskByAgentPath.get(agentPath),
        lastActivity: observation?.timestamp || parent.lastActivity
      });
    }
    return [...directChildren, ...placeholders].sort(compareSessions);
  };
  const make = (session, ancestry = new Set()) => {
    const identity = session.agentPath || session.nodeKey;
    if (ancestry.has(identity)) return { session: { ...session, unsupportedReason: 'Cyclic reported agent relationship' }, children: [] };
    const next = new Set(ancestry); next.add(identity);
    const assignedTask = session.agentPath && assignedTaskByAgentPath.get(session.agentPath);
    const taskSession = assignedTask ? { ...session, currentTask: assignedTask, taskSource: 'parent_spawn' } : session;
    const displayedSession = taskSession.agentPath && completionApplies(taskSession)
      ? { ...taskSession, status: 'completed', attentionState: 'completed', attentionDetail: 'Task completed (agent report received)', completionSource: 'agent_report' }
      : taskSession;
    const childNodes = childSessionsFor(session).map((child) => make(child, next));
    const delegated = displayedSession.status === 'completed' && childNodes.some((child) => ['active', 'waiting', 'starting', 'delegating'].includes(child.session.status));
    return { session: delegated ? { ...displayedSession, status: 'delegating', attentionState: 'running', attentionDetail: 'Delegating to active subagent(s)' } : displayedSession, children: childNodes };
  };
  return roots.sort(compareSessions).map((root) => make(root));
}

module.exports = { buildSessionForest, compareSessions };
