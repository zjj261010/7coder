#!/usr/bin/env node
// Packs a fully OFFLINE distribution of 7coder:
//   dist/7coder-v<version>-offline/        <- staged folder
//   dist/7coder-v<version>-offline-win64.zip  <- zip (Windows packer only)
//
// Includes: program + prod node_modules + docs + tests + (with --with-node)
// a bundled Node 13.14.0 runtime (node.exe) so the target machine needs
// NOTHING installed and NO internet access.
//
// Usage:
//   node scripts/pack-offline.js [--with-node]
//
// The --with-node flag downloads node-v13.14.0-win-x64.zip once (cached in
// test/../.cache) and bundles runtime/node.exe. Zip creation uses PowerShell
// Compress-Archive (Windows 10+); on other platforms the staged folder is
// left for you to zip yourself.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const version = pkg.version;
const NODE_VER = 'v13.14.0';
const NODE_ZIP_NAME = `node-${NODE_VER}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VER}/${NODE_ZIP_NAME}`;
const CACHE = path.join(REPO, '.cache');

const withNode = process.argv.includes('--with-node');
const stage = path.join(REPO, 'dist', `7coder-v${version}-offline`);

const COPY_FILES = [
  'index.js', 'package.json', 'package-lock.json', 'README.md', 'INSTALL.md',
  'KNOWN-ISSUES.md', 'LICENSE', '.env.example', '7coder.bat'
];
const COPY_DIRS = ['node_modules', 'test'];

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* retry below */ setTimeout(() => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e2) {} }, 300); } }

function copyRec(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      if (e === '.cache' || e === 'w-' || e.startsWith('mock-log-') || e.startsWith('cur-script-') || e.endsWith('.summary')) continue;
      copyRec(path.join(src, e), path.join(dest, e));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, n) => {
      https.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 4) {
          res.resume();
          return get(res.headers.location, n + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    };
    get(url, 0);
  });
}

(async () => {
  console.log(`packing 7coder v${version} -> ${stage}`);
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });

  for (const f of COPY_FILES) {
    const src = path.join(REPO, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, f));
  }
  for (const d of COPY_DIRS) {
    const src = path.join(REPO, d);
    if (!fs.existsSync(src)) { console.error('missing dir: ' + d); process.exit(1); }
    copyRec(src, path.join(stage, d));
  }

  if (withNode) {
    if (process.platform !== 'win32') {
      console.warn('--with-node bundles the win-x64 node.exe; run this on Windows or place node.exe at runtime/node.exe manually.');
    }
    fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
    fs.mkdirSync(CACHE, { recursive: true });
    const zipPath = path.join(CACHE, NODE_ZIP_NAME);
    if (!fs.existsSync(zipPath)) {
      console.log('downloading ' + NODE_URL + ' ...');
      await download(NODE_URL, zipPath);
    }
    // extract just node.exe via PowerShell (packer is a modern Windows box)
    const tmpEx = path.join(CACHE, 'extract-' + Date.now());
    fs.mkdirSync(tmpEx, { recursive: true });
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpEx}' -Force`], { stdio: 'pipe' });
    if (ps.status !== 0) { console.error('extract failed: ' + ps.stderr.toString()); process.exit(1); }
    fs.copyFileSync(path.join(tmpEx, NODE_ZIP_NAME.replace('.zip', ''), 'node.exe'), path.join(stage, 'runtime', 'node.exe'));
    fs.rmSync(tmpEx, { recursive: true, force: true });
    console.log('runtime bundled: runtime/node.exe');
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
