'use strict';

// Browser checks use the actual webview assets and a mocked VS Code message bridge.
// Run with CHROME_BIN=/path/to/chrome npm run test:ui. No browser package is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { liveMapModel, agentKeyFor } = require('../lib/live-map-model');
const { buildSessionForest } = require('../lib/hierarchy');
const { summarizeTranscript } = require('../lib/transcript');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentobs-browser-'));
const screenshotDir = process.env.AGENTOBS_SCREENSHOT_DIR || temporary;
fs.mkdirSync(screenshotDir, { recursive: true });
const now = new Date().toISOString();
const privateToolText = 'SHOULD_NOT_REACH_WEBVIEW';
const recordedTool = (id, name, input, output, duration = 800) => summarizeTranscript([
  { type: 'session_meta', payload: { session_id: 'safe-fixture', cwd: '/home/project/agentobs', cli_version: '0.164.0' } },
  { type: 'event_msg', payload: { type: 'task_started' } },
  { type: 'response_item', timestamp: new Date(Date.parse(now) - duration).toISOString(), payload: { type: 'function_call', call_id: id, name, arguments: input } },
  { type: 'response_item', timestamp: now, payload: { type: 'function_call_output', call_id: id, output } }
], 'fixture.jsonl').toolHistory[0];
const fixture = [
  { id: 'run-a', status: 'active', currentTask: 'Improve the observer and live agent map', currentProgress: { text: 'Checking the responsive layout and preserving tool details during live updates.' }, cwd: '/home/project/agentobs', lastActivity: now, tokenUsage: { input: 499883, cachedInput: 460672, output: 4791 }, toolHistory: [{ id: 'listing', name: 'functions.exec', label: 'Exec · ls', status: 'completed', startedAt: now, completedAt: now }], spawnedAgentPaths: ['/root/parser', '/root/design'], spawnedAgents: [{ agentPath: '/root/parser', task: 'Verify parser compatibility' }, { agentPath: '/root/design', task: 'Review the visual hierarchy' }] },
  { id: 'run-a', agentPath: '/root/parser', agentName: 'Parser review', status: 'active', attentionState: 'failed', attentionDetail: 'Last tool failed: npm test', cliVersion: '0.164.0', supportLevel: 'supported', compatibilityResolution: 'Verified parser for the 0.164 transcript family', currentProgress: { text: 'One compatibility fixture needs attention.' }, cwd: '/home/project/agentobs', lastActivity: now, tokenUsage: { input: 12800, cachedInput: 10200, output: 940 }, toolHistory: [{ id: 'image', name: 'view_image', label: 'View image', status: 'completed', startedAt: now, completedAt: now }, recordedTool('read', 'read', { path: '/private/' + privateToolText }, { lines_read: 120, bytes_read: 4200, output: privateToolText }), recordedTool('patch', 'apply_patch', '*** Begin Patch\n*** Update File: /private/' + privateToolText + '\n@@\n-old secret\n+new secret\n+extra\n*** End Patch', { output: privateToolText }), recordedTool('search', 'exec_command', { cmd: 'rg --json ' + privateToolText }, { exit_code: 0, output: JSON.stringify({ type: 'summary', data: { stats: { matches: 12, searches_with_match: 4 } } }) }), recordedTool('build', 'exec_command', { cmd: 'npm test --token=' + privateToolText }, { exit_code: 0, wall_time_seconds: 0.8, output: '# tests 69\n# pass 69\n# fail 0\n' + privateToolText }), recordedTool('check', 'exec_command', { cmd: 'python3 -m pytest /private/' + privateToolText, workdir: '/home/project/agentobs/' + privateToolText, sandbox_permissions: 'require_escalated' }, { exit_code: 1, wall_time_seconds: 1.2, attempt: 2, max_attempts: 3, output: '=== 4 passed, 1 failed in 1.2s ===\n' + privateToolText }, 1200)] },
  { id: 'run-a', agentPath: '/root/design', agentName: 'Design review', status: 'completed', currentProgress: { text: 'The layout review is complete.' }, cwd: '/home/project/agentobs', lastActivity: now, tokenUsage: { input: 2100, cachedInput: 1100, output: 60 } },
  { id: 'run-b', status: 'waiting', currentTask: 'Review deployment checks', currentTool: { id: 'current-input', name: 'request_user_input', label: 'Request user input', status: 'in_progress', startedAt: now }, toolHistory: [{ id: 'current-input', name: 'request_user_input', label: 'Request user input', status: 'in_progress', startedAt: now }, ...['view_image', 'read', 'ls', 'rg', 'npm'].map(name => ({ id: 'prior-' + name, name: ['ls', 'rg', 'npm'].includes(name) ? 'exec_command' : name, label: ['ls', 'rg', 'npm'].includes(name) ? 'Exec · ' + name : name === 'read' ? 'Read' : 'View image', status: 'completed', startedAt: now, completedAt: now }))], currentProgress: { text: 'Ready for your choice of deployment target.' }, cwd: '/home/project/agentobs', lastActivity: now },
  { id: 'run-quiet', status: 'stale', currentTask: 'Inspect transcript compatibility', currentProgress: { text: 'No new records have been observed. The task outcome is unknown.' }, cwd: '/home/project/agentobs', lastActivity: new Date(Date.now() - 20 * 60000).toISOString() },
  { id: 'old-failed', status: 'completed', attentionState: 'failed', currentTask: 'Old failed run', lastActivity: new Date(Date.now() - 22 * 3600000).toISOString() },
  { id: 'old-interrupted', status: 'completed', attentionState: 'failed', attentionDetail: 'Task was interrupted', currentTask: 'Old interrupted run', lastActivity: new Date(Date.now() - 24 * 3600000).toISOString() },
  { id: 'old-quiet', status: 'stale', currentTask: 'Old quiet run', lastActivity: new Date(Date.now() - 24 * 3600000).toISOString() },
  ...Array.from({ length: 8 }, (_, index) => ({ id: 'history-' + index, status: 'completed', currentTask: 'Completed session ' + (index + 1), toolHistory: [{ id: 'image-' + index, name: 'view_image', label: 'View image', status: 'completed', startedAt: now, completedAt: now }], cwd: '/home/project/agentobs', lastActivity: now }))
];
const model = liveMapModel(buildSessionForest(fixture));
assert.equal(JSON.stringify(model).includes(privateToolText), false, 'private tool data never reaches the browser model');
const demoNow = new Date().toISOString();
const demoTool = (id, name, label, current = false) => ({
  id, name, label, status: current ? 'in_progress' : 'completed', startedAt: demoNow,
  ...(current ? {} : { completedAt: demoNow })
});
const demoRoot = (overrides = {}) => ({
  id: 'chamfered-demo', status: 'active', currentTask: 'Prepare the public release',
  currentProgress: { text: 'Checking the release workspace.' }, cwd: '/home/project/agentobs',
  lastActivity: demoNow, tokenUsage: { input: 24300, cachedInput: 18200, output: 780 },
  ...overrides
});
const demoChild = (agentPath, agentName, currentTask, overrides = {}) => ({
  id: 'chamfered-demo', agentPath, agentName, status: 'active', currentTask,
  currentProgress: { text: 'Starting assigned work.' }, cwd: '/home/project/agentobs', lastActivity: demoNow,
  tokenUsage: { input: 3200, cachedInput: 2400, output: 180 }, ...overrides
});
const demoDetailTools = [
  demoTool('quality-read', 'read', 'Read'),
  demoTool('quality-rg', 'exec_command', 'Exec · rg'),
  demoTool('quality-patch', 'apply_patch', 'Apply patch'),
  demoTool('quality-npm', 'exec_command', 'Exec · npm'),
  demoTool('quality-python', 'exec_command', 'Exec · python3'),
  demoTool('quality-git', 'exec_command', 'Exec · git'),
  demoTool('quality-image', 'view_image', 'View image'),
  demoTool('quality-ls', 'exec_command', 'Exec · ls'),
  demoTool('quality-test', 'exec_command', 'Exec · npm'),
  demoTool('quality-summary', 'read', 'Read')
];
const demoModels = [
  liveMapModel(buildSessionForest([demoRoot({
    status: 'stale', currentTask: 'Waiting for the next release task',
    currentProgress: { text: 'No recent transcript activity.' },
    lastActivity: new Date(Date.now() - 20 * 60000).toISOString(),
    tokenUsage: { input: 1200, cachedInput: 800, output: 40 }
  })])),
  liveMapModel(buildSessionForest([demoRoot({
    currentProgress: { text: 'Reviewing the release plan before starting work.' },
    tokenUsage: { input: 3600, cachedInput: 2500, output: 90 }
  })])),
  liveMapModel(buildSessionForest([
    demoRoot({
      status: 'delegating', currentProgress: { text: 'Spawning focused subagents for the release review.' },
      tokenUsage: { input: 6400, cachedInput: 4800, output: 170 },
      currentTool: demoTool('spawn', 'spawn_agent', 'Spawn agent', true),
      toolHistory: [demoTool('read-plan', 'read', 'Read'), demoTool('spawn', 'spawn_agent', 'Spawn agent', true)],
      spawnedAgentPaths: ['/root/release-notes', '/root/quality-check'],
      spawnedAgents: [
        { agentPath: '/root/release-notes', task: 'Draft release notes' },
        { agentPath: '/root/quality-check', task: 'Run quality checks' }
      ]
    }),
    demoChild('/root/release-notes', 'Release notes', 'Draft release notes', {
      status: 'starting', tokenUsage: { input: 200, cachedInput: 100, output: 10 }
    }),
    demoChild('/root/quality-check', 'Quality checks', 'Run quality checks', {
      status: 'starting', tokenUsage: { input: 200, cachedInput: 100, output: 10 }
    })
  ])),
  liveMapModel(buildSessionForest([
    demoRoot({
      status: 'delegating', currentProgress: { text: 'Release notes is working; quality checks is queued.' },
      tokenUsage: { input: 11200, cachedInput: 8600, output: 350 },
      toolHistory: [
        demoTool('read-plan', 'read', 'Read'),
        demoTool('spawn', 'spawn_agent', 'Spawn agent'),
        demoTool('root-git', 'exec_command', 'Exec · git')
      ],
      spawnedAgentPaths: ['/root/release-notes', '/root/quality-check']
    }),
    demoChild('/root/release-notes', 'Release notes', 'Draft release notes', {
      currentProgress: { text: 'Finding the user-visible changes.' },
      tokenUsage: { input: 3800, cachedInput: 2500, output: 180 },
      currentTool: demoTool('notes-search', 'exec_command', 'Exec · rg', true),
      toolHistory: [demoTool('notes-read', 'read', 'Read'), demoTool('notes-search', 'exec_command', 'Exec · rg', true)]
    }),
    demoChild('/root/quality-check', 'Quality checks', 'Run quality checks', {
      status: 'starting', currentProgress: { text: 'Queued until release notes finishes.' },
      tokenUsage: { input: 200, cachedInput: 100, output: 10 }
    })
  ])),
  liveMapModel(buildSessionForest([
    demoRoot({
      status: 'delegating', currentProgress: { text: 'Release notes is complete; quality checks is now running.' },
      tokenUsage: { input: 16800, cachedInput: 12900, output: 560 },
      toolHistory: [
        demoTool('read-plan', 'read', 'Read'),
        demoTool('spawn', 'spawn_agent', 'Spawn agent'),
        demoTool('root-git', 'exec_command', 'Exec · git')
      ],
      spawnedAgentPaths: ['/root/release-notes', '/root/quality-check']
    }),
    demoChild('/root/release-notes', 'Release notes', 'Draft release notes', {
      status: 'completed', currentProgress: { text: 'Release notes are ready.' },
      tokenUsage: { input: 6200, cachedInput: 4400, output: 340 },
      toolHistory: [demoTool('notes-search', 'exec_command', 'Exec · rg'), demoTool('notes-python', 'exec_command', 'Exec · python3')]
    }),
    demoChild('/root/quality-check', 'Quality checks', 'Run quality checks', {
      currentProgress: { text: 'Checking browser scenarios.' },
      tokenUsage: { input: 3400, cachedInput: 2300, output: 170 },
      currentTool: demoTool('quality-test', 'exec_command', 'Exec · npm', true),
      toolHistory: [
        demoTool('quality-read', 'read', 'Read'),
        demoTool('quality-rg', 'exec_command', 'Exec · rg'),
        demoTool('quality-test', 'exec_command', 'Exec · npm', true)
      ]
    })
  ])),
  liveMapModel(buildSessionForest([
    demoRoot({
      currentProgress: { text: 'Packaging the completed release work.' },
      tokenUsage: { input: 21300, cachedInput: 16100, output: 710 },
      currentTool: demoTool('package', 'exec_command', 'Exec · npm', true),
      toolHistory: [
        demoTool('read-plan', 'read', 'Read'),
        demoTool('spawn', 'spawn_agent', 'Spawn agent'),
        demoTool('root-git', 'exec_command', 'Exec · git'),
        demoTool('package', 'exec_command', 'Exec · npm', true)
      ],
      spawnedAgentPaths: ['/root/release-notes', '/root/quality-check']
    }),
    demoChild('/root/release-notes', 'Release notes', 'Draft release notes', {
      status: 'completed', currentProgress: { text: 'Release notes are ready.' },
      tokenUsage: { input: 6200, cachedInput: 4400, output: 340 },
      toolHistory: [demoTool('notes-python', 'exec_command', 'Exec · python3')]
    }),
    demoChild('/root/quality-check', 'Quality checks', 'Run quality checks', {
      status: 'completed', currentProgress: { text: 'All quality checks passed.' },
      tokenUsage: { input: 5900, cachedInput: 4100, output: 300 },
      toolHistory: demoDetailTools
    })
  ])),
  liveMapModel(buildSessionForest([
    demoRoot({
      currentProgress: { text: 'Reviewing the completed release work.' },
      tokenUsage: { input: 24300, cachedInput: 18200, output: 780 },
      toolHistory: [
        demoTool('read-plan', 'read', 'Read'),
        demoTool('spawn', 'spawn_agent', 'Spawn agent'),
        demoTool('root-git', 'exec_command', 'Exec · git'),
        demoTool('package', 'exec_command', 'Exec · npm')
      ],
      spawnedAgentPaths: ['/root/release-notes', '/root/quality-check']
    }),
    demoChild('/root/release-notes', 'Release notes', 'Draft release notes', {
      status: 'completed', currentProgress: { text: 'Release notes are ready.' },
      tokenUsage: { input: 6200, cachedInput: 4400, output: 340 },
      toolHistory: [demoTool('notes-python', 'exec_command', 'Exec · python3')]
    }),
    demoChild('/root/quality-check', 'Quality checks', 'Run quality checks', {
      status: 'completed', currentProgress: { text: 'All quality checks passed.' },
      tokenUsage: { input: 5900, cachedInput: 4100, output: 300 },
      toolHistory: demoDetailTools
    })
  ]))
];
const css = pathToFileURL(path.resolve(__dirname, '../media/live-map.css')).href;
const js = pathToFileURL(path.resolve(__dirname, '../media/live-map.js')).href;
fs.writeFileSync(path.join(temporary, 'theme.css'), `
:root { --vscode-font-family: system-ui; --vscode-editor-background: #181818; --vscode-editorWidget-background: #202020; --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-panel-border: #383838; --vscode-input-background: #252525; --vscode-input-foreground: #ddd; --vscode-focusBorder: #4daafc; --vscode-testing-iconPassed: #89d185; --vscode-editorWarning-foreground: #d7ba7d; --vscode-testing-iconFailed: #f48771; }
:root[data-theme='light'] { --vscode-editor-background: #fff; --vscode-editorWidget-background: #f8f8f8; --vscode-foreground: #222; --vscode-descriptionForeground: #616161; --vscode-panel-border: #d5d5d5; --vscode-input-background: #fff; --vscode-input-foreground: #222; --vscode-testing-iconPassed: #287d2e; --vscode-editorWarning-foreground: #806000; --vscode-testing-iconFailed: #c42b1c; }
`);
fs.writeFileSync(path.join(temporary, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src file:; script-src 'nonce-test' file:;"><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="${css}"></head><body><main id="app"></main><script nonce="test">
window.model = ${JSON.stringify(model).replace(/</g, '\\u003c')};
window.selectionSource = 'sidebar';
window.renderMessage = () => structuredClone({ type: 'render', model: window.model, selectionSource: window.selectionSource });
window.emit = () => window.dispatchEvent(new MessageEvent('message', { data: window.renderMessage() }));
window.acquireVsCodeApi = () => ({ getState: () => undefined, setState: value => window.savedState = value, postMessage: message => {
  if (message.command === 'selectAgent') { window.model.selectedAgentKey = message.agentKey; window.selectionSource = 'map'; }
  if (message.command === 'closeInspector') delete window.model.selectedAgentKey;
  if (message.command === 'toggleDensity') window.model.compactDensity = !window.model.compactDensity;
  const snapshot = window.renderMessage();
  setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: snapshot })), 0);
} });
</script><script src="${js}"></script></body></html>`);

const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', '--user-data-dir=' + path.join(temporary, 'profile'), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let errors = '';
chrome.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-10000); });
let nextId = 0, buffer = '';
const pending = new Map();
const browserErrors = [];
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk;
  let boundary;
  while ((boundary = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
    if (!raw) continue;
    const response = JSON.parse(raw);
    if (response.method === 'Runtime.exceptionThrown') browserErrors.push(response.params.exceptionDetails);
    const request = pending.get(response.id);
    if (request) { pending.delete(response.id); clearTimeout(request.timer); response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result); }
  }
});
const rejectPending = (error) => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
chrome.stdio[3].on('error', rejectPending);
chrome.stdio[4].on('error', rejectPending);
chrome.on('error', rejectPending);
chrome.on('exit', (code) => rejectPending(new Error('Chrome exited ' + code + '\n' + errors)));
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Chrome timed out: ' + method + '\n' + errors)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  try {
    await send('Browser.getVersion');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const check = async (expression, description) => { assert.equal(await evaluate(expression), true, description); console.log('PASS ' + description); };
    const viewport = async (width, height = 1000) => { await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await pause(40); };
    const screenshot = async (name) => {
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(screenshotDir, name + '.png'), Buffer.from(data, 'base64'));
    };
    const drag = async (from, to) => {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      await pause(30);
    };
    await call('Runtime.enable'); await call('Page.enable'); await viewport(1360);
    await call('Page.navigate', { url: pathToFileURL(path.join(temporary, 'index.html')).href });
    for (let attempt = 0; attempt < 80; attempt++) { if (await evaluate("Boolean(document.querySelector('.agent'))")) break; await pause(25); }
    await check("document.querySelector('.inspector').hidden && !document.querySelector('.run-history').open", 'inspector hidden and history collapsed initially');
    await evaluate("[...document.querySelectorAll('.theme-toggle')].find(node => node.textContent === 'Theme: Default').click()"); await pause(30);
    await check("document.querySelector('#app').dataset.agentMapTheme === 'chamfered' && document.querySelector('.theme-toggle').textContent === 'Theme: Chamfered' && window.savedState.theme === 'chamfered' && getComputedStyle(document.querySelector('.agent')).borderRadius === '0px' && getComputedStyle(document.querySelector('.agent')).clipPath !== 'none' && getComputedStyle(document.querySelector('.tool-badge')).borderTopWidth === '0px' && getComputedStyle(document.querySelector('.tool-badge')).backgroundColor !== 'rgba(0, 0, 0, 0)' && Number(getComputedStyle(document.querySelector('.tool-badge')).fontWeight) >= 700 && getComputedStyle(document.querySelector('.status')).borderTopWidth === '0px' && getComputedStyle(document.querySelector('.summary-pill')).borderTopWidth === '0px' && getComputedStyle(document.querySelector('.agent-failed .status')).backgroundColor === 'rgb(214, 69, 60)'", 'Chamfered theme applies angular cards and solid high-contrast activity labels');
    await screenshot('chamfered');
    if (process.argv.includes('--capture-chamfered-frames')) {
      await evaluate('window.beforeChamferedDemo = window.model');
      await viewport(1200, 750);
      let frame = 0;
      for (const demo of demoModels) {
        await evaluate('window.model = ' + JSON.stringify(demo) + '; window.emit()');
        for (let tick = 0; tick < 8; tick++) {
          await pause(125);
          await screenshot('chamfered-demo-frame-' + String(frame++).padStart(2, '0'));
        }
      }
      await evaluate("document.querySelectorAll('.agent-completed')[1].click()");
      await pause(160);
      // Keep the sticky inspector wholly in frame while its content travels to
      // the final Session and Transcript fields.
      await evaluate('window.scrollTo(0, 220)');
      await pause(80);
      for (let tick = 0; tick < 8; tick++) {
        await pause(125);
        await screenshot('chamfered-demo-frame-' + String(frame++).padStart(2, '0'));
      }
      const inspectorScrollMax = await evaluate("(() => { const content = document.querySelector('.inspector-content'); return Math.max(0, content.scrollHeight - content.clientHeight); })()");
      for (let tick = 1; tick <= 32; tick++) {
        await evaluate('document.querySelector(\'.inspector-content\').scrollTop = ' + Math.round(inspectorScrollMax * tick / 32));
        await pause(125);
        await screenshot('chamfered-demo-frame-' + String(frame++).padStart(2, '0'));
      }
      for (let tick = 0; tick < 8; tick++) {
        await pause(125);
        await screenshot('chamfered-demo-frame-' + String(frame++).padStart(2, '0'));
      }
      await evaluate('window.model = window.beforeChamferedDemo; delete window.beforeChamferedDemo; window.emit()');
      await evaluate('window.scrollTo(0, 0)');
      await viewport(1360);
      await pause(30);
    }
    await evaluate("document.documentElement.dataset.theme = 'light'"); await pause(30);
    await screenshot('chamfered-light');
    await evaluate("document.documentElement.dataset.theme = 'dark'"); await pause(30);
    await viewport(360, 850);
    await check("document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.theme-toggle').textContent === 'Theme: Chamfered'", 'Chamfered theme remains usable without horizontal overflow on mobile');
    await viewport(1360);
    await evaluate("document.querySelector('.theme-toggle').click()"); await pause(30);
    await check("document.querySelector('#app').dataset.agentMapTheme === 'default' && document.querySelector('.theme-toggle').textContent === 'Theme: Default' && window.savedState.theme === 'default'", 'Default theme can be restored from the top-level toggle');
    await evaluate("window.beforeWelcomePreview = window.model; window.model = { ...window.model, forest: [], agents: {}, runs: [], selectedAgentKey: undefined }; window.emit()");
    await check("document.querySelector('.empty-welcome')?.textContent.includes('SYNTHETIC PREVIEW') && document.querySelectorAll('.example-card').length === 4 && document.querySelector('.example-details')?.textContent.includes('Recent tool history') && document.querySelector('.empty-welcome').textContent.includes('read-only')", 'empty workspace explains the observer with a detailed synthetic agent-map preview');
    await screenshot('empty-workspace-preview');
    await viewport(360, 850);
    await check("document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.example-details').getBoundingClientRect().top >= document.querySelector('.example-map').getBoundingClientRect().bottom", 'synthetic preview stacks its agent details below the map on mobile');
    await viewport(1360);
    await evaluate('window.model = window.beforeWelcomePreview; delete window.beforeWelcomePreview; window.emit()');
    const simulationSeconds = process.argv.includes('--simulate-tool-3s') ? 3 : process.argv.includes('--simulate-tool-5s') ? 5 : process.argv.includes('--simulate-tool-10s') ? 10 : 30;
    const simulationRecords = [
      { type: 'session_meta', payload: { session_id: 'tool-simulation', cli_version: '0.164.0' } },
      { type: 'event_msg', timestamp: now, payload: { type: 'task_started' } },
      ...['git', 'npm', 'rg', 'ls'].flatMap(command => [
        { type: 'response_item', timestamp: now, payload: { type: 'custom_tool_call', call_id: command, name: 'exec', status: 'completed', input: command } },
        { type: 'response_item', timestamp: now, payload: { type: 'custom_tool_call_output', call_id: command, output: 'Done' } }
      ]),
      { type: 'response_item', timestamp: now, payload: { type: 'custom_tool_call', call_id: 'slow-tool', name: 'exec', status: 'completed', input: 'python3 simulation.py' } },
      { type: 'response_item', timestamp: now, payload: { type: 'custom_tool_call_output', call_id: 'slow-tool', output: [
        { type: 'input_text', text: 'Script completed' },
        { type: 'input_text', text: JSON.stringify({ chunk_id: 'simulation', wall_time_seconds: 1, session_id: 75573, output: 'Tool active' }) }
      ] } }
    ];
    const simulationModel = records => {
      const session = summarizeTranscript(records, 'simulation.jsonl');
      session.currentTask = simulationSeconds + '-second yielded tool-use simulation';
      return liveMapModel(buildSessionForest([session]), { selectedAgentKey: agentKeyFor(session) });
    };
    await evaluate('window.beforeSimulation = window.model; window.model = ' + JSON.stringify(simulationModel(simulationRecords)) + '; window.emit()');
    const simulationDuration = ['--simulate-tool-3s', '--simulate-tool-5s', '--simulate-tool-10s', '--simulate-tool-30s'].some(flag => process.argv.includes(flag)) ? simulationSeconds * 1000 : 0;
    const thinkingSimulationSeconds = process.argv.includes('--simulate-thinking-3s') ? 3 : process.argv.includes('--simulate-thinking-5s') ? 5 : process.argv.includes('--simulate-thinking-10s') ? 10 : 0;
    const thinkingSimulationDuration = thinkingSimulationSeconds * 1000;
    const simulationStart = Date.now();
    for (const seconds of [...new Set([0, Math.floor(simulationSeconds / 6), simulationSeconds / 2, simulationSeconds])]) {
      await pause(Math.max(0, simulationStart + seconds / simulationSeconds * simulationDuration - Date.now()));
      await evaluate('window.emit()');
      await check("!document.querySelector('.agent .thinking-pill') && !document.querySelector('.inspector .thinking-pill') && !document.querySelector('.agent-tool .status') && document.querySelector('.agent .is-current').textContent === 'Exec · python3' && document.querySelector('.agent .recent-tools').children.length === 5 && getComputedStyle(document.querySelector('.agent .is-current'), '::after').animationName === 'active-sheen' && getComputedStyle(document.querySelector('.agent .is-current'), '::after').animationDirection === 'alternate'", 'yielded tool simulation at ' + seconds + 's shows the animated current tool without Thinking or a duplicate status');
      if (seconds === simulationSeconds / 2) await screenshot('tool-simulation-running');
    }
    simulationRecords.push({ type: 'event_msg', timestamp: new Date(Date.parse(now) + simulationSeconds * 1000).toISOString(), payload: { type: 'item_completed', item: { type: 'CommandExecution', process_id: '75573', exit_code: 0, status: 'completed' } } });
    await evaluate('window.model = ' + JSON.stringify(simulationModel(simulationRecords)) + '; window.emit()');
    const thinkingStart = Date.now();
    for (const seconds of thinkingSimulationSeconds ? [0, Math.floor(thinkingSimulationSeconds / 2), thinkingSimulationSeconds] : [0]) {
      await pause(Math.max(0, thinkingStart + seconds / Math.max(thinkingSimulationSeconds, 1) * thinkingSimulationDuration - Date.now()));
      await evaluate('window.emit()');
      await check("document.querySelector('.agent .thinking-pill')?.textContent === 'Thinking' && !document.querySelector('.agent .is-current') && document.querySelector('.agent .recent-tools').children.length === 5 && getComputedStyle(document.querySelector('.agent .thinking-pill'), '::after').animationName === 'active-sheen' && getComputedStyle(document.querySelector('.agent .thinking-pill'), '::after').animationDirection === 'alternate'", (thinkingSimulationSeconds ? thinkingSimulationSeconds + '-second thinking simulation at ' + seconds + 's' : 'Thinking returns') + ' with the active light sweep');
      if (thinkingSimulationSeconds && seconds === Math.floor(thinkingSimulationSeconds / 2)) await screenshot('thinking-simulation-running');
    }
    await screenshot('tool-simulation-finished');
    await evaluate('window.model = window.beforeSimulation; delete window.beforeSimulation; window.emit()');
    await check("document.querySelector('.agent-working .phase .tool-badge')?.textContent === 'Exec · ls' && JSON.stringify([...document.querySelectorAll('.agent-failed .recent-tools .tool-badge')].map(node => node.textContent)) === JSON.stringify(['Exec · python3', 'Exec · npm', 'Exec · rg', 'Apply patch', 'Read']) && !document.querySelector('.card-top .tool-badge') && !document.querySelector('.agent-working .phase-label')", 'cards show five latest tools newest first in the activity row, separate from status');
    await evaluate("window.thinkingTools = window.model.forest[0].recentTools; window.model.forest[0].recentTools = ['Exec', 'Exec · npm', 'Exec · python3', 'Exec · git', 'Read'].map(label => ({ name: label === 'Read' ? 'read' : 'exec_command', label, status: 'completed' })); window.emit()");
    await check("JSON.stringify([...document.querySelector('.agent-working .recent-tools').children].map(node => node.textContent)) === JSON.stringify(['Thinking', 'Exec', 'Exec · npm', 'Exec · python3', 'Exec · git']) && !document.querySelector('.agent-working .status') && getComputedStyle(document.querySelector('.agent-working .thinking-pill')).color === getComputedStyle(document.querySelector('.summary-pill.status-working')).color", 'green Thinking pill precedes recent calls without a duplicate Working status');
    await screenshot('thinking-with-tools');
    await evaluate("window.model.forest[0].recentTools = []; window.emit()");
    await check("document.querySelector('.agent-working .recent-tools').children.length === 1 && document.querySelector('.agent-working .thinking-pill').textContent === 'Thinking' && !document.querySelector('.agent-input .thinking-pill') && !document.querySelector('.completed-history .thinking-pill')", 'Thinking remains visible without history and is absent from non-thinking cards');
    await evaluate("window.model.forest[0].recentTools = window.thinkingTools; window.emit()");
    await check("JSON.stringify([...document.querySelectorAll('.agent-input .recent-tools .tool-badge')].map(node => node.textContent)) === JSON.stringify(['Request user input', 'Exec · npm', 'Exec · rg', 'Exec · ls', 'Read']) && document.querySelector('.agent-input .recent-tools .tool-badge:first-child').classList.contains('is-current') && document.querySelector('.agent-input .is-current').title.startsWith('Current tool in use:') && document.querySelectorAll('.agent-input .is-current').length === 1 && !document.querySelector('.agent-input .card-top .tool-badge')", 'current tool shares the recent tools row, appears once, and counts toward five');
    await check("document.querySelector('.completed-history .tool-badge')?.textContent === 'View image' && getComputedStyle(document.querySelector('.completed-history .tool-badge')).color !== getComputedStyle(document.querySelector('.agent-working .tool-badge')).color", 'completed history retains tool labels and distinct type colors');
    await check("document.querySelectorAll('.tree .agent-quiet').length === 1 && document.querySelectorAll('.tree .agent-failed').length === 1", 'recent quiet and failed agents stay visible');
    await check("!document.querySelector('.inactive-history').open && document.querySelectorAll('.inactive-history .agent').length === 3 && document.querySelectorAll('.tree .agent-interrupted').length === 0", 'day-old failed, interrupted and quiet agents move to collapsed inactive history');
    await check("document.querySelector('.summary .status-failed').textContent.startsWith('1 ') && document.querySelector('.summary .status-quiet').textContent.startsWith('1 ') && document.querySelector('.summary .status-inactive').textContent.startsWith('3 ')", 'inactive agents are excluded from live issue counts');
    await screenshot('wide');
    await check("document.querySelector('.branch-toggle').textContent === '▾ 2 agents (14.9k in · 11.3k cached · 1k out)'", 'subagent count shows combined usage including completed children');
    await evaluate("document.querySelector('input').focus(); document.querySelector('input').value = 'parser'; document.querySelector('input').dispatchEvent(new Event('input')); window.focusedInput = document.activeElement; window.emit()");
    await check("document.activeElement === window.focusedInput && document.querySelectorAll('.tree .agent').length === 2", 'search retains parent context and keyboard focus across refresh');
    await check("document.querySelector('.branch-toggle').textContent.includes('2 agents (14.9k in · 11.3k cached · 1k out)')", 'search does not change cumulative subagent totals');
    await evaluate("window.selectionSearches = []; window.observeSelection = event => { if (event.data?.type === 'render') window.selectionSearches.push(document.querySelector('input').value); }; window.addEventListener('message', window.observeSelection); document.querySelector('.agent-failed').click(); document.querySelector('.tree > .agent-node > .node-row > .agent').click()"); await pause(30);
    await check("window.selectionSearches.length === 2 && window.selectionSearches.every(value => value === 'parser') && document.querySelector('.inspector h2').textContent === 'Improve the observer and live agent map'", 'rapid local selections preserve search through each ordered host acknowledgement');
    await evaluate("window.removeEventListener('message', window.observeSelection)");
    await evaluate("document.querySelector('.agent-failed').click()"); await pause(30);
    await check("document.querySelector('input').value === 'parser' && window.savedState.search === 'parser' && document.querySelectorAll('.tree .agent').length === 2 && document.querySelector('.inspector h2').textContent === 'Verify parser compatibility'", 'selecting a search result preserves search after the host echo');
    await evaluate("document.querySelector('input').value = ''; document.querySelector('input').dispatchEvent(new Event('input')); document.querySelector('.agent-failed').click()"); await pause(30);
    await check("!document.querySelector('.inspector').hidden && document.querySelector('.inspector h2').textContent === 'Verify parser compatibility'", 'selecting a card opens its details');
    await check("[...document.querySelectorAll('.inspector h3')].some(node => node.textContent === 'Transcript') && document.querySelector('.inspector-content').textContent.includes('Codex version0.164.0') && document.querySelector('.inspector-content').textContent.includes('Parser statussupported') && document.querySelector('.inspector-content').textContent.includes('Resolved byVerified parser for the 0.164 transcript family')", 'details show the Codex version and parser resolution method');
    await check("document.querySelector('.tool-entry .tool-duration').textContent === '1.2s' && document.querySelector('.tool-entry .tool-result-summary').textContent.includes('4 passed · 1 failed') && document.querySelector('.tool-entry .detail-list').textContent.includes('Exit code1') && document.querySelector('.tool-entry .detail-list').textContent.includes('Attempt2 of 3') && document.querySelector('.tool-entry .detail-list').textContent.includes('Elevated permissions') && document.querySelector('.tool-entry .detail-list').textContent.includes('Session workspace')", 'history shows duration, exit code, test totals, retries and coarse execution context');
    await check("[...document.querySelectorAll('.tool-entry')].some(node => node.querySelector('.tool-name').textContent === 'Exec · npm' && node.querySelector('.tool-state').textContent === 'Passed' && node.textContent.includes('69 passed · 0 failed') && node.textContent.includes('Exit code0')) && document.querySelector('.tool-history').textContent.includes('12 matches in 4 files') && document.querySelector('.tool-history').textContent.includes('Patch scope: 1 file · +2 −1') && document.querySelector('.tool-history').textContent.includes('120 lines read · 4.1 KB read')", 'compact results summarize tests, searches, patch scope and reads without raw output');
    await check("!document.documentElement.outerHTML.includes('SHOULD_NOT_REACH_WEBVIEW')", 'tool secrets never appear in webview text or attributes');
    await check("document.querySelectorAll('.tool-history .tool-badge').length === 6 && new Set([...document.querySelectorAll('.tool-history .tool-badge')].map(node => getComputedStyle(node).color)).size === 6 && getComputedStyle(document.querySelector('.tool-history .tool-badge')).color === getComputedStyle(document.querySelector('.agent-failed .tool-badge')).color && getComputedStyle(document.querySelector('.agent-working .tool-badge')).color !== getComputedStyle(document.querySelector('.agent-failed .tool-badge')).color", 'history colors distinguish exec command variants and match each card label');
    await evaluate("window.darkExecColor = getComputedStyle(document.querySelector('.agent-working .tool-badge')).color; window.previousTools = window.model.forest[0].recentTools; window.model.forest[0].recentTools = [{ name: 'read', label: 'Read', status: 'completed' }, ...window.previousTools]; window.emit()");
    await check("document.querySelector('.agent-working .tool-badge').textContent === 'Read' && getComputedStyle(document.querySelector('.agent-working .tool-badge')).color !== window.darkExecColor && !document.querySelector('.agent-working .status') && document.querySelectorAll('.agent-working .recent-tools .tool-badge').length === 2", 'live updates prepend recent calls without adding a duplicate Working status');
    await evaluate("window.model.forest[0].recentTools = window.previousTools; window.emit()");
    await evaluate("window.toolDetails = document.querySelector('.tool-entry'); window.toolDetails.open = true; window.toolDetails.querySelector('summary').focus(); window.focusedTool = document.activeElement; document.querySelector('.inspector-content').scrollTop = 130; window.inspectorScroll = document.querySelector('.inspector-content').scrollTop; window.emit()");
    await check("document.querySelector('.tool-entry') === window.toolDetails && window.toolDetails.open && document.activeElement === window.focusedTool && document.querySelector('.inspector-content').scrollTop === window.inspectorScroll", 'refresh preserves expanded tools, focus and inspector scroll');
    await check("document.querySelector('.inspector').getBoundingClientRect().left > document.querySelector('.map-content').getBoundingClientRect().right && document.querySelector('.inspector').getBoundingClientRect().width <= 320", 'wide layout places a bounded inspector beside map');
    await screenshot('wide-inspector');
    await check("document.querySelector('.inspector-resizer').getAttribute('role') === 'separator' && !document.querySelector('.inspector-resizer').hidden", 'selected details expose one accessible width divider');
    await evaluate("window.inspectorWidthBefore = document.querySelector('.inspector').getBoundingClientRect().width");
    const firstDivider = JSON.parse(await evaluate("JSON.stringify(document.querySelector('.inspector-resizer').getBoundingClientRect().toJSON())"));
    await drag({ x: firstDivider.x + firstDivider.width / 2, y: firstDivider.y + 80 }, { x: firstDivider.x + firstDivider.width / 2 - 90, y: firstDivider.y + 80 });
    await check("document.querySelector('.inspector').getBoundingClientRect().width >= window.inspectorWidthBefore + 80 && window.savedState.inspectorWidth === Math.round(document.querySelector('.inspector').getBoundingClientRect().width) && document.querySelector('.inspector-resizer').getAttribute('aria-valuenow') === String(Math.round(document.querySelector('.inspector').getBoundingClientRect().width))", 'dragging left widens details and saves the selected width');
    await evaluate("window.resizedInspectorWidth = document.querySelector('.inspector').getBoundingClientRect().width; window.emit()");
    await check("document.querySelector('.inspector').getBoundingClientRect().width === window.resizedInspectorWidth", 'details width survives a live refresh');
    const secondDivider = JSON.parse(await evaluate("JSON.stringify(document.querySelector('.inspector-resizer').getBoundingClientRect().toJSON())"));
    await drag({ x: secondDivider.x + secondDivider.width / 2, y: secondDivider.y + 80 }, { x: secondDivider.x + secondDivider.width / 2 + 500, y: secondDivider.y + 80 });
    await check("document.querySelector('.inspector').getBoundingClientRect().width <= 220 && window.savedState.inspectorWidth === 220", 'dragging right respects the compact details minimum');
    await evaluate("document.querySelector('.branch-toggle').click(); window.emit()");
    await check("document.querySelector('.branch-toggle').getAttribute('aria-expanded') === 'false' && document.querySelector('.children').hidden", 'collapsed branches survive refresh');
    await evaluate("document.querySelector('.branch-toggle').click()");
    await check("!document.querySelector('.children').hidden && document.querySelector('.children > .agent-node .agent-completed').getClientRects().length > 0 && !document.querySelector('.children details')", 'expanding agents reveals completed subagents directly');
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await check("document.querySelector('.inspector').hidden && document.activeElement.classList.contains('agent-failed')", 'closing inspector restores focus to selected card');
    await evaluate("document.querySelector('select').value = " + JSON.stringify(agentKeyFor({ id: 'run-b' })) + "; document.querySelector('select').dispatchEvent(new Event('change'))");
    await check("document.querySelectorAll('.tree .agent').length === 1 && document.querySelector('.task-title').textContent === 'Review deployment checks'", 'run selector isolates a run');
    await evaluate("document.querySelector('select').value = ''; document.querySelector('select').dispatchEvent(new Event('change')); [...document.querySelectorAll('.toolbar-button')].find(node => node.textContent === 'Needs attention').click()");
    await check("document.querySelectorAll('.agent-quiet').length === 1 && document.querySelectorAll('.agent-input').length === 1 && !document.querySelector('.run-history')", 'attention filter retains quiet, failed and input requests');
    await evaluate("document.querySelector('.agent-input').click()"); await pause(30);
    await check("[...document.querySelectorAll('.toolbar-button')].find(node => node.textContent === 'Needs attention').getAttribute('aria-pressed') === 'true' && window.savedState.attentionOnly && document.querySelectorAll('.agent-quiet').length === 1 && !document.querySelector('.run-history') && document.querySelector('.inspector h2').textContent === 'Review deployment checks'", 'selecting an attention result preserves the attention filter after the host echo');
    await evaluate("window.originalNow = Date.now; window.clockBaseline = Date.now(); Date.now = () => window.clockBaseline; window.model.agents[window.model.selectedAgentKey].toolHistory[0].startedAt = new Date(window.clockBaseline - 65000).toISOString(); window.emit()");
    await check("[...document.querySelectorAll('.tool-entry')].some(node => node.querySelector('.tool-state').textContent === 'Running' && node.querySelector('.tool-duration').textContent === '1m 5s' && node.querySelector('.tool-duration').title === 'Elapsed time')", 'running history entries display elapsed duration');
    await evaluate("Date.now = () => window.clockBaseline + 5000; window.emit()");
    await check("[...document.querySelectorAll('.tool-entry')].some(node => node.querySelector('.tool-state').textContent === 'Running' && node.querySelector('.tool-duration').textContent === '1m 10s')", 'elapsed duration updates on live refresh');
    await evaluate("Date.now = window.originalNow");
    await evaluate("document.querySelector('input').value = 'parser'; document.querySelector('input').dispatchEvent(new Event('input')); document.querySelector('.agent-failed').click()"); await pause(30);
    await evaluate("window.emit()");
    await check("document.querySelector('input').value === 'parser' && window.savedState.search === 'parser' && window.savedState.attentionOnly && document.querySelectorAll('.tree .agent').length === 2 && document.querySelector('.inspector h2').textContent === 'Verify parser compatibility'", 'combined search and attention filters survive selection and subsequent refresh');
    await evaluate("document.querySelector('select').value = " + JSON.stringify(agentKeyFor({ id: 'run-b' })) + "; document.querySelector('select').dispatchEvent(new Event('change')); window.selectionSource = 'sidebar'; window.model.selectedAgentKey = " + JSON.stringify(agentKeyFor({ id: 'history-0' })) + "; window.emit()");
    await check("document.querySelector('.run-history').open && document.querySelector('.agent.selected .task-title').textContent === 'Completed session 1' && document.querySelector('input').value === '' && !window.savedState.attentionOnly && document.querySelector('select').value === window.model.selectedAgentKey", 'sidebar selection clears restrictive filters and reveals a completed agent in another run');
    await evaluate("document.querySelector('select').value = ''; document.querySelector('select').dispatchEvent(new Event('change'))");
    await evaluate("window.model.selectedAgentKey = " + JSON.stringify(agentKeyFor({ id: 'old-interrupted' })) + "; window.emit()");
    await check("document.querySelector('.inactive-history').open && document.querySelector('.inspector h2').textContent === 'Old interrupted run' && document.querySelector('.inactive-history .agent.selected .status').textContent === 'Interrupted'", 'inactive agents remain inspectable with their original status');
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await evaluate("document.querySelectorAll('.run-history').forEach(node => node.open = false)");
    await viewport(1100);
    await evaluate("document.querySelector('.agent-input').click()"); await pause(30);
    await check(
      `(() => {
        const inspector = document.querySelector('.inspector');
        const map = document.querySelector('.map-content');
        const inspectorBox = inspector.getBoundingClientRect();
        return getComputedStyle(inspector).position === 'sticky'
          && inspectorBox.left > map.getBoundingClientRect().right
          && inspectorBox.width <= 281
          && map.getBoundingClientRect().width >= 700;
      })()`,
      'mid-wide details stay compact beside a usable map',
    );
    await screenshot('mid-wide-sidebar');
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await viewport(1200);
    await evaluate("document.querySelector('.agent-input').click()"); await pause(30);
    await check(
      `(() => {
        const inspector = document.querySelector('.inspector');
        const map = document.querySelector('.map-content');
        const inspectorBox = inspector.getBoundingClientRect();
        return getComputedStyle(inspector).position === 'sticky'
          && inspectorBox.left > map.getBoundingClientRect().right
          && inspectorBox.width <= 320;
      })()`,
      'wide details stay beside the map at their bounded width',
    );
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await viewport(840);
    await evaluate("document.querySelector('.agent-input').click()"); await pause(30);
    await check(
      `(() => {
        const inspector = document.querySelector('.inspector');
        const map = document.querySelector('.map-content');
        const inspectorBox = inspector.getBoundingClientRect();
        return getComputedStyle(inspector).position === 'sticky'
          && inspectorBox.left > map.getBoundingClientRect().right
          && inspectorBox.width <= 241
          && map.getBoundingClientRect().width >= 500;
      })()`,
      'compact details stay beside cards at 840px',
    );
    await screenshot('compact-sidebar');
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await viewport(765);
    await check('document.documentElement.scrollWidth <= window.innerWidth', '765px layout has no horizontal overflow');
    await evaluate("document.querySelector('.agent-input').click()"); await pause(30);
    await check(
      `(() => {
        const inspector = document.querySelector('.inspector');
        const map = document.querySelector('.map-content');
        const inspectorBox = inspector.getBoundingClientRect();
        return getComputedStyle(inspector).position === 'sticky'
          && inspectorBox.left > map.getBoundingClientRect().right
          && inspectorBox.width <= 221
          && map.getBoundingClientRect().width >= 440;
      })()`,
      'compact details stay beside cards at 765px',
    );
    await screenshot('narrow-sidebar');
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await viewport(719);
    await check('document.documentElement.scrollWidth <= window.innerWidth', '719px layout has no horizontal overflow');
    await evaluate("document.querySelector('.agent-input').click()"); await pause(30);
    await check("getComputedStyle(document.querySelector('.inspector')).position === 'fixed' && document.querySelector('.inspector').getBoundingClientRect().bottom <= window.innerHeight && document.querySelector('.inspector').getBoundingClientRect().height <= window.innerHeight * .55 + 1", 'sub-720px inspector becomes a bounded drawer');
    await screenshot('narrow-inspector');
    await viewport(360, 850);
    await check('document.documentElement.scrollWidth <= window.innerWidth', '360px layout has no horizontal overflow');
    await screenshot('mobile-inspector');
    await evaluate("window.model.forest[0].recentTools = [{ name: 'plugin.custom_tool', label: 'Long tool name '.repeat(30) }, ...window.previousTools]; window.emit()");
    await check("document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.agent-working .tool-badge').title.includes('Long tool name')", 'long tool labels remain bounded and available on hover on mobile');
    await evaluate("window.model.forest[0].recentTools = window.previousTools; window.emit()");
    await evaluate("document.documentElement.dataset.theme = 'light'; document.querySelector('.inspector-header button').click()"); await pause(30); await viewport(765);
    await check("getComputedStyle(document.querySelector('.agent-working .tool-badge')).color !== window.darkExecColor && getComputedStyle(document.querySelector('.agent-working .tool-badge')).color !== getComputedStyle(document.querySelector('.agent-failed .tool-badge')).color", 'light theme adjusts colors while keeping exec command variants distinct');
    await screenshot('light');
    await evaluate("document.querySelector('.agent-failed').click()"); await pause(30);
    await check("new Set([...document.querySelectorAll('.tool-history .tool-badge')].map(node => getComputedStyle(node).color)).size === 6 && getComputedStyle(document.querySelector('.tool-history .tool-badge')).color === getComputedStyle(document.querySelector('.agent-failed .tool-badge')).color", 'light theme keeps history colors distinct and consistent with cards');
    await screenshot('light-inspector');
    await evaluate("document.querySelector('.inspector-header button').click()"); await pause(30);
    await evaluate("window.model.forest[0].children.push(window.model.forest.find(node => node.title === 'Old failed run')); window.emit()");
    await check("document.querySelector('.children').children.length === 3 && !document.querySelector('.children details') && document.querySelectorAll('.children > .agent-node .agent-failed').length === 2", 'inactive subagents also appear directly under their parent');
    await evaluate("window.model.forest[0].title = '<img src=x onerror=alert(1)>'; window.emit()");
    await check("!document.querySelector('.agent img') && document.querySelector('.task-title').textContent.includes('<img')", 'task text renders safely without interpreting markup');
    assert.deepEqual(browserErrors, [], 'no browser exceptions');
    console.log('PASS no browser exceptions');
    console.log('Screenshots: ' + screenshotDir);
  } finally {
    chrome.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
