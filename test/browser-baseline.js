const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { harness, settle } = require('./webui-ui-sim');
const S = require('./_shared').create({ suite: 'browser-baseline' });
const REPO = path.resolve(__dirname, '..');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
(async () => {
  try {
    const good = harness(); await settle();
    check('capable browser fixture reaches normal initialization', !!good.hook && good.calls.some(c => c.url === '/api/info'));
    const cases = [
      ['Promise', { Promise: undefined }], ['fetch', { fetch: undefined }],
      ['AbortController', { AbortController: undefined }],
      ['AbortSignal', { AbortController: function () { this.signal = {}; this.abort = () => {}; } }],
      ['TextDecoder', { TextDecoder: undefined }],
      ['TextDecoder', { TextDecoder: function () { this.decode = () => 'wrong UTF8'; } }],
      ['Response.body.getReader', { Response: undefined }],
      ['Response.body.getReader', { Response: function () { this.body = null; } }]
    ];
    for (const [reason, globals] of cases) {
      const h = harness({ globals });
      check('missing/broken ' + reason + ' shows explanation before any IO/timer', !h.hook && h.calls.length === 0 && h.timers.size === 0 && h.intervals.size === 0 && h.document.body.textContent.includes(reason) && h.document.body.textContent.includes('INSTALL.md'));
    }
    const baseline = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'offline-baseline.json'), 'utf8'));
    check('browser candidate remains explicitly unbundled and unvalidated', baseline.browserCandidate.version === '109.0.5414.120' && !baseline.browserCandidate.bundled && !baseline.browserCandidate.validatedOnWin7 && baseline.browserCandidate.sha256 === null);
    const pack = fs.readFileSync(path.join(REPO, 'scripts', 'pack-offline.js'), 'utf8'), a = pack.indexOf('function validateBundledNode('), b = pack.indexOf('\n(async () =>', a);
    assert.ok(a >= 0 && b > a);
    const ctx = vm.createContext({ fs, crypto, baseline }); vm.runInContext(pack.slice(a, b), ctx);
    check('original pack validator accepts only current official pinned Node bytes', ctx.validateBundledNode(path.join(REPO, 'runtime', 'node.exe')) === baseline.node.sha256);
    const cwd = S.freshCwd('packer'), scriptDir = path.join(cwd, 'scripts'); fs.mkdirSync(scriptDir);
    fs.writeFileSync(path.join(scriptDir, 'pack-offline.js'), pack); fs.writeFileSync(path.join(scriptDir, 'offline-baseline.json'), JSON.stringify(baseline));
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: 'fixture' })); fs.mkdirSync(path.join(cwd, 'runtime')); fs.writeFileSync(path.join(cwd, 'runtime', 'node.exe'), 'NOT_A_NODE_BINARY');
    const stage = path.join(cwd, 'dist', '7coder-vfixture-offline'); fs.mkdirSync(stage, { recursive: true }); fs.writeFileSync(path.join(stage, 'preserve.txt'), 'previous stage');
    assert.ok(path.resolve(stage).startsWith(path.resolve(cwd) + path.sep), 'any potential stage operation stays inside this private fixture');
    const child = S.spawnSync(S.NODE_BIN, [path.join(scriptDir, 'pack-offline.js'), '--with-node'], { cwd, encoding: 'utf8', timeout: 10000 });
    check('actual packer rejects wrong runtime before replacing an existing private stage', child.status !== 0 && child.stderr.includes('SHA256 mismatch') && fs.readFileSync(path.join(stage, 'preserve.txt'), 'utf8') === 'previous stage');
    assert.throws(() => ctx.validateBundledNode(path.join(cwd, 'missing.exe')), /No node.exe found/);
    check('missing runtime produces an explicit prerequisite error', true);
    console.log('BROWSER/BASELINE ' + checks + '/' + checks + '; capability fixtures and pack rejection, no real Win7/browser validation');
  } finally { S.cleanup(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
