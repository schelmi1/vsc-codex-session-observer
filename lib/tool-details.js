'use strict';

const path = require('node:path');

const shortName = (name) => String(name || '').split('.').at(-1).toLowerCase();
const object = (value) => {
  if (typeof value === 'string' && value.length <= 1024 * 1024) {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
};
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const exitCode = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : undefined;
const duration = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;

function executorEnvelopes(name, output) {
  if (!['exec', 'exec_command', 'write_stdin'].includes(shortName(name)) || !Array.isArray(output)) return [];
  // Code-mode results have a framework header followed by text blocks for
  // nested executor results. Never decode arbitrary file or stdout JSON.
  if (typeof output[0]?.text !== 'string' || !output[0].text.startsWith('Script completed')) return [];
  return output.slice(1).filter(block => block?.type === 'input_text' && typeof block.text === 'string')
    .map(block => object(block.text)).filter(value => value && typeof value.chunk_id === 'string'
      && duration(value.wall_time_seconds) !== undefined && typeof value.output === 'string'
      && (Number.isSafeInteger(value.session_id) && value.session_id > 0 || exitCode(value.exit_code) !== undefined));
}

function runningProcesses(name, payload) {
  const envelopes = executorEnvelopes(name, payload.output);
  if (['exec', 'exec_command', 'write_stdin'].includes(shortName(name))) {
    for (const value of [payload, typeof payload.output === 'object' && !Array.isArray(payload.output) ? payload.output : undefined]) {
      if (value && Number.isSafeInteger(value.session_id) && value.session_id > 0) envelopes.push(value);
    }
  }
  return [...new Set(envelopes.filter(value => value.exit_code === undefined && Number.isSafeInteger(value.session_id) && value.session_id > 0).map(value => String(value.session_id)))];
}

function commandCategory(input) {
  const value = object(input) || input;
  const command = typeof value === 'object' && value ? value.cmd || value.command : typeof value === 'string' ? value : '';
  if (typeof command !== 'string') return undefined;
  return command.match(/(?:^|[\s;|&()'\"])(git|rg|npm|pnpm|yarn|node|npx|sed|find|ls|cat|head|tail|curl|docker|python(?:3)?|cargo|go|make|code)\b/i)?.[1]?.toLowerCase();
}

function callDetails(name, input, context = {}) {
  const type = shortName(name);
  const value = object(input);
  const details = {};
  if (['exec', 'exec_command'].includes(type)) {
    const category = commandCategory(input);
    if (category) details.command = category;
    // Only known actions of a direct command are displayed; never arbitrary args.
    const command = value?.cmd || value?.command;
    const direct = typeof command === 'string' && command.match(/^\s*(?:\/[\w./-]+\/)?(git|npm|pnpm|yarn|cargo|go)\s+(status|diff|log|show|test|build|check|lint|ci|install|audit|run)(?=\s|$)/);
    if (direct) {
      details.command = direct[1] + ' ' + direct[2];
      if (direct[2] === 'run') {
        const script = command.match(/^\s*(?:npm|pnpm|yarn)\s+run\s+(test|build|lint|check|typecheck)(?=\s|$)/);
        if (script) details.command += ' ' + script[1];
      }
    }
    if (typeof command === 'string' && /^\s*(?:\S*\/)?node\s+--test(?:\s|$)/.test(command)) details.command = 'node --test';
    const pytest = typeof command === 'string' && command.match(/^\s*(?:\S*\/)?(python3?)\s+-m\s+pytest(?:\s|$)/);
    if (pytest) details.command = pytest[1] + ' pytest';
  }
  if (value?.sandbox_permissions === 'require_escalated') details.execution = 'elevated';
  else if (value?.sandbox_permissions === 'use_default') details.execution = 'default';
  const directory = value?.workdir || value?.cwd;
  if (typeof directory === 'string' && typeof context.cwd === 'string') {
    const paths = path.win32.isAbsolute(context.cwd) ? path.win32 : path.posix;
    if (paths.isAbsolute(context.cwd)) {
      const relative = paths.relative(context.cwd, paths.resolve(context.cwd, directory));
      details.directoryScope = relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative) ? 'external' : 'workspace';
    }
  }
  if (type === 'apply_patch') {
    const patch = typeof input === 'string' ? input : value?.patch;
    if (typeof patch === 'string' && patch.startsWith('*** Begin Patch\n') && patch.trimEnd().endsWith('*** End Patch')) {
      const lines = patch.split(/\r?\n/);
      details.patchFiles = new Set(lines.filter(line => /^\*\*\* (?:Add|Update|Delete) File: /.test(line))).size;
      details.patchLinesAdded = lines.filter(line => line.startsWith('+')).length;
      if (!lines.some(line => line.startsWith('*** Delete File: '))) details.patchLinesRemoved = lines.filter(line => line.startsWith('-')).length;
    }
  }
  return details;
}

function resultDetails(name, payload, previous = {}) {
  const type = shortName(name);
  const structured = value => typeof value === 'object' ? object(value) : undefined;
  const executor = ['exec', 'exec_command', 'write_stdin'].includes(type);
  const hasExecutionMetadata = value => exitCode(value?.exit_code) !== undefined
    || ['duration_ms', 'elapsed_ms', 'wall_time_seconds', 'duration_seconds'].some(key => duration(value?.[key]) !== undefined);
  const transport = value => {
    if (typeof value !== 'string') return structured(value);
    // JSON stdout and file contents are data. Decode only the executor's
    // serialized envelope, and never recursively decode its stdout.
    if (!executor || hasExecutionMetadata(payload) || hasExecutionMetadata(payload.metadata)) return undefined;
    const envelope = object(value);
    return typeof envelope?.output === 'string' && hasExecutionMetadata(envelope) ? envelope : undefined;
  };
  const envelopes = executorEnvelopes(name, payload.output);
  const output = transport(payload.output) || (envelopes.length === 1 ? envelopes[0] : undefined);
  const result = transport(payload.result);
  const sources = [payload, output, result, structured(payload.metadata), structured(output?.metadata), structured(result?.metadata)].filter(Boolean);
  const details = { ...previous };
  const read = (keys, validate = count) => {
    for (const source of sources) for (const key of keys) {
      const value = validate(source[key]);
      if (value !== undefined) return value;
    }
  };
  const set = (field, value) => { if (value !== undefined) details[field] = value; };
  set('exitCode', read(['exit_code'], exitCode));
  set('durationMs', read(['duration_ms', 'elapsed_ms'], duration));
  const seconds = read(['wall_time_seconds', 'duration_seconds'], duration);
  if (details.durationMs === undefined && seconds !== undefined) set('durationMs', duration(seconds * 1000));
  const body = typeof output?.output === 'string' ? output.output : typeof result?.output === 'string' ? result.output
    : typeof payload.output === 'string' && !output ? payload.output : undefined;
  let text = body;
  if (typeof text === 'string') {
    // Recognize only the executor's header, never exit-code-looking lines in stdout.
    const header = text.match(/^(?:Chunk ID: [\w-]+\r?\n)?Wall time: ([\d.]+) seconds\r?\n(?:Process exited with code (-?\d+)|Exit code: (-?\d+))\r?\n(?:Final output:|Output:)\r?\n/);
    if (header && ['exec', 'exec_command', 'write_stdin'].includes(type)) {
      if (details.exitCode === undefined) set('exitCode', exitCode(Number(header[2] ?? header[3])));
      if (details.durationMs === undefined) set('durationMs', duration(Number(header[1]) * 1000));
      text = text.slice(header[0].length);
    }
    details.outputBytes = Buffer.byteLength(text);
    details.outputLines = text.length ? 1 - Number(text.endsWith('\n')) : 0;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) details.outputLines++;
  }
  if (sources.some(source => source.truncated === true || source.output_truncated === true)) details.outputTruncated = true;
  for (const [field, keys] of Object.entries({ linesRead: ['lines_read'], bytesRead: ['bytes_read'], matches: ['match_count'], matchedFiles: ['matched_files'], testsTotal: ['tests_total'], testsPassed: ['tests_passed'], testsFailed: ['tests_failed'], testsSkipped: ['tests_skipped'], agentsStarted: ['agents_started'], agentsFinished: ['agents_finished'] })) {
    set(field, read(keys));
  }
  const attempt = read(['attempt'], value => count(value) > 0 && value <= 1000 ? value : undefined);
  const retries = read(['retry_count'], value => count(value) !== undefined && value < 1000 ? value : undefined);
  set('attempt', attempt ?? (retries === undefined ? undefined : retries + 1));
  set('maxAttempts', read(['max_attempts'], value => count(value) > 0 && value <= 1000 && value >= (details.attempt || 1) ? value : undefined));
  if (typeof text === 'string' && !details.outputTruncated && /(?:\btest\b|pytest)/.test(details.command || '')) {
    const footer = text.slice(-65536);
    const totals = {};
    for (const match of footer.matchAll(/^(?:#|ℹ)\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/gm)) totals[match[1]] = Number(match[2]);
    if (count(totals.tests) !== undefined && count(totals.pass) !== undefined && count(totals.fail) !== undefined && totals.pass + totals.fail + (totals.skipped || 0) <= totals.tests) {
      details.testsTotal = totals.tests; details.testsPassed = totals.pass; details.testsFailed = totals.fail;
      if (count(totals.skipped) !== undefined) details.testsSkipped = totals.skipped;
    }
    const pytest = footer.match(/^=+ ((?:\d+ (?:passed|failed|skipped|errors?))(?:, \d+ (?:passed|failed|skipped|errors?))*) in [\d.]+s =+\s*$/m);
    if (pytest && /pytest/.test(details.command || '')) {
      const counts = [...pytest[1].matchAll(/(\d+) (passed|failed|skipped|error|errors)\b/g)];
      if (counts.length && counts.every(match => count(Number(match[1])) !== undefined)) {
        const total = kind => counts.filter(match => kind.includes(match[2])).reduce((sum, match) => sum + Number(match[1]), 0);
        const passed = total(['passed']), failed = total(['failed', 'error', 'errors']), skipped = total(['skipped']);
        const totalTests = passed + failed + skipped;
        if (count(totalTests) !== undefined) {
          details.testsPassed = passed; details.testsFailed = failed; details.testsSkipped = skipped; details.testsTotal = totalTests;
        }
      }
    }
  }
  if (details.command === 'rg' && typeof text === 'string' && !details.outputTruncated) {
    const events = text.slice(-65536).trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return undefined; } });
    const summary = events.findLast(event => event?.type === 'summary')?.data?.stats;
    if (summary) { set('matches', count(summary.matches)); set('matchedFiles', count(summary.searches_with_match)); }
  }
  if (/search|^web\./.test(String(name))) {
    const results = sources.find(source => Array.isArray(source.results))?.results;
    if (results) details.results = results.length;
  }
  const errors = { ETIMEDOUT: 'timeout', TIMEOUT: 'timeout', TIMEOUTERROR: 'timeout', TIMED_OUT: 'timeout', EACCES: 'permission', EPERM: 'permission', PERMISSIONERROR: 'permission', PERMISSION_DENIED: 'permission', CANCELLED: 'cancelled', CANCELED: 'cancelled' };
  for (const source of sources) {
    const code = source.error?.code ?? source.error?.type ?? source.error_code;
    if (typeof code === 'string' && Object.hasOwn(errors, code.toUpperCase())) details.failure = errors[code.toUpperCase()];
  }
  if (!details.failure && details.exitCode !== undefined && details.exitCode !== 0 && !(details.command === 'rg' && details.exitCode === 1)) details.failure = 'process';
  if (!details.failure && sources.some(source => source.is_error === true || object(source.error) || ['error', 'failed', 'failure'].includes(source.status))) details.failure = 'tool';
  if (type === 'spawn_agent' && !details.failure && sources.some(source => typeof source.agent_id === 'string' && source.agent_id)) details.agentsStarted = 1;
  if (type === 'wait_agent') {
    const statuses = sources.find(source => object(source.status))?.status;
    if (statuses) details.agentsFinished = Object.values(statuses).filter(value => value === 'completed' || value?.status === 'completed').length;
  }
  return details;
}

module.exports = { commandCategory, callDetails, resultDetails, runningProcesses };
