// No desktop capture/input: native dispatch is replaced with a private-file fixture.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'vision-budget' }), source = fs.readFileSync(S.IDX, 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let checks = 0, server; const sockets = new Set();
const deadline = setTimeout(() => { console.error('VISION/BUDGET deadline'); S.cleanup(); process.exit(1); }, 30000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(cwd, overrides, extra) {
  const c = loadContext(source, cwd, overrides, Object.assign({ Buffer, appDir: path.dirname(S.IDX), VISION_MODEL: 'fixture',
    console: { log() {}, warn() {} }, makeToolResult: (status, text, data) => ({ status, text, data }),
    toolResultStatus: r => r.status, toolResultText: r => r.text,
    resolveModelConfig: () => ({ endpoint: 'http://127.0.0.1:1', apiKey: '' }), authHeadersFor: () => ({}) }, extra));
  vm.runInContext(cut('async function describeWithVision(', '// ====================== LIGHT/HEAVY CALLER') +
    'async function invokeTool(name,args,cancelled=null,modelContext={}) {\n' + cut("  if (name === 'computer_use') {", "  if (name === 'workflow_tool') {") + '\n}', c);
  return c;
}
function sparse(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
function captured(name, write, overrides) {
  const cwd = S.freshCwd('中文 空格 单\'引号-' + name), paths = [], scripts = []; let reads = 0, visions = 0;
  const c = context(cwd, Object.assign({ readSync(...args) { reads++; return fs.readSync(...args); } }, overrides), {
    process: Object.assign({}, process, { platform: 'win32' }),
    powerShellSpec(script) { scripts.push(script); const match = /\$bmp\.Save\('((?:''|[^'])*)',/.exec(script); assert.ok(match, 'literal screenshot path'); return { file: 'capture-only.exe', args: [match[1].replace(/''/g, "'")] }; },
    child_process: { execSync() { throw Error('native shell forbidden'); }, execFileSync(file, args, opts) { assert.strictEqual(file, 'capture-only.exe'); assert.strictEqual(opts.timeout, 30000); assert.strictEqual(opts.windowsHide, true); paths.push(args[0]); assert.ok(path.relative(cwd, args[0]).startsWith('.7coder' + path.sep)); if (write) write(args[0], paths.length); } }
  });
  c.describeWithVision = async url => { visions++; assert.ok(Buffer.from(url.split(',')[1], 'base64').equals(png)); return { status: 'ok', text: 'CAPTURE_DESCRIBED' }; };
  return { c, cwd, paths, scripts, reads: () => reads, visions: () => visions };
}
(async () => {
  try {
    const cwd = S.freshCwd('helper'), image = path.join(cwd, 'image.png'); fs.writeFileSync(image, png); let reads = 0, open = new Set();
    const c = context(cwd, { openSync(file, flags, mode) { const fd = fs.openSync(file, flags, mode); open.add(fd); return fd; }, closeSync(fd) { fs.closeSync(fd); open.delete(fd); }, readSync(...args) { reads++; return fs.readSync(...args); } });
    check('real 1x1 PNG data URL retains exact bytes', Buffer.from(c.screenshotToDataUrl(image, true).split(',')[1], 'base64').equals(png) && open.size === 0);
    const missing = path.join(cwd, 'missing.png'); assert.throws(() => c.screenshotToDataUrl(missing, true), e => e.code === 'ENOENT');
    check('optional missing helper keeps null while strict helper propagates failure', c.screenshotToDataUrl(missing) === null && open.size === 0);
    sparse(image, 100 * 1024 * 1024); const before = reads;
    assert.throws(() => c.screenshotToDataUrl(image, true), e => e.code === 'EFILETOOLARGE');
    check('oversized image refused before reading/Base64 with no leaked descriptor or mutation', reads === before && open.size === 0 && fs.statSync(image).size === 100 * 1024 * 1024);
    const boundary = Buffer.alloc(4 * 1024 * 1024); png.copy(boundary); fs.writeFileSync(image, boundary);
    const url = c.screenshotToDataUrl(image, true);
    check('exact 4MiB envelope with PNG signature stays accepted and below URL ceiling', Buffer.from(url.split(',')[1], 'base64').equals(boundary) && Buffer.byteLength(url) < 6 * 1024 * 1024 && open.size === 0);
    fs.writeFileSync(image, 'not a PNG'); assert.throws(() => c.screenshotToDataUrl(image, true), /PNG signature/);
    check('invalid image signature is rejected with optional null compatibility', c.screenshotToDataUrl(image) === null && open.size === 0);
    let f = captured('oversized', file => sparse(file, 100 * 1024 * 1024)); const largeResult = await f.c.invokeTool('computer_use', { action: 'screenshot' });
    check('requested vision cannot silently become path-only success after size refusal', largeResult.status === 'error' && largeResult.text.includes('Vision unavailable:') && largeResult.text.includes('4194304-byte limit') && largeResult.data.screenshotPath === f.paths[0] && fs.statSync(f.paths[0]).size === 100 * 1024 * 1024 && f.reads() === 0 && f.visions() === 0);
    f = captured('read-failure', file => fs.writeFileSync(file, png), { readSync() { throw Object.assign(Error('injected image EACCES'), { code: 'EACCES' }); } }); const denied = await f.c.invokeTool('computer_use', { action: 'screenshot' });
    check('image IO failure retains screenshot path and reports vision error without calling model', denied.status === 'error' && denied.text.includes('injected image EACCES') && denied.data.screenshotPath === f.paths[0] && fs.readFileSync(f.paths[0]).equals(png) && f.visions() === 0);
    f = captured('ordinary', file => fs.writeFileSync(file, png)); const normal = await f.c.invokeTool('computer_use', { action: 'screenshot' });
    check('captured normal screenshot passes exact PNG to vision and preserves successful text', normal.status === 'ok' && normal.text.includes('Vision: CAPTURE_DESCRIBED') && f.visions() === 1 && f.scripts[0].includes(f.cwd.replace(/'/g, "''")));
    f = captured('no-model', (file, n) => fs.writeFileSync(file, Buffer.concat([png, Buffer.from([n])]))); f.c.VISION_MODEL = ''; f.c.Date = class extends Date { static now() { return 1234567890000; } };
    const first = await f.c.invokeTool('computer_use', { action: 'screenshot' }), firstBytes = fs.readFileSync(f.paths[0]); const second = await f.c.invokeTool('computer_use', { action: 'screenshot' });
    check('no-model screenshot stays path-only without reading image or calling model', first.status === 'ok' && second.status === 'ok' && !first.text.includes('Vision:') && f.reads() === 0 && f.visions() === 0);
    check('same timestamp creates distinct screenshot paths and preserves first bytes', f.paths.length === 2 && f.paths[0] !== f.paths[1] && fs.readFileSync(f.paths[0]).equals(firstBytes) && fs.readdirSync(path.dirname(f.paths[0])).length === 2);
    f = captured('not-created', null); const absent = await f.c.invokeTool('computer_use', { action: 'screenshot' });
    check('successful capture command without a file still returns error and no vision', absent.status === 'error' && absent.text.includes('file was not created') && f.visions() === 0);
    const requests = []; server = http.createServer((req, res) => { let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => { const body = JSON.parse(raw); requests.push({ url: body.messages[0].content[1].image_url.url, bytes: Buffer.byteLength(raw), model: body.model }); res.end(JSON.stringify({ choices: [{ message: { content: 'Vision error: photographed literal label' } }] })); }); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const live = context(S.freshCwd('local-http'), null, { resolveModelConfig: () => ({ endpoint: 'http://127.0.0.1:' + server.address().port, apiKey: '' }) });
    const over = await live.describeWithVision('中'.repeat(2 * 1024 * 1024 + 1), null, null);
    check('vision URL limit measures UTF8 bytes and rejects before local HTTP', over.status === 'error' && over.text.includes('6291456-byte limit') && requests.length === 0);
    const invalid = await live.describeWithVision({}, null, null); check('non-string vision input fails before transport', invalid.status === 'error' && invalid.text.includes('nonempty string') && requests.length === 0);
    const atLimit = 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024 - 'data:image/png;base64,'.length), answer = await live.describeWithVision(atLimit, null, null);
    check('real local HTTP accepts exact URL envelope under body cap and preserves literal success text', answer.status === 'ok' && answer.text.startsWith('Vision error: photographed') && requests.length === 1 && requests[0].url === atLimit && requests[0].bytes < 8 * 1024 * 1024 && requests[0].model === 'fixture');
    const following = await live.describeWithVision('http://fixture.invalid/image.png', null, null);
    check('vision helper accepts next normal request after validation failure', following.status === 'ok' && requests.length === 2);
    console.log('VISION/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0; desktop calls captured only');
  } finally { clearTimeout(deadline); S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
