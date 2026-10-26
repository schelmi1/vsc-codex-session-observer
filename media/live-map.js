(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  const savedInspectorWidth = Number.isFinite(saved.inspectorWidth) && saved.inspectorWidth >= 220 && saved.inspectorWidth <= 480 ? Math.round(saved.inspectorWidth) : undefined;
  const ui = { search: saved.search || '', runKey: saved.runKey || '', attentionOnly: Boolean(saved.attentionOnly), collapsed: new Set(saved.collapsed || []), inspectorWidth: savedInspectorWidth, theme: saved.theme === 'chamfered' ? 'chamfered' : 'default', selected: undefined };
  const labels = { working: 'Working', tool: 'Running tool', input: 'Needs input', starting: 'Starting', quiet: 'Quiet', failed: 'Failed', interrupted: 'Interrupted', completed: 'Completed', unknown: 'Unknown' };
  let state;
  let lastHostSelection;
  const element = (tag, className, text, key) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (key !== undefined) node.dataset.key = key;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className, text);
    node.type = 'button'; node.onclick = action;
    return node;
  };
  const persist = () => vscode.setState({ search: ui.search, runKey: ui.runKey, attentionOnly: ui.attentionOnly, collapsed: [...ui.collapsed], inspectorWidth: ui.inspectorWidth, theme: ui.theme });
  const elapsedSince = (iso) => {
    const timestamp = Date.parse(iso || '');
    if (!Number.isFinite(timestamp)) return 'Time unknown';
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    return Math.floor(seconds / 86400) + 'd';
  };
  const exactCount = (count) => Number.isFinite(count) ? new Intl.NumberFormat().format(count) : '—';
  const shortCount = (count) => Number.isFinite(count) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count).toLowerCase() : '—';
  const exactUsage = (usage) => 'Input: ' + exactCount(usage.input) + ' · Cached: ' + exactCount(usage.cachedInput) + ' · Output: ' + exactCount(usage.output);
  const bytes = value => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
  const toolDuration = tool => {
    const start = Date.parse(tool.startedAt || tool.timestamp || '');
    const end = tool.status === 'in_progress' ? Date.now() : Date.parse(tool.completedAt || '');
    const recorded = tool.status !== 'in_progress' ? tool.details?.durationMs : undefined;
    const milliseconds = Number.isFinite(recorded) ? recorded : Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
    if (milliseconds === undefined) return undefined;
    if (milliseconds < 1000) return Math.round(milliseconds) + ' ms';
    if (milliseconds < 60000) return (milliseconds / 1000).toFixed(1) + 's';
    return Math.floor(milliseconds / 60000) + 'm ' + Math.floor((milliseconds % 60000) / 1000) + 's';
  };
  const failureLabels = { timeout: 'Timeout', permission: 'Permission denied', cancelled: 'Cancelled', process: 'Process failed', tool: 'Tool failed' };
  const toolResultSummary = (details = {}) => {
    const parts = [];
    if (details.testsPassed !== undefined && details.testsFailed !== undefined) {
      parts.push(exactCount(details.testsPassed) + ' passed', exactCount(details.testsFailed) + ' failed');
      if (details.testsSkipped) parts.push(exactCount(details.testsSkipped) + ' skipped');
    }
    if (details.matches !== undefined) parts.push(exactCount(details.matches) + ' matches' + (details.matchedFiles !== undefined ? ' in ' + exactCount(details.matchedFiles) + ' files' : ''));
    if (details.patchFiles !== undefined) parts.push('Patch scope: ' + exactCount(details.patchFiles) + (details.patchFiles === 1 ? ' file' : ' files'), '+' + exactCount(details.patchLinesAdded) + (details.patchLinesRemoved !== undefined ? ' −' + exactCount(details.patchLinesRemoved) : ''));
    if (details.linesRead !== undefined) parts.push(exactCount(details.linesRead) + ' lines read');
    if (details.bytesRead !== undefined) parts.push(bytes(details.bytesRead) + ' read');
    if (details.results !== undefined) parts.push(exactCount(details.results) + ' results');
    if (details.agentsStarted !== undefined) parts.push(exactCount(details.agentsStarted) + ' agents started');
    if (details.agentsFinished !== undefined) parts.push(exactCount(details.agentsFinished) + ' agents finished');
    if (details.failure && failureLabels[details.failure]) parts.push(failureLabels[details.failure]);
    if (!parts.length && details.outputBytes !== undefined) parts.push(exactCount(details.outputLines) + ' lines output', bytes(details.outputBytes));
    if (details.outputTruncated) parts.push('output truncated');
    return parts.join(' · ');
  };
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const hasLive = (node) => !node.archived || node.children.some(hasLive);
  const hasInactive = (node) => node.historyGroup === 'inactive' || node.children.some(hasInactive);
  const badge = (agent) => element('span', 'status status-' + agent.displayState, labels[agent.displayState]);
  const toolColors = new Map(Object.entries({ exec: 0, exec_command: 0, read: 1, apply_patch: 2, view_image: 3, spawn_agent: 4, send_message: 5, wait_agent: 6, wait: 7, write_stdin: 8, request_user_input: 9, search_query: 10, web_search_call: 10, tool_search_call: 11, followup_task: 12, list_agents: 13, interrupt_agent: 14, request_user_input_async: 15 }));
  const execCommands = 'git rg npm pnpm yarn node npx sed find ls cat head tail curl docker python python3 cargo go make code'.split(' ');
  const toolBadge = (tool, className = '') => {
    const name = String(tool.name || 'tool');
    const type = name.split('.').at(-1).toLowerCase();
    const command = ['exec', 'exec_command'].includes(type) ? tool.label?.split(' · ')[1]?.toLowerCase() : undefined;
    const commandIndex = execCommands.indexOf(command);
    // Exec aliases share the command's color, rather than one color for all commands.
    const color = commandIndex >= 0 ? 16 + commandIndex
      : toolColors.get(type) ?? [...name].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 16, 0);
    const node = element('span', 'tool-badge tool-color-' + color + (className ? ' ' + className : ''), tool.label || name);
    node.title = name;
    return node;
  };
  const exampleCard = (title, stateLabel, stateClass, tools, usage, child = false) => {
    const card = element('div', 'example-card' + (child ? ' example-child' : ''));
    const top = element('div', 'example-card-top');
    top.append(element('strong', '', title), element('span', 'status status-' + stateClass, stateLabel));
    card.append(top, element('span', 'example-usage', usage));
    const activity = element('div', 'example-activity');
    for (const tool of tools) activity.append(toolBadge({ name: 'exec_command', label: 'Exec · ' + tool, status: 'completed' }));
    card.append(activity);
    return card;
  };
  const exampleDetails = () => {
    const details = element('section', 'example-details');
    const header = element('div', 'example-details-header');
    header.append(element('span', 'example-label', 'AGENT DETAILS'), element('span', 'secondary', 'Example only'));
    details.append(header, element('h3', '', 'Review live workspace'));
    const phase = element('div', 'example-details-phase');
    phase.append(element('span', 'status status-tool', 'Running tool'), element('span', 'secondary', 'Exec · npm'));
    details.append(phase, element('p', 'example-update', 'Checking the responsive layout and preserving tool details during live updates.'));
    details.append(element('h4', '', 'Token usage'));
    const tokens = element('div', 'example-token-stats');
    for (const [label, value] of [['Input', '12,800'], ['Cached', '10,200'], ['Output', '940']]) {
      const stat = element('div'); stat.append(element('span', '', label), element('strong', '', value)); tokens.append(stat);
    }
    details.append(tokens, element('h4', '', 'Recent tool history'));
    const tools = element('ul', 'example-tool-history');
    for (const [label, result] of [['Exec · npm', 'Running · 3.1s'], ['Exec · rg', '12 matches · Done'], ['Read', '120 lines · Done']]) {
      const item = element('li'); item.append(toolBadge({ name: label === 'Read' ? 'read' : 'exec_command', label, status: 'completed' }), element('span', '', result)); tools.append(item);
    }
    details.append(tools, element('h4', '', 'Transcript'));
    const transcript = element('dl', 'example-transcript');
    for (const [label, value] of [['Codex version', '0.164.0'], ['Parser status', 'Supported'], ['Resolved by', 'Verified parser']]) transcript.append(element('dt', '', label), element('dd', '', value));
    details.append(transcript);
    return details;
  };
  const welcomePreview = () => {
    const welcome = element('section', 'empty empty-welcome', undefined, 'welcome');
    welcome.setAttribute('aria-label', 'Synthetic live agent map preview');
    welcome.append(
      element('strong', '', 'Your local agent map will appear here'),
      element('p', '', 'Codex Observer is a read-only view of work recorded in local Codex transcripts. It never uploads or stores transcript contents.'),
    );
    const preview = element('div', 'example-preview');
    const previewHeader = element('div', 'example-preview-header');
    previewHeader.append(element('span', 'example-label', 'SYNTHETIC PREVIEW'), element('span', 'secondary', 'Example only'));
    preview.append(previewHeader);
    const grid = element('div', 'example-preview-grid');
    const map = element('div', 'example-map');
    map.append(exampleCard('Improve checkout flow', 'Working', 'working', ['rg', 'npm', 'git', 'read', 'python3'], '12.8k in · 10.2k cached · 940 out'));
    const child = element('div', 'example-child-branch');
    child.append(exampleCard('Review live workspace', 'Running tool', 'tool', ['npm', 'rg', 'read'], '5.4k in · 4.8k cached · 320 out', true));
    const nested = element('div', 'example-child-branch');
    nested.append(exampleCard('Verify browser checks', 'Completed', 'completed', ['node', 'git'], '2.1k in · 1.1k cached · 60 out', true));
    child.append(nested, exampleCard('Prepare release notes', 'Needs input', 'input', ['read', 'git'], '1.3k in · 900 cached · 85 out', true));
    map.append(child);
    grid.append(map, exampleDetails());
    preview.append(grid);
    welcome.append(preview);
    welcome.append(element('p', 'example-help', 'Cards show task, status, token use, and recent tools. Select a real card to open the same safe details: updates, timing, compact result summaries, and transcript compatibility.'));
    return welcome;
  };

  // Retain keyed DOM nodes across polls, including focus, scroll and open tool details.
  const reconcile = (parent, nextChildren) => {
    const previous = [...parent.childNodes];
    const keyed = new Map(previous.filter((node) => node.nodeType === 1 && node.dataset.key !== undefined).map((node) => [node.dataset.key, node]));
    const kept = new Set();
    nextChildren.forEach((next, index) => {
      const key = next.nodeType === 1 ? next.dataset.key : undefined;
      let current = key !== undefined ? keyed.get(key) : previous[index];
      if (current && (kept.has(current) || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName || (key === undefined && current.nodeType === 1 && current.dataset.key !== undefined))) current = undefined;
      if (!current) current = next;
      else if (current.nodeType === 3) {
        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      } else {
        for (const attribute of [...current.attributes]) {
          if (attribute.name !== 'open' && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        }
        for (const attribute of [...next.attributes]) {
          if (attribute.name !== 'open' && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        }
        current.onclick = next.onclick;
        current.onkeydown = next.onkeydown;
        reconcile(current, [...next.childNodes]);
      }
      kept.add(current);
      if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
    });
    for (const node of previous) if (!kept.has(node)) node.remove();
  };

  const heading = element('header', 'heading');
  const headingText = element('div');
  const title = element('h1', '', 'Live agent map');
  const subtitle = element('p', 'subtitle', 'Follow the work. Find what needs you.');
  headingText.append(title, subtitle);
  const version = element('span', 'version');
  heading.append(headingText, version);
  const summary = element('div', 'summary');
  summary.setAttribute('aria-label', 'Agent status summary');
  const toolbar = element('div', 'toolbar');
  const runLabel = element('label', 'run-control');
  runLabel.append(element('span', 'sr-only', 'Filter by run'));
  const runSelect = element('select');
  runSelect.onchange = () => { ui.runKey = runSelect.value; persist(); renderContent(); };
  runLabel.append(runSelect);
  const searchLabel = element('label', 'search-control');
  searchLabel.append(element('span', 'sr-only', 'Search tasks and agents'));
  const search = element('input'); search.type = 'search'; search.placeholder = 'Search tasks or agents…'; search.value = ui.search;
  search.oninput = () => { ui.search = search.value; persist(); renderContent(); };
  searchLabel.append(search);
  const attentionButton = button('Needs attention', 'toolbar-button', () => { ui.attentionOnly = !ui.attentionOnly; persist(); renderContent(); });
  const densityButton = button('Compact', 'toolbar-button', () => vscode.postMessage({ command: 'toggleDensity' }));
  const themeButton = button('', 'toolbar-button theme-toggle', () => {
    ui.theme = ui.theme === 'chamfered' ? 'default' : 'chamfered';
    applyTheme(); persist();
  });
  const refreshButton = button('Refresh', 'toolbar-button', () => vscode.postMessage({ command: 'refresh' }));
  const applyTheme = () => {
    app.dataset.agentMapTheme = ui.theme;
    themeButton.textContent = 'Theme: ' + (ui.theme === 'chamfered' ? 'Chamfered' : 'Default');
    themeButton.setAttribute('aria-pressed', String(ui.theme === 'chamfered'));
    themeButton.setAttribute('aria-label', 'Switch to ' + (ui.theme === 'chamfered' ? 'Default' : 'Chamfered') + ' theme');
  };
  applyTheme();
  toolbar.append(runLabel, searchLabel, attentionButton, densityButton, themeButton, refreshButton);
  const layout = element('div', 'map-layout');
  const map = element('section', 'map-content'); map.setAttribute('aria-label', 'Agent hierarchy');
  const inspectorResizer = element('div', 'inspector-resizer'); inspectorResizer.hidden = true; inspectorResizer.tabIndex = 0; inspectorResizer.setAttribute('role', 'separator'); inspectorResizer.setAttribute('aria-orientation', 'vertical'); inspectorResizer.setAttribute('aria-label', 'Resize agent details');
  const inspector = element('aside', 'inspector'); inspector.hidden = true; inspector.setAttribute('aria-label', 'Selected agent details');
  layout.append(map, inspectorResizer, inspector);
  app.append(heading, summary, toolbar, layout);

  const inspectorWidthLimits = () => ({ min: 220, max: Math.max(220, Math.min(480, Math.floor(layout.clientWidth - 364))) });
  const syncInspectorResizer = () => {
    if (inspectorResizer.hidden) return;
    const { min, max } = inspectorWidthLimits();
    inspectorResizer.setAttribute('aria-valuemin', String(min));
    inspectorResizer.setAttribute('aria-valuemax', String(max));
    inspectorResizer.setAttribute('aria-valuenow', String(Math.round(inspector.getBoundingClientRect().width)));
  };
  const setInspectorWidth = (width) => {
    const { min, max } = inspectorWidthLimits();
    ui.inspectorWidth = Math.min(max, Math.max(min, Math.round(width)));
    layout.style.setProperty('--inspector-width', ui.inspectorWidth + 'px');
    syncInspectorResizer();
  };
  if (ui.inspectorWidth) layout.style.setProperty('--inspector-width', ui.inspectorWidth + 'px');
  let resizeStart;
  inspectorResizer.onpointerdown = (event) => {
    if (event.button !== 0 || window.matchMedia('(max-width: 719px)').matches) return;
    resizeStart = { pointerId: event.pointerId, x: event.clientX, width: inspector.getBoundingClientRect().width };
    inspectorResizer.setPointerCapture?.(event.pointerId);
    document.body.classList.add('is-resizing');
    event.preventDefault();
  };
  inspectorResizer.onpointermove = (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    setInspectorWidth(resizeStart.width - (event.clientX - resizeStart.x));
  };
  const finishResize = (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    resizeStart = undefined;
    document.body.classList.remove('is-resizing');
    persist();
  };
  inspectorResizer.onpointerup = finishResize;
  inspectorResizer.onpointercancel = finishResize;
  inspectorResizer.onkeydown = (event) => {
    if (window.matchMedia('(max-width: 719px)').matches) return;
    const { min, max } = inspectorWidthLimits();
    const current = inspector.getBoundingClientRect().width;
    const next = event.key === 'ArrowLeft' ? current + 20 : event.key === 'ArrowRight' ? current - 20 : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (next === undefined) return;
    setInspectorWidth(next); persist(); event.preventDefault();
  };
  window.addEventListener('resize', syncInspectorResizer);

  const selectAgent = (id) => {
    ui.selected = id;
    renderContent();
    vscode.postMessage({ command: 'selectAgent', agentKey: id });
  };
  const closeInspector = () => {
    const selected = ui.selected;
    ui.selected = undefined;
    renderContent();
    for (const card of map.querySelectorAll('.agent')) if (card.dataset.key === selected) { card.focus({ preventScroll: true }); break; }
    vscode.postMessage({ command: 'closeInspector' });
  };
  const createCard = (agent) => {
    const item = element('li', 'agent-node', undefined, agent.id);
    const row = element('div', 'node-row');
    const card = button('', 'agent' + (agent.id === ui.selected ? ' selected' : '') + ' agent-' + agent.displayState, () => selectAgent(agent.id));
    card.dataset.key = agent.id;
    card.setAttribute('aria-pressed', String(agent.id === ui.selected));
    const thinking = agent.phaseLabel === 'Thinking';
    const visibleTools = agent.recentTools.slice(0, thinking ? 4 : 5);
    const activityLabels = [...(thinking ? ['Thinking'] : []), ...visibleTools.map(tool => tool.label || tool.name)].join(', ');
    card.setAttribute('aria-label', agent.title + ', ' + labels[agent.displayState] + (activityLabels ? '. Activity, current first: ' + activityLabels : '') + '. Show agent details');
    const top = element('div', 'card-top');
    const task = element('span', 'task-title', agent.title); task.title = agent.title;
    top.append(task);
    // Live workspace already conveys working state, and the activity row names
    // an active tool. Reserve the header pill for states needing explanation.
    if (!['working', 'tool'].includes(agent.displayState)) top.append(badge(agent));
    const identity = element('div', 'card-identity');
    identity.append(element('span', 'agent-name', agent.name));
    if (agent.shortId) identity.append(element('span', 'agent-id', agent.shortId));
    if (agent.tokenUsage) {
      const usage = element('span', 'token-summary', shortCount(agent.tokenUsage.input) + ' in · ' + shortCount(agent.tokenUsage.cachedInput) + ' cached · ' + shortCount(agent.tokenUsage.output) + ' out');
      usage.title = exactUsage(agent.tokenUsage); identity.append(usage);
    }
    const phase = element('div', 'phase');
    if (thinking || visibleTools.length) {
      const tools = element('span', 'recent-tools');
      tools.setAttribute('aria-label', 'Current activity followed by recent calls, up to five');
      if (thinking) {
        const pill = element('span', 'thinking-pill', 'Thinking');
        pill.title = 'Current activity: Thinking';
        tools.append(pill);
      }
      for (const [index, recent] of visibleTools.entries()) {
        const tool = toolBadge(recent);
        const current = index === 0 && Boolean(agent.currentTool);
        tool.classList.toggle('is-current', current);
        tool.title = (current ? 'Current tool in use: ' : 'Recent tool: ') + (recent.label || recent.name);
        tools.append(tool);
      }
      phase.append(tools);
    } else phase.append(element('span', 'phase-label' + (agent.phaseLabel === 'Thinking' ? ' thinking-pill' : ''), agent.phaseLabel));
    const elapsed = element('span', 'elapsed', elapsedSince(agent.elapsedAt) + (agent.archived || ['quiet', 'failed', 'interrupted'].includes(agent.displayState) ? ' ago' : ''));
    elapsed.title = agent.elapsedAt ? new Date(agent.elapsedAt).toLocaleString() : 'Timestamp unavailable';
    phase.append(elapsed);
    card.append(top, identity, phase);
    if (agent.progress && agent.progress !== agent.phaseLabel && !state.compactDensity) card.append(element('span', 'progress', agent.progress));
    if (agent.warning) { const warning = element('span', 'compatibility-note', 'Transcript compatibility notice'); warning.title = agent.warning; card.append(warning); }
    row.append(card); item.append(row);
    if (agent.children.length) {
      const { count, reportingCount, tokenUsage } = agent.subagents;
      const collapsed = ui.collapsed.has(agent.id);
      const totals = shortCount(tokenUsage.input) + ' in · ' + shortCount(tokenUsage.cachedInput) + ' cached · ' + shortCount(tokenUsage.output) + ' out';
      const toggle = button((collapsed ? '▸ ' : '▾ ') + count + ' agent' + (count === 1 ? '' : 's') + ' (' + totals + ')', 'branch-toggle', () => {
        if (ui.collapsed.has(agent.id)) ui.collapsed.delete(agent.id); else ui.collapsed.add(agent.id);
        persist(); renderContent();
      });
      toggle.title = 'Combined subagent usage; ' + reportingCount + ' of ' + count + ' agents reporting. ' + exactUsage(tokenUsage) + '. Missing values are excluded.';
      toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.setAttribute('aria-label', (collapsed ? 'Expand' : 'Collapse') + ' agents under ' + agent.title);
      item.append(toggle);
      const children = element('ul', 'children'); children.hidden = collapsed;
      for (const child of agent.children) children.append(createCard(child));
      item.append(children);
    }
    return item;
  };

  const definitionList = (pairs) => {
    const list = element('dl', 'detail-list');
    for (const [label, value] of pairs) { list.append(element('dt', '', label), element('dd', '', value || '—')); }
    return list;
  };
  const renderInspector = () => {
    const agent = state.agents[ui.selected];
    inspector.hidden = !agent;
    inspectorResizer.hidden = !agent;
    layout.classList.toggle('has-inspector', Boolean(agent));
    document.body.classList.toggle('has-inspector', Boolean(agent));
    if (!agent) { reconcile(inspector, []); return; }
    const header = element('div', 'inspector-header', undefined, 'header');
    header.append(element('span', 'eyebrow', 'AGENT DETAILS'), button('Close ×', 'toolbar-button', closeInspector));
    const content = element('div', 'inspector-content', undefined, agent.id);
    const inspectorTitle = element('h2', '', agent.title); content.append(inspectorTitle);
    if (!['working', 'tool'].includes(agent.displayState)) content.append(badge(agent));
    content.append(element('p', 'inspector-phase' + (agent.phaseLabel === 'Thinking' ? ' thinking-pill' : ''), agent.phaseLabel));
    if (agent.progress) { content.append(element('h3', '', 'Latest update'), element('p', 'inspector-progress', agent.progress)); }
    if (agent.tokenUsage) {
      content.append(element('h3', '', 'Token usage'));
      const tokens = element('div', 'token-stats');
      for (const [label, value] of [['Input', agent.tokenUsage.input], ['Cached', agent.tokenUsage.cachedInput], ['Output', agent.tokenUsage.output]]) {
        const stat = element('div'); stat.append(element('span', '', label), element('strong', '', exactCount(value))); tokens.append(stat);
      }
      content.append(tokens);
    }
    const milestones = agent.activityTimeline.filter((event) => event.kind !== 'tool').slice(-8).reverse();
    if (milestones.length) {
      content.append(element('h3', '', 'Handoffs and milestones'));
      const timeline = element('ul', 'milestones');
      for (const event of milestones) {
        const entry = element('li'); entry.append(element('span', '', event.label));
        if (event.timestamp) entry.append(element('time', '', new Date(event.timestamp).toLocaleTimeString()));
        timeline.append(entry);
      }
      content.append(timeline);
    }
    content.append(element('h3', '', 'Tool history · ' + agent.toolHistory.length));
    if (!agent.toolHistory.length) content.append(element('p', 'secondary', 'No tool calls recorded yet.'));
    else {
      const tools = element('div', 'tool-history', undefined, 'tools');
      for (const [index, tool] of agent.toolHistory.slice().reverse().entries()) {
        const details = element('details', 'tool-entry', undefined, tool.id || tool.name + ':' + tool.timestamp + ':' + index);
        const line = element('summary');
        const info = tool.details || {};
        const toolStatus = { in_progress: 'Running', failed: 'Failed', cancelled: 'Cancelled', unknown: 'No result' }[tool.status] || (info.testsPassed > 0 && info.testsFailed === 0 ? 'Passed' : 'Done');
        const header = element('span', 'tool-summary-header');
        const metadata = element('span', 'tool-meta');
        const duration = toolDuration(tool);
        if (duration) { const time = element('span', 'tool-duration', duration); time.title = tool.status === 'in_progress' ? 'Elapsed time' : 'Duration'; metadata.append(time); }
        metadata.append(element('span', 'tool-state ' + (tool.status === 'failed' ? 'tool-failed' : toolStatus === 'Passed' ? 'tool-passed' : ''), toolStatus));
        header.append(toolBadge(tool, 'tool-name'), metadata); line.append(header);
        const resultSummary = toolResultSummary(info);
        if (resultSummary) line.append(element('span', 'tool-result-summary', resultSummary));
        const pairs = [
          ['Tool', tool.name], ['Outcome', toolStatus], [tool.status === 'in_progress' ? 'Elapsed' : 'Duration', duration],
          ['Started', tool.startedAt || tool.timestamp ? new Date(tool.startedAt || tool.timestamp).toLocaleString() : undefined],
          ['Finished', tool.completedAt ? new Date(tool.completedAt).toLocaleString() : undefined]
        ];
        if (info.command) pairs.push(['Command', info.command]);
        if (info.exitCode !== undefined) pairs.push(['Exit code', String(info.exitCode)]);
        if (info.failure && failureLabels[info.failure]) pairs.push(['Failure', failureLabels[info.failure]]);
        if (info.execution) pairs.push(['Execution', { elevated: 'Elevated permissions', default: 'Default permissions' }[info.execution]]);
        if (info.directoryScope) pairs.push(['Directory', { workspace: 'Session workspace', external: 'Outside session workspace' }[info.directoryScope]]);
        if (info.attempt !== undefined) pairs.push(['Attempt', String(info.attempt) + (info.maxAttempts !== undefined ? ' of ' + info.maxAttempts : '')]);
        if (info.testsTotal !== undefined) pairs.push(['Tests', exactCount(info.testsTotal)]);
        if (info.outputBytes !== undefined) pairs.push(['Output', exactCount(info.outputLines) + ' lines · ' + bytes(info.outputBytes) + (info.outputTruncated ? ' · truncated' : '')]);
        details.append(line, definitionList(pairs)); tools.append(details);
      }
      content.append(tools);
    }
    content.append(element('h3', '', 'Session'), definitionList([
      ['Agent', agent.name], ['Session', agent.shortId], ['Path', agent.agentPath], ['Workspace', agent.cwd],
      ['Last activity', agent.lastActivity ? new Date(agent.lastActivity).toLocaleString() : undefined]
    ]));
    content.append(element('h3', '', 'Transcript'), definitionList([
      ['Codex version', agent.transcript.version], ['Parser status', agent.transcript.supportLevel.replace('_', ' ')],
      ['Resolved by', agent.transcript.resolution]
    ]));
    if (agent.warning) content.append(element('p', 'warning', agent.warning));
    reconcile(inspector, [header, content]);
    requestAnimationFrame(syncInspectorResizer);
  };
  const filterTree = (node, inheritedMatch = false) => {
    const text = ui.search.trim().toLowerCase();
    const matches = inheritedMatch || !text || [node.title, node.name, node.shortId, node.agentPath, node.cwd, node.progress].some((value) => value?.toLowerCase().includes(text));
    const children = node.children.map((child) => filterTree(child, matches)).filter(Boolean);
    if ((!matches || (ui.attentionOnly && !node.needsAttention)) && !children.length) return undefined;
    return { ...node, children };
  };
  const revealSelected = () => {
    if (!ui.selected) return;
    const find = (node, parents = []) => {
      if (node.id === ui.selected) return parents;
      for (const child of node.children) { const result = find(child, [...parents, node.id]); if (result) return result; }
    };
    for (const root of state.forest) {
      const parents = find(root);
      if (parents) {
        for (const parent of parents) ui.collapsed.delete(parent);
        if (ui.runKey && ui.runKey !== root.runKey) ui.runKey = root.runKey;
        ui.search = ''; ui.attentionOnly = false; search.value = ''; persist();
        return;
      }
    }
  };
  function renderContent() {
    if (!state) return;
    const forest = state.forest.filter((root) => !ui.runKey || root.runKey === ui.runKey).map((node) => filterTree(node)).filter(Boolean);
    const all = flatten(forest);
    const counts = { working: 0, input: 0, quiet: 0, failed: 0, completed: 0, inactive: 0, unknown: 0 };
    for (const agent of all) {
      const key = agent.historyGroup === 'inactive' ? 'inactive'
        : ['working', 'tool', 'starting'].includes(agent.displayState) ? 'working' : agent.displayState === 'interrupted' ? 'failed' : agent.displayState;
      counts[key]++;
    }
    const countLabels = { working: 'working', input: 'need input', quiet: 'quiet', failed: 'failed / interrupted', completed: 'completed', inactive: 'inactive', unknown: 'unknown' };
    const pills = Object.entries(counts).filter(([key, count]) => count || key === 'working').map(([key, count]) => element('span', 'summary-pill status-' + key + (key === 'working' && count > 0 ? ' is-active' : ''), count + ' ' + countLabels[key], key));
    reconcile(summary, pills);
    const options = [element('option', '', 'All runs · ' + state.runs.length, 'all')]; options[0].value = '';
    for (const run of state.runs) { const option = element('option', '', run.title.slice(0, 65) + (run.shortId ? ' · ' + run.shortId : ''), run.id); option.value = run.id; options.push(option); }
    reconcile(runSelect, options); runSelect.value = ui.runKey;
    attentionButton.setAttribute('aria-pressed', String(ui.attentionOnly));
    densityButton.setAttribute('aria-pressed', String(state.compactDensity));
    map.classList.toggle('compact', state.compactDensity);
    const live = forest.filter(hasLive), archived = forest.filter((root) => !hasLive(root));
    const next = [];
    const sectionHeader = element('div', 'section-header', undefined, 'live-heading');
    sectionHeader.append(element('h2', '', ui.attentionOnly ? 'Needs attention' : 'Live workspace'), element('span', 'secondary', live.length + ' run' + (live.length === 1 ? '' : 's')));
    next.push(sectionHeader);
    if (live.length) { const tree = element('ul', 'tree', undefined, 'live-tree'); for (const root of live) tree.append(createCard(root)); next.push(tree); }
    else {
      if (!state.runs.length && !ui.search && !ui.attentionOnly) next.push(welcomePreview());
      else {
        const empty = element('div', 'empty', undefined, 'empty');
        empty.append(element('strong', '', ui.search || ui.attentionOnly ? 'No matching live agents' : 'No agents are working'), element('p', '', ui.search || ui.attentionOnly ? 'Try another search or clear the attention filter.' : 'New activity will appear here automatically. Past runs are in history below.'));
        next.push(empty);
      }
    }
    for (const group of ['completed', 'inactive']) {
      const history = archived.filter((root) => hasInactive(root) === (group === 'inactive'));
      if (!history.length) continue;
      const details = element('details', 'run-history ' + group + '-history', undefined, group + '-history');
      const label = group === 'inactive' ? 'Inactive history' : 'Completed history';
      details.append(element('summary', '', label + ' · ' + history.length + ' run' + (history.length === 1 ? '' : 's') + ' · ' + flatten(history).length + ' agents'));
      const list = element('ul', 'completed-list'); for (const root of history) list.append(createCard(root));
      details.append(list); next.push(details);
    }
    reconcile(map, next); renderInspector();
  }
  const revealSelectedDetails = () => {
    const selectedCard = [...map.querySelectorAll('.agent')].find((card) => card.dataset.key === ui.selected);
    if (selectedCard) {
      let parent = selectedCard.parentElement;
      while (parent && parent !== map) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
    }
  };
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'render') return;
    const wasArchived = state?.agents[ui.selected]?.archived;
    state = event.data.model;
    const selectionChanged = state.selectedAgentKey !== lastHostSelection;
    // Host provenance also identifies local echoes that arrive after another card click.
    const externalSelection = selectionChanged && event.data.selectionSource !== 'map';
    ui.selected = state.selectedAgentKey; lastHostSelection = state.selectedAgentKey;
    if (ui.runKey && !state.runs.some((run) => run.id === ui.runKey)) ui.runKey = '';
    if (externalSelection && ui.selected) revealSelected();
    version.textContent = 'v' + state.version;
    renderContent();
    if (selectionChanged || (wasArchived === false && state.agents[ui.selected]?.archived)) revealSelectedDetails();
  });
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && ui.selected && event.target !== search) closeInspector(); });
  vscode.postMessage({ command: 'ready' });
})();
