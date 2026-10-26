'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { commandCategory, callDetails, resultDetails, runningProcesses } = require('./tool-details');

const SUPPORTED_VERSION_PREFIXES = ['0.162.', '0.164.'];
const COMPLETION_GRACE_MS = 5000;

function transcriptRoot(env = process.env, home = require('node:os').homedir()) {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
}

function readJsonLines(file) {
  const records = [];
  for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') records.push(value);
    } catch {
      // A transcript is often read while Codex is appending it. Ignore one partial line.
      if (index < fs.readFileSync(file, 'utf8').split(/\r?\n/).length - 1) throw new Error(`Invalid JSON at line ${index + 1}`);
    }
  }
  return records;
}

const TOOL_LABELS = {
  read: 'Read',
  view_image: 'View image',
  exec: 'Exec',
  exec_command: 'Exec',
  apply_patch: 'Apply patch',
  write_stdin: 'Write to process',
  wait: 'Wait',
  wait_agent: 'Wait for agent',
  spawn_agent: 'Spawn agent',
  send_message: 'Send message',
  search_query: 'Web search',
  web_search_call: 'Web search'
};

function toolLabel(name, input) {
  const shortName = String(name || '').split('.').at(-1).toLowerCase();
  const base = TOOL_LABELS[shortName] || shortName.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  const category = ['exec', 'exec_command'].includes(shortName) ? commandCategory(input) : undefined;
  return category ? `${base} · ${category}` : base;
}

function eventFrom(record) {
  return record.type === 'event_msg' ? record.payload?.type : record.payload?.event?.type;
}

function toolFrom(record, context) {
  const item = record.payload;
  if (record.type !== 'response_item' || !item) return undefined;
  const directCall = ['custom_tool_call', 'function_call', 'web_search_call', 'tool_search_call'].includes(item.type);
  const genericCall = item.type === 'tool_call' && (item.name || item.function?.name || item.tool?.name);
  if (!directCall && !genericCall) return undefined;
  const name = item.name || item.function?.name || item.tool?.name || item.type;
  const input = item.input ?? item.arguments ?? item.function?.arguments ?? item.tool?.input;
  const details = callDetails(name, input, context);
  return { id: item.call_id || item.tool_call_id || item.id, name, label: toolLabel(name, input), status: item.status, ...(Object.keys(details).length ? { details } : {}) };
}

function toolOutputFrom(record) {
  const item = record.payload;
  if (record.type !== 'response_item' || !item) return undefined;
  const knownOutput = ['custom_tool_call_output', 'function_call_output', 'tool_search_output'].includes(item.type);
  if (!knownOutput && item.type !== 'tool_output') return undefined;
  const id = item.call_id || item.tool_call_id || item.id;
  return id ? { id, payload: item } : undefined;
}

function tokenUsageFrom(record) {
  const usage = record.type === 'token_usage_record'
    ? record.payload?.thread_token_usage || record.payload?.turn_token_usage || record.payload?.usage
    : eventFrom(record) === 'token_count' ? record.payload?.info?.total_token_usage : undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const readCount = (name) => Number.isFinite(usage[name]) && usage[name] >= 0 ? usage[name] : undefined;
  const input = readCount('input_tokens');
  const cachedInput = readCount('cached_input_tokens');
  const output = readCount('output_tokens');
  return input === undefined && cachedInput === undefined && output === undefined ? undefined : { input, cachedInput, output };
}

function transcriptCompatibility(records, cliVersion) {
  const supportedPrefix = SUPPORTED_VERSION_PREFIXES.find((prefix) => cliVersion.startsWith(prefix));
  if (supportedPrefix) return { level: 'supported', resolution: `Verified parser for the ${supportedPrefix.slice(0, -1)} transcript family` };
  const recognizable = records.some((record) => ['task_started', 'task_complete', 'turn_aborted'].includes(eventFrom(record)) || Boolean(toolFrom(record)) || Boolean(toolOutputFrom(record)));
  if (recognizable) return {
    level: 'best_effort', detail: `Best effort: unverified Codex transcript version ${cliVersion || 'unknown'}`,
    resolution: 'Generic adapters recognized lifecycle or tool-call records'
  };
  return {
    level: 'unsupported', detail: `Unrecognized Codex transcript schema for version ${cliVersion || 'unknown'}`,
    resolution: 'No recognized lifecycle or tool-call records'
  };
}

function terminalToolStatus(output, details) {
  // Output records differ between built-in and custom tools. Keep the raw
  // output private, but retain the one fact the UI needs: did it work?
  const status = String(output?.status || output?.result?.status || '').toLowerCase();
  if (output?.is_error || details?.failure || ['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status)) return 'failed';
  return 'completed';
}

function attentionFrom({ status, currentTool, lastTool, terminalError }) {
  // A transcript does not have a generic "waiting for approval" event.  Only
  // label an agent as awaiting input when its outstanding tool explicitly
  // asks for it; otherwise it is simply waiting on a running tool.
  if (status === 'stale') return { state: 'stalled', detail: 'Transcript has stopped updating' };
  if (terminalError) return { state: 'failed', detail: terminalError };
  // A normal task completion is authoritative: earlier failed tool attempts
  // remain in the timeline, but must not leave the session card marked failed.
  if (status === 'completed') return { state: 'completed', detail: 'Task completed' };
  if (lastTool?.status === 'failed') return { state: 'failed', detail: `Last tool failed: ${lastTool.name}` };
  if (currentTool) {
    const name = String(currentTool.name || 'tool');
    if (/(request_?user_?input|user_?input|approval|permission)/i.test(name)) {
      return { state: 'waiting', detail: `Awaiting input or approval: ${name}` };
    }
    return { state: 'waiting', detail: `Waiting for tool: ${name}` };
  }
  if (status === 'active' || status === 'delegating') return { state: 'running', detail: status === 'delegating' ? 'Delegating to active subagent(s)' : 'Working' };
  if (status === 'starting') return { state: 'waiting', detail: 'Waiting for transcript' };
  return { state: 'unknown', detail: 'No reliable activity state' };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('\n');
  return '';
}

function compactTask(content, limit = 160) {
  // Remove known runtime envelopes without discarding a request after them.
  const text = contentText(content)
    .replace(/<(environment_context|skills_instructions|external_codex_apps_open_page|codex_apps_open_page_instructions|turn_aborted)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\s+/g, ' ').trim();
  if (!text || /^# AGENTS\.md instructions\b/i.test(text)
    || /^The following is (?:the )?Codex agent history whose request action you are assessing\b/i.test(text)) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

// Progress is intentionally separate from the originating task: it is the
// latest display-safe assistant commentary, with timeline activity as fallback.
function compactProgress(content, limit = 180) {
  const text = contentText(content).replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<environment_context>') || text.startsWith('<skills_instructions>')) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function progressFromTimeline(timeline) {
  const event = timeline.at(-1);
  if (!event) return undefined;
  const text = event.kind === 'tool' ? `${event.status === 'in_progress' ? 'Using' : 'Finished'} tool: ${event.label}` : event.label;
  return { text, timestamp: event.completedAt || event.timestamp, source: event.kind };
}

function summarizeTranscript(records, file, stat) {
  const meta = records.find((record) => record.type === 'session_meta')?.payload;
  const mtime = stat?.mtime ? stat.mtime.toISOString() : undefined;
  if (!meta) return { file, unsupportedReason: 'Missing session_meta record', lastActivity: mtime };
  const cliVersion = String(meta.cli_version || '');
  const compatibility = transcriptCompatibility(records, cliVersion);
  if (compatibility.level === 'unsupported') {
    return { file, id: meta.session_id || meta.id, cwd: meta.cwd, lastActivity: mtime, cliVersion: meta.cli_version, supportLevel: compatibility.level, compatibilityResolution: compatibility.resolution, unsupportedReason: compatibility.detail };
  }

  // Forked rollouts begin with a copied parent history. The ordinal counts
  // history records after this rollout's leading session_meta record.
  const historyStart = meta.agent_path && Number.isInteger(meta.subagent_history_start_ordinal)
    && meta.subagent_history_start_ordinal >= 0 ? meta.subagent_history_start_ordinal + 1 : 0;
  const localRecords = records.slice(historyStart);
  let turnActive = false;
  let currentTurnId;
  let turnStartedAt;
  let sawLifecycle = false;
  let lastTool;
  const openTools = new Map();
  const processes = new Map();
  const toolHistory = [];
  const toolEntriesByCallId = new Map();
  // Keep a deliberately small, display-safe event stream.  It contains no
  // tool arguments or outputs, only the milestones needed for an at-a-glance
  // activity timeline in the observer.
  const activityTimeline = [];
  const timelineToolsByCallId = new Map();
  let lastActivity = meta.timestamp;
  const spawnCalls = new Map();
  const spawnedAgentPaths = new Set();
  const spawnedAgents = [];
  const completedAgentPaths = new Set();
  const agentObservations = new Map();
  const agentReports = new Map();
  let currentTask;
  let currentProgress;
  let tokenUsage;
  let terminalError;
  const closeTools = (status, timestamp) => {
    for (const [id, tool] of openTools) {
      tool.status = status; tool.completedAt = timestamp;
      const timeline = timelineToolsByCallId.get(id);
      if (timeline) { timeline.status = status; timeline.completedAt = timestamp; }
    }
    openTools.clear();
    processes.clear();
  };
  const finishTool = (tool, status, timestamp) => {
    openTools.delete(tool.id);
    tool.status = status; tool.completedAt = timestamp;
    const timeline = timelineToolsByCallId.get(tool.id);
    if (timeline) { timeline.status = status; timeline.completedAt = timestamp; }
  };
  const observeAgent = (agentPath, status, timestamp, direct = true) => {
    agentObservations.set(agentPath, { agentPath, status, timestamp });
    if (direct) {
      if (status === 'completed') completedAgentPaths.add(agentPath);
      else completedAgentPaths.delete(agentPath);
    }
  };
  for (const record of localRecords) {
    if (record.timestamp) lastActivity = record.timestamp;
    const event = eventFrom(record);
    const execution = record.type === 'event_msg' && event === 'item_completed' && record.payload?.item;
    if (execution?.type === 'CommandExecution') {
      const processId = String(execution.process_id || '');
      const entry = processes.get(processId);
      if (entry) {
        processes.delete(processId);
        const seconds = execution.duration?.secs, nanos = execution.duration?.nanos;
        const elapsed = Number.isSafeInteger(seconds) && seconds >= 0 && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9 ? seconds + nanos / 1e9 : undefined;
        const outcome = { exit_code: execution.exit_code, duration_ms: elapsed === undefined ? undefined : elapsed * 1000, status: execution.status };
        entry.details = resultDetails(entry.name, outcome, entry.details);
        if (![...processes.values()].includes(entry)) finishTool(entry, terminalToolStatus(outcome, entry.details), record.timestamp);
      }
    }
    const lifecycle = record.type === 'event_msg' ? record.payload : record.payload?.event;
    const turnId = lifecycle?.turn_id;
    if (event === 'task_started' && !(turnActive && turnId && turnId === currentTurnId)) {
      closeTools('cancelled', record.timestamp);
      turnActive = true; currentTurnId = turnId; turnStartedAt = record.timestamp; sawLifecycle = true;
      // A transcript can contain many turns. A failure in an earlier one must
      // not make a later, newly-started task look failed.
      lastTool = undefined;
      terminalError = undefined;
      currentProgress = undefined;
      activityTimeline.push({ kind: 'task', label: 'Task started', timestamp: record.timestamp });
    }
    if ((event === 'task_complete' || event === 'turn_aborted') && !(turnId && currentTurnId && turnId !== currentTurnId)) {
      turnActive = false; sawLifecycle = true;
      closeTools(event === 'turn_aborted' ? 'cancelled' : 'unknown', record.timestamp);
      if (lifecycle?.error?.message) terminalError = `Task failed: ${lifecycle.error.message}`;
      else if (event === 'turn_aborted') terminalError = 'Task was interrupted';
      activityTimeline.push({ kind: event === 'turn_aborted' ? 'aborted' : 'completed', label: event === 'turn_aborted' ? 'Task aborted' : 'Task completed', timestamp: record.timestamp });
    }
    if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user') {
      const task = compactTask(record.payload.content);
      if (task) currentTask = task;
    }
    if (record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'assistant') {
      const text = compactProgress(record.payload.content);
      if (text) currentProgress = { text, timestamp: record.timestamp, source: 'assistant' };
    }
    const recordedUsage = tokenUsageFrom(record);
    if (recordedUsage) tokenUsage = recordedUsage;
    const tool = toolFrom(record, { cwd: meta.cwd });
    if (tool) {
      // A completed call envelope means the model finished emitting the request.
      // Execution stays pending until its matching output or a turn boundary.
      const inferredRunning = ['function_call', 'custom_tool_call', 'tool_call'].includes(record.payload?.type)
        && (!tool.status || tool.status === 'completed');
      const normalized = { ...tool, status: inferredRunning || tool.status === 'in_progress' ? 'in_progress' : tool.status || 'completed' };
      const entry = { ...normalized, timestamp: record.timestamp, startedAt: record.timestamp };
      toolHistory.push(entry);
      toolEntriesByCallId.set(entry.id, entry);
      const timelineEntry = { kind: 'tool', label: normalized.name, status: entry.status, timestamp: record.timestamp };
      activityTimeline.push(timelineEntry);
      timelineToolsByCallId.set(entry.id, timelineEntry);
      lastTool = entry;
      if (normalized.status === 'in_progress') openTools.set(normalized.id, entry);
    }
    const toolOutput = toolOutputFrom(record);
    if (toolOutput) {
      const entry = toolEntriesByCallId.get(toolOutput.id);
      if (entry) {
        const details = resultDetails(entry.name, toolOutput.payload, entry.details);
        if (Object.keys(details).length) entry.details = details;
        if (entry.status === 'in_progress') for (const processId of runningProcesses(entry.name, toolOutput.payload)) {
          if (!processes.has(processId)) processes.set(processId, entry);
        }
        if ([...processes.values()].includes(entry)) {
          entry.status = 'in_progress'; openTools.set(entry.id, entry);
        } else finishTool(entry, terminalToolStatus(toolOutput.payload, details), record.timestamp);
      }
      const timelineEntry = timelineToolsByCallId.get(toolOutput.id);
      if (timelineEntry) {
        timelineEntry.status = entry?.status || terminalToolStatus(toolOutput.payload);
        if (!entry || entry.completedAt) timelineEntry.completedAt = entry?.completedAt || record.timestamp;
      }
    }
    if (record.type === 'response_item' && record.payload?.type === 'function_call' && record.payload.namespace === 'collaboration' && record.payload.name === 'spawn_agent') {
      try {
        const args = typeof record.payload.arguments === 'string' ? JSON.parse(record.payload.arguments) : record.payload.arguments;
        if (args?.task_name) {
          const message = typeof args.message === 'string' && !args.message.startsWith('gAAAA') ? compactTask(args.message) : undefined;
          spawnCalls.set(record.payload.call_id, { taskName: args.task_name, message });
        }
      } catch { /* Ignore malformed tool arguments. */ }
    }
    if (record.type === 'response_item' && record.payload?.type === 'function_call_output' && spawnCalls.has(record.payload.call_id)) {
      try {
        const result = typeof record.payload.output === 'string' ? JSON.parse(record.payload.output) : record.payload.output;
        if (result?.task_name) {
          spawnedAgentPaths.add(result.task_name);
          const spawn = spawnCalls.get(record.payload.call_id);
          spawnedAgents.push({ agentPath: result.task_name, task: spawn.message || `Assigned subtask: ${spawn.taskName}` });
          activityTimeline.push({ kind: 'delegation', label: `Delegated to ${result.task_name.split('/').filter(Boolean).pop() || result.task_name}`, timestamp: record.timestamp, target: result.task_name });
        }
      } catch { /* A failed spawn has no graph edge. */ }
    }
    // Ordinary inter-agent messages are progress, not terminal responses.
    // Only an explicit final envelope (or a relay completion marker) can end
    // a child for which no authoritative local lifecycle is available.
    if (record.type === 'response_item' && record.payload?.type === 'agent_message' && record.payload.author) {
      const author = record.payload.author;
      const relays = [...contentText(record.payload.content).matchAll(/\[codex-observer\]\s+(spawn|complete)\s+(\/[^\s`]+)/g)];
      if (relays.length) {
        const report = agentReports.get(author) || { agentPath: author, spawnedAgentPaths: new Set(), completedAgentPaths: new Set() };
        for (const [, action, agentPath] of relays) {
          if (action === 'spawn') report.spawnedAgentPaths.add(agentPath);
          else report.completedAgentPaths.add(agentPath);
          observeAgent(agentPath, action === 'complete' ? 'completed' : 'active', record.timestamp, false);
        }
        agentReports.set(author, report);
      }
      const agentPath = meta.agent_path || '/root';
      if (author.startsWith(agentPath + '/')) {
        const messageType = record.payload.message_type || contentText(record.payload.content).match(/^\s*Message Type:\s*(FINAL_ANSWER|MESSAGE)\s*(?:\r?\n|$)/)?.[1];
        if (!relays.length || messageType === 'FINAL_ANSWER') {
          observeAgent(author, messageType === 'FINAL_ANSWER' ? 'completed' : 'active', record.timestamp);
        }
      }
    }
  }
  const currentTool = [...openTools.values()].at(-1);
  const status = turnActive ? (currentTool ? 'waiting' : 'active') : (sawLifecycle ? 'completed' : 'unknown');
  const attention = attentionFrom({ status, currentTool, lastTool, terminalError });
  return {
    file,
    id: meta.session_id || meta.id,
    parentId: meta.parent_thread_id,
    agentName: meta.agent_nickname || meta.agent_path?.split('/').pop(),
    agentPath: meta.agent_path,
    spawnedAgentPaths: [...spawnedAgentPaths],
    spawnedAgents,
    completedAgentPaths: [...completedAgentPaths],
    agentObservations: [...agentObservations.values()],
    agentReports: [...agentReports.values()].map((report) => ({ ...report, spawnedAgentPaths: [...report.spawnedAgentPaths], completedAgentPaths: [...report.completedAgentPaths] })),
    cwd: meta.cwd,
    cliVersion: meta.cli_version,
    supportLevel: compatibility.level,
    compatibilityDetail: compatibility.detail,
    compatibilityResolution: compatibility.resolution,
    lastActivity: lastActivity || stat?.mtime.toISOString(),
    status,
    hasLifecycle: sawLifecycle, currentTurnId, turnStartedAt,
    attentionState: attention.state,
    attentionDetail: attention.detail,
    lastTool,
    currentTool,
    toolHistory: toolHistory.slice(-100),
    activityTimeline: activityTimeline.slice(-100),
    currentTask,
    currentProgress: currentProgress || progressFromTimeline(activityTimeline),
    tokenUsage,
    recordCount: records.length
  };
}

function walkRollouts(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkRollouts(full));
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
  }
  return files;
}

// A `task_complete` record can be followed immediately by more transcript
// activity (for example, while Codex compacts or begins another turn). Keep a
// normal completion in the live group briefly so parallel runs do not jump
// around during that hand-off. Unfinished lifecycles still become stale after
// a longer quiet period.
function loadSessions(root, staleAfterMs = 900000, now = Date.now()) {
  return walkRollouts(root).map((file) => {
    try {
      const records = readJsonLines(file);
      const meta = records.find(record => record.type === 'session_meta')?.payload;
      // Internal approval reviews can share the user's session id and have
      // their own lifecycle. They must never replace the observed agent.
      if (meta?.source?.subagent?.other === 'guardian') return undefined;
      const session = summarizeTranscript(records, file, fs.statSync(file));
      const lastActivityMs = Date.parse(session.lastActivity || '');
      const activityAgeMs = Number.isFinite(lastActivityMs) ? Math.max(0, now - lastActivityMs) : undefined;
      if (session.status === 'completed' && session.attentionState === 'completed' && activityAgeMs !== undefined && activityAgeMs < COMPLETION_GRACE_MS) {
        session.status = 'active';
        session.completionPending = true;
        session.attentionState = 'running';
        session.attentionDetail = 'Waiting for next heartbeat';
      }
      if (['active', 'waiting'].includes(session.status) && Number.isFinite(lastActivityMs) && now - lastActivityMs > staleAfterMs) {
        session.status = 'stale';
        session.staleReason = `No transcript activity for ${Math.round((now - lastActivityMs) / 1000)} seconds`;
        session.attentionState = 'stalled';
        session.attentionDetail = session.staleReason;
      }
      return session;
    }
    catch (error) { return { file, unsupportedReason: `Could not read transcript: ${error.message}` }; }
  }).filter(Boolean).sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
}

module.exports = { SUPPORTED_VERSION_PREFIXES, COMPLETION_GRACE_MS, transcriptRoot, readJsonLines, summarizeTranscript, loadSessions, compactTask, compactProgress, toolLabel, transcriptCompatibility };
