#!/usr/bin/env node
// Packs a fully OFFLINE distribution of 7coder:
//   dist/7coder-v<version>-offline/        <- staged folder
//   dist/7coder-v<version>-offline-win64.zip  <- zip (Windows packer only)
//
// Includes: program + prod node_modules + docs + tests + (with --with-node)
// a bundled Node 13.14.0 runtime (node.exe) so the target machine needs
// no system Node/npm install. Web UI still needs a separately prepared
// compatible browser and an available local/LAN model service.
//
// Usage:
//   node scripts/pack-offline.js [--with-node]
//
// The --with-node flag copies an existing runtime/node.exe (or the development
// cache copy) into the package. It never downloads or extracts a zip. Zip
// creation uses PowerShell Compress-Archive (Windows 10+); on other platforms
// the staged folder is left for you to zip yourself.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'offline-baseline.json'), 'utf8'));

const REPO = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const version = pkg.version;

const withNode = process.argv.includes('--with-node');
const stage = path.join(REPO, 'dist', `7coder-v${version}-offline`);

const COPY_FILES = [
  'index.js', 'package.json', 'package-lock.json', 'README.md', 'INSTALL.md',
  'LICENSE', '.env.example', '7coder.bat', '7coder-web.bat', 'webui.html', 'OFFLINE-BASELINE.md',
  'scripts/offline-baseline.json',
  'PROCESS-OWNERSHIP.md', 'PROCESS-CREATION-RECOVERY-PLAN-2026-10-28.md',
  'PROCESS-RECOVERY-RUNBOOK.md',
  'scripts/start-web.ps1', 'PROCESS-OWNERSHIP.md', 'scripts/build-process-owner.ps1',
  // A2-22: INSTALL.md tells offline users to run this (it is dependency-free
  // and reads the bundled test/), so ship it and keep the scripts/ layout.
  'scripts/count-assertions.js', 'scripts/test-all.js'
];
const COPY_DIRS = ['node_modules', 'test', 'lib', 'native'];

// A2-21: the old retry fired 300ms later on a timer - i.e. AFTER the main flow
// had already re-created the directory, deleting fresh files (race). Retry
// synchronously instead: a lingering handle from a previous run is usually
// released by the time the caller checks, and if the path is still undeletable
// we THROW so the pack fails loudly - a silently incomplete stage must never
// be zipped into a release.
function rmrf(p) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (e) { /* retry immediately */ }
  }
  throw new Error('pack-offline: rmrf failed for ' + p + ' - close whatever holds it and retry');
}

function copyRec(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      if (e === '.cache' || e.startsWith('w-') || e.startsWith('mock-log-') || e.startsWith('cur-') || e.endsWith('.summary')) continue;
      copyRec(path.join(src, e), path.join(dest, e));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
function validateBundledNode(file) {
  if (!fs.existsSync(file)) throw new Error('No node.exe found. Place the pinned Node 13.14.0 x64 at runtime/node.exe before packing.');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (sha256 !== baseline.node.sha256) throw new Error('Bundled runtime SHA256 mismatch: expected official Node 13.14.0 x64; stage was not replaced.');
  return sha256;
}

(async () => {
  const runtimeSource = path.join(REPO, 'runtime', 'node.exe');
  if (withNode) validateBundledNode(runtimeSource); // validate before deleting a prior stage
  require('../lib/process-owner').validateInstallation(REPO); // ownership is mandatory for Windows async tools
  console.log(`packing 7coder v${version} -> ${stage}`);
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });

  for (const f of COPY_FILES) {
    const src = path.join(REPO, f);
    if (fs.existsSync(src)) {
      const dest = path.join(stage, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); // nested entries keep their layout
      fs.copyFileSync(src, dest);
    }
  }
  for (const d of COPY_DIRS) {
    const src = path.join(REPO, d);
    if (!fs.existsSync(src)) { console.error('missing dir: ' + d); process.exit(1); }
    copyRec(src, path.join(stage, d));
  }

  if (withNode) {
    fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
    fs.copyFileSync(runtimeSource, path.join(stage, 'runtime', 'node.exe'));
    console.log('runtime bundled from: ' + runtimeSource);
  }

  const zipPath = path.join(REPO, 'dist', `7coder-v${version}-offline-win64.zip`);
  if (withNode && process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'pipe' });
    if (ps.status !== 0) { console.error('zip failed: ' + ps.stderr.toString()); process.exit(1); }
  }

  const size = p => { let t = 0; const w = d => { for (const e of fs.readdirSync(d)) { const f = path.join(d, e); const s = fs.statSync(f); if (s.isDirectory()) w(f); else t += s.size; } }; w(p); return (t / 1024 / 1024).toFixed(1) + ' MB'; };
  console.log('staged: ' + stage + ' (' + size(stage) + ')');
  if (fs.existsSync(zipPath)) console.log('zip:    ' + zipPath + ' (' + (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1) + ' MB)');
  console.log('done.');
})().catch(e => { console.error(e); process.exit(1); });
