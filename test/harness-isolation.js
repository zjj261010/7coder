// Focused T22-01 regression. No real model, desktop, or user-config writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const repo = path.resolve(__dirname, '..');
function fingerprint(file) { return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null; }
const protectedPaths = ['.env', 'permissions.json', 'index.js', '7CODER.md'].map(f => path.join(repo, f));
const before = protectedPaths.map(fingerprint);
const S = require('./_shared').create({ suite: 'isolation' });
let checks = 0, server, foreign;
function check(label, condition) { assert.ok(condition, label); checks++; console.log('PASS ' + label); }
(async () => {
  try {
    check('private installation contains identical entry', S.IDX !== path.join(repo, 'index.js') && fingerprint(S.IDX) === before[2]);
    check('private installation has no developer config', !fs.existsSync(path.join(path.dirname(S.IDX), '.env')) && !fs.existsSync(path.join(path.dirname(S.IDX), 'models.json')));
    const cwd = S.freshCwd('isolation');
    check('workspace is outside repository', !path.resolve(cwd).toLowerCase().startsWith(repo.toLowerCase() + path.sep));
    check('workspace cannot inherit repository git', S.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' }).status !== 0);
    const deps = S.spawnSync(S.NODE_BIN, ['-e', 'require("axios"); require("dotenv"); console.log("DEPS_OK")'], { encoding: 'utf8' });
    check('private install child can load bundled dependencies', deps.status === 0 && deps.stdout.includes('DEPS_OK'));
    fs.writeFileSync(path.join(path.dirname(S.IDX), 'permissions.json'), JSON.stringify({ allow: ['write_file(test.txt)'] }));
    fs.writeFileSync(path.join(cwd, '.env'), 'HEAVY_MODEL=isolation-fixture\n');
    let seenModel = null;
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => {
        const request = JSON.parse(body); seenModel = request.model;
        if (request.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ISOLATED_REPLY' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ISOLATED_REPLY' } }] }));
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const result = await S.runCli({ port: server.address().port, args: ['--prompt', 'fixture'], cwd, timeoutMs: 10000 });
    check('real CLI uses local fixture and isolated workspace', result.code === 0 && result.out.includes('ISOLATED_REPLY') && seenModel === 'isolation-fixture');
    foreign = cp.spawn(S.NODE_BIN, ['-e', 'setInterval(()=>{},1000)'], { cwd, stdio: 'ignore' });
    const owned = S.spawn(S.NODE_BIN, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const closed = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('owned child did not close')), 3000); owned.once('close', () => { clearTimeout(timer); resolve(); }); });
    const ownership = fs.readFileSync(S.manifest, 'utf8');
    check('manifest records only owned process identities', ownership.includes(String(owned.pid) + '\t--7coder-test-owner=') && !ownership.includes(String(foreign.pid) + '\t'));
    S.cleanup(); await closed;
    check('cleanup stops owned child but leaves foreign child', owned.exitCode !== null || owned.signalCode !== null);
    check('foreign child still alive', foreign.exitCode === null && foreign.signalCode === null);
    check('real config/source/work log unchanged', JSON.stringify(protectedPaths.map(fingerprint)) === JSON.stringify(before));
    console.log('HARNESS ISOLATION: ' + checks + '/' + checks);
  } finally {
    if (foreign) foreign.kill();
    if (server) await new Promise(resolve => server.close(resolve));
    S.cleanup();
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
