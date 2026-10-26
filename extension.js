'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');
const { transcriptRoot, loadSessions } = require('./lib/transcript');
const { buildSessionForest } = require('./lib/hierarchy');
const { agentKeyFor, liveMapModel } = require('./lib/live-map-model');

const SESSION_APPEARANCE = {
  running: { icon: 'arrow-right', color: 'testing.iconPassed' }, waiting: { icon: 'clock', color: 'editorWarning.foreground' },
  stalled: { icon: 'circle-slash', color: 'disabledForeground' }, failed: { icon: 'error', color: 'testing.iconFailed' },
  completed: { icon: 'pass-filled', color: 'disabledForeground' }, unknown: { icon: 'question', color: 'descriptionForeground' }
};

class SessionItem extends vscode.TreeItem {
  constructor(session, children = [], historySelected = false) {
    super(session.agentName || shortId(session.id) || path.basename(session.file), children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.update(session, children, historySelected);
  }
  update(session, children = [], historySelected = false) {
    this.session = session;
    const label = session.agentName || session.currentTask || shortId(session.id) || path.basename(session.file);
    this.label = historySelected ? '● ' + label : label;
    this.children = children;
    this.collapsibleState = children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    const tool = session.currentTool ? session.currentTool.label || session.currentTool.name : undefined;
    this.description = [historySelected ? 'selected' : undefined, attentionLabel(session), tool, shortId(session.id), session.supportLevel === 'best_effort' ? 'best effort' : undefined, formatLastActivity(session.lastActivity)].filter(Boolean).join(' · ');
    const appearance = session.unsupportedReason ? { icon: 'warning', color: 'editorWarning.foreground' } : SESSION_APPEARANCE[session.attentionState] || ({ active: SESSION_APPEARANCE.running, waiting: SESSION_APPEARANCE.waiting, starting: SESSION_APPEARANCE.waiting, delegating: SESSION_APPEARANCE.running, completed: SESSION_APPEARANCE.completed, stale: SESSION_APPEARANCE.stalled, unknown: SESSION_APPEARANCE.unknown }[session.status] || SESSION_APPEARANCE.unknown);
    this.iconPath = new vscode.ThemeIcon(appearance.icon, new vscode.ThemeColor(appearance.color));
    this.tooltip = (historySelected ? 'Selected in Live Agent Map\n' : '') + tooltip(session);
    this.contextValue = 'codexSession';
    this.command = { command: 'codexSessionObserver.openAgentHistoryOnDoubleClick', title: 'Codex Observer: Open Agent History', arguments: [this] };
  }
}
class ObserverProvider {
  constructor(onRefresh) { this._onDidChangeTreeData = new vscode.EventEmitter(); this.onDidChangeTreeData = this._onDidChangeTreeData.event; this.sessions = []; this.items = new Map(); this.sessionFingerprints = new Map(); this.structureFingerprint = undefined; this.selectedSessionKey = undefined; this.onRefresh = onRefresh; }
  refresh() {
    const staleAfterMs = vscode.workspace.getConfiguration('codexSessionObserver').get('staleAfterMs');
    const sessions = relevantSessions(loadSessions(transcriptRoot(), staleAfterMs));
    const fingerprints = new Map(sessions.map((session) => [sessionIdentity(session), sessionTreeFingerprint(session)]));
    const structureFingerprint = sessionStructureFingerprint(sessions);
    const hierarchyChanged = structureFingerprint !== this.structureFingerprint;
    const changedKeys = [...fingerprints].filter(([key, fingerprint]) => this.sessionFingerprints.get(key) !== fingerprint).map(([key]) => key);
    this.sessions = sessions;
    this.sessionFingerprints = fingerprints;
    this.structureFingerprint = structureFingerprint;
    if (hierarchyChanged) {
      this.items.clear();
      this._onDidChangeTreeData.fire();
    } else if (changedKeys.length) {
      buildTree(this.sessions, this.items, this.selectedSessionKey);
      for (const key of changedKeys) {
        const item = this.items.get(key);
        if (item) this._onDidChangeTreeData.fire(item);
      }
    }
    this.onRefresh?.(this.sessions);
  }
  getTreeItem(item) { return item; }
  getChildren(item) { return item ? item.children : buildTree(this.sessions, this.items, this.selectedSessionKey); }
  getItemForSession(session) {
    buildTree(this.sessions, this.items, this.selectedSessionKey);
    return this.items.get(sessionIdentity(session));
  }
  setHistorySelection(session) {
    const previousKey = this.selectedSessionKey;
    this.selectedSessionKey = session ? sessionIdentity(session) : undefined;
    if (previousKey === this.selectedSessionKey) return;
    // VS Code does not consistently repaint changes to an already-rendered
    // TreeItem while another view has focus. Recreate this user-selected state.
    this.items.clear();
    this._onDidChangeTreeData.fire();
  }
}
function sessionIdentity(session) { return agentKeyFor(session); }
function sessionForAgentKey(sessions, agentKey) {
  const findIn = (nodes) => {
    for (const node of nodes) {
      if (agentKeyFor(node.session) === agentKey) return node.session;
      const child = findIn(node.children);
      if (child) return child;
    }
    return undefined;
  };
  return findIn(buildSessionForest(sessions));
}
function sessionTreeFingerprint(session) {
  return JSON.stringify({
    id: session.id, agentPath: session.agentPath, parentId: session.parentId, agentName: session.agentName,
    status: session.status, attentionState: session.attentionState, attentionDetail: session.attentionDetail,
    currentTool: session.currentTool, lastTool: session.lastTool, lastActivity: session.lastActivity,
    currentTask: session.currentTask, currentProgress: session.currentProgress, cwd: session.cwd,
    supportLevel: session.supportLevel, compatibilityDetail: session.compatibilityDetail, unsupportedReason: session.unsupportedReason
  });
}
function sessionStructureFingerprint(sessions) {
  const shape = (node) => [sessionIdentity(node.session), node.children.map(shape)];
  return JSON.stringify(buildSessionForest(sessions).map(shape));
}
function workspaceMatches(session) {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.some((folder) => session.cwd === folder.uri.fsPath || session.cwd?.startsWith(folder.uri.fsPath + path.sep));
}
function relevantSessions(sessions) {
  const settings = vscode.workspace.getConfiguration('codexSessionObserver');
  return sessions.filter((session) => (settings.get('showOtherWorkspaces') || workspaceMatches(session)) && (settings.get('showUnsupported') || !session.unsupportedReason));
}
function buildTree(sessions, cache, selectedSessionKey) {
  const make = (node, ancestors = new Set()) => {
    const identity = sessionIdentity(node.session);
    if (ancestors.has(identity)) return new SessionItem({ ...node.session, unsupportedReason: 'Cyclic session parent relationship' });
    const next = new Set(ancestors); next.add(identity);
    const children = node.children.map((child) => make(child, next));
    const item = cache?.get(identity);
    if (item) { item.update(node.session, children, identity === selectedSessionKey); return item; }
    const created = new SessionItem(node.session, children, identity === selectedSessionKey);
    cache?.set(identity, created);
    return created;
  };
  return buildSessionForest(sessions).map((node) => make(node));
}
function shortId(id) { return id ? id.slice(0, 8) : undefined; }
function attentionLabel(session) { return ({ running: 'running', waiting: 'waiting', stalled: 'stalled', failed: 'failed', completed: 'completed', unknown: 'unknown' }[session.attentionState] || session.status || 'unknown'); }
function formatLastActivity(iso, full = false) {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const time = date.toLocaleTimeString();
  return full || date.toDateString() !== new Date().toDateString() ? date.toLocaleDateString() + ' ' + time : time;
}
function tooltip(session) {
  if (session.unsupportedReason) return session.unsupportedReason + '\n' + session.file;
  const currentTool = session.currentTool ? session.currentTool.name + ' (' + session.currentTool.status + ')' : 'none';
  const lastTool = session.lastTool ? session.lastTool.name + ' (' + session.lastTool.status + ')' : 'none';
  return ['Status: ' + session.status, 'Support: ' + (session.supportLevel || 'unknown') + (session.compatibilityDetail ? ' — ' + session.compatibilityDetail : ''), 'Attention: ' + attentionLabel(session) + (session.attentionDetail ? ' — ' + session.attentionDetail : ''), 'Session: ' + (session.id || 'unknown'), 'Workspace: ' + (session.cwd || 'unknown'), 'Task: ' + (session.currentTask || 'unknown'), 'Progress: ' + (session.currentProgress?.text || 'unknown'), 'Last activity: ' + (formatLastActivity(session.lastActivity, true) || 'unknown'), 'Current tool: ' + currentTool, 'Last tool: ' + lastTool, 'Transcript: ' + session.file].join('\n');
}

class LiveMap {
  constructor(extensionUri, refresh, onSelectSession, onClearSessionSelection) {
    this.extensionUri = extensionUri; this.refresh = refresh; this.onSelectSession = onSelectSession; this.onClearSessionSelection = onClearSessionSelection; this.panel = undefined; this.webviewReady = false;
    this.selectedAgentKey = undefined; this.selectionSource = 'sidebar'; this.compactDensity = false; this.sessions = [];
  }
  open(sessions) {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('codexSessionObserver.liveMap', 'Codex Live Agent Map', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] });
      this.panel.webview.html = liveMapShellHtml(this.panel.webview, this.extensionUri);
      this.panel.onDidDispose(() => { this.panel = undefined; this.webviewReady = false; });
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    }
    this.panel.reveal(vscode.ViewColumn.Beside);
    this.update(sessions);
  }
  openForSession(session, sessions) {
    this.selectedAgentKey = agentKeyFor(session);
    this.selectionSource = 'sidebar';
    this.onSelectSession?.(session);
    this.open(sessions);
  }
  handleMessage(message) {
    if (message?.command === 'ready') { this.webviewReady = true; this.update(this.sessions); return; }
    if (message?.command === 'refresh') { this.refresh(); return; }
    if (message?.command === 'selectAgent') {
      const session = sessionForAgentKey(this.sessions, message.agentKey);
      if (session) { this.selectedAgentKey = message.agentKey; this.selectionSource = 'map'; this.onSelectSession?.(session); }
    }
    if (message?.command === 'closeInspector') {
      this.selectedAgentKey = undefined;
      this.onClearSessionSelection?.();
    }
    if (message?.command === 'toggleDensity') this.compactDensity = !this.compactDensity;
    if (['selectAgent', 'closeInspector', 'toggleDensity'].includes(message?.command)) this.update(this.sessions);
  }
  update(sessions) {
    this.sessions = sessions;
    if (this.panel && this.webviewReady) this.panel.webview.postMessage({ type: 'render', selectionSource: this.selectionSource, model: liveMapModel(buildSessionForest(sessions), {
      selectedAgentKey: this.selectedAgentKey, compactDensity: this.compactDensity,
      inactiveAfterMs: vscode.workspace.getConfiguration('codexSessionObserver').get('inactiveAfterMs')
    }) });
  }
}

function liveMapShellHtml(webview, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'live-map.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'live-map.js'));
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src ' + "'none'; style-src " + webview.cspSource + "; script-src 'nonce-" + nonce + "' " + webview.cspSource + ';"><link rel="stylesheet" href="' + styleUri + '"></head><body><main id="app"></main><script nonce="' + nonce + '" src="' + scriptUri + '"></script></body></html>';
}

function activate(context) {
  let provider;
  let sessionsView;
  let lastSessionActivation;
  const revealSession = (session) => {
    provider?.setHistorySelection(session);
    const item = provider?.getItemForSession(session);
    if (item) sessionsView?.reveal(item, { select: true, focus: false, expand: true }).catch(() => undefined);
  };
  const liveMap = new LiveMap(context.extensionUri, () => provider.refresh(), revealSession, () => provider?.setHistorySelection());
  provider = new ObserverProvider((sessions) => liveMap.update(sessions));
  sessionsView = vscode.window.createTreeView('codexSessionObserver.sessions', { treeDataProvider: provider });
  context.subscriptions.push(sessionsView);
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionObserver.refresh', () => provider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionObserver.openLiveMap', () => liveMap.open(provider.sessions)));
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionObserver.openAgentHistory', (item) => {
    if (item?.session) liveMap.openForSession(item.session, provider.sessions);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codexSessionObserver.openAgentHistoryOnDoubleClick', (item) => {
    if (!item?.session) return;
    const now = Date.now();
    const key = sessionIdentity(item.session);
    const isDoubleClick = lastSessionActivation?.key === key && now - lastSessionActivation.at <= 500;
    lastSessionActivation = { key, at: now };
    if (isDoubleClick) {
      lastSessionActivation = undefined;
      liveMap.openForSession(item.session, provider.sessions);
    }
  }));
  provider.refresh();
  let interval;
  const resetPolling = () => {
    if (interval) clearInterval(interval);
    interval = setInterval(() => provider.refresh(), vscode.workspace.getConfiguration('codexSessionObserver').get('pollIntervalMs'));
  };
  resetPolling();
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('codexSessionObserver')) { resetPolling(); provider.refresh(); }
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
