#!/usr/bin/env node
'use strict';

// Intentionally reports detector names and file labels only. It never prints a
// matched value, so the check itself does not disclose a credential in CI logs.
const { spawn } = require('node:child_process');
const { readdir, readFile, stat } = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignoredDirectories = new Set([
  '.git', '.aws', '.codex', '.vscode-test', 'node_modules', 'sessions', 'transcripts'
]);
const ignoredFiles = new Set(['.DS_Store']);
const maxFileSize = 1024 * 1024;

const detectors = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['github-token', /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['gitlab-token', /glpat-[A-Za-z0-9_-]{20,}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['openai-api-key', /sk-[A-Za-z0-9]{20,}/]
];

function matchingDetectors(text) {
  return detectors.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...await filesIn(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && !ignoredFiles.has(entry.name)) files.push(path.join(directory, entry.name));
  }
  return files;
}

async function scanWorkingTree() {
  const findings = [];
  for (const file of await filesIn(root)) {
    if ((await stat(file)).size > maxFileSize) continue;
    const labels = matchingDetectors(await readFile(file, 'utf8'));
    if (labels.length) findings.push({ location: path.relative(root, file), labels });
  }
  return findings;
}

function scanHistory() {
  return new Promise((resolve, reject) => {
    const findings = new Set();
    let tail = '';
    const log = spawn('git', ['log', '--all', '--format=', '--patch'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    log.stdout.setEncoding('utf8');
    log.stdout.on('data', (chunk) => {
      const content = tail + chunk;
      for (const label of matchingDetectors(content)) findings.add(label);
      tail = content.slice(-256);
    });
    log.on('error', reject);
    log.on('close', (code) => code === 0 ? resolve([...findings]) : reject(new Error(`git log exited with ${code}`)));
  });
}

async function main() {
  const findings = await scanWorkingTree();
  if (findings.length) {
    for (const finding of findings) console.error(`Potential ${finding.labels.join(', ')} in ${finding.location}`);
  } else {
    console.log('Working tree: no high-confidence credential patterns found.');
  }

  if (process.argv.includes('--history')) {
    const historyFindings = await scanHistory();
    if (historyFindings.length) {
      for (const label of historyFindings) console.error(`Potential ${label} in Git history.`);
      findings.push({ location: 'Git history', labels: historyFindings });
    } else {
      console.log('Git history: no high-confidence credential patterns found.');
    }
  }
  process.exitCode = findings.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`Secret scan failed: ${error.message}`);
  process.exitCode = 2;
});
