// T22-09: original download/recovery functions, real files/streams and local HTTP.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');
const axios = require('axios');

function cut(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'source boundary: ' + from);
  return source.slice(start, end);
}
function loadContext(source, cwd, overrides, extra) {
  // OPT-13: the extracted branches return structured ToolResults now - give
  // the sandbox the constructor (plain object; the suites assert on .text).
  const ctx = Object.assign({ fs: Object.assign({}, fs, overrides), path, process, console,
    crypto, pipeline, Transform, axios, vm, launchDir: cwd, setTimeout, clearTimeout, setInterval, clearInterval,
    EXECUTION_TIMEOUT_MS: 5000, MAX_TOOL_RESULT_CHARS: 30000,
    makeToolResult: (status, text) => ({ status, text }) }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(cut(source, 'function executionCancelledError(', 'function parseSSEStream(') +
    cut(source, 'function isInsideDir(', '// Files the AI must never edit') +
    cut(source, 'function recursiveReaddir(', '// P2-3: grep budgets') +
    cut(source, 'const backupsDir =', '// Small unified-ish diff') +
    'async function download(args, cancelled) { const name = "download_tool";\n' +
    cut(source, "  if (name === 'download_tool') {", "  if (name === 'web_search_tool') {") + '\n}', ctx);
  return ctx;
}
module.exports = { loadContext };

async function main() {
  const S = require('./_shared').create({ suite: 'download-commit' });
  const source = fs.readFileSync(S.IDX, 'utf8');
  const old = Buffer.from([0, 128, 255, 13, 10, 65]), fresh = Buffer.from([66, 0, 255, 10, 67]);
  let checks = 0, server;
  const sockets = new Set();
  const deadline = setTimeout(() => { console.error('DOWNLOAD/COMMIT suite deadline'); S.cleanup(); process.exit(1); }, 60000);
  function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
  const same = (file, bytes) => fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
  function files(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).reduce((all, name) => {
      const full = path.join(dir, name);
      return all.concat(fs.statSync(full).isDirectory() ? files(full) : [full]);
    }, []);
  }
  const backups = cwd => files(path.join(cwd, '.7coder', 'backups')).filter(f => f.endsWith('.bak'));
  function fixture(name) {
    const cwd = S.freshCwd(name), dest = path.join(cwd, 'target.bin');
    fs.writeFileSync(dest, old);
    return { cwd, dest };
  }
  function ioError(label, code = 'EPERM') { return Object.assign(Error(label), { code }); }
  let base;
  async function fail(name, inject, opts) {
    const f = fixture(name);
    const overrides = inject(f);
    let destUnlinked = false;
    const originalUnlink = overrides.unlinkSync || fs.unlinkSync;
    overrides.unlinkSync = file => { if (file === f.dest) destUnlinked = true; return originalUnlink(file); };
    const ctx = loadContext(source, f.cwd, overrides, opts && opts.extra);
    const result = await ctx.download({ path: 'target.bin', url: base + (opts && opts.route || '/blob') });
    check(name + ': error preserves original bytes without unlinking destination', /^Download error:/.test(result.text) && same(f.dest, old) && !destUnlinked);
    if (!(opts && opts.residue)) check(name + ': no owned part/staging residue', !files(f.cwd).some(file => file.includes('.part-') || file.endsWith('.bak.tmp')));
    check(name + ': every published backup is complete', backups(f.cwd).every(file => same(file, old)));
    return Object.assign(f, { result, ctx });
  }
  try {
    let cliToolResult = null, modelCalls = 0;
    server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        if (req.url === '/cut') {
          res.writeHead(200, { 'Content-Length': '100' }); res.write('partial');
          setImmediate(() => res.destroy()); return;
        }
        res.end(fresh); return;
      }
      let raw = ''; req.on('data', d => raw += d);
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          let message = { content: 'fixture summary' };
          if (body.tools) {
            modelCalls++;
            if (modelCalls === 1) message = { content: '', tool_calls: [{ index: 0, id: 'dl', type: 'function', function: {
              name: 'download_tool', arguments: JSON.stringify({ path: '中文 空格/target.bin', url: base + '/blob' })
            } }] };
            else { cliToolResult = body.messages.find(m => m.role === 'tool'); message = { content: 'DOWNLOAD_COMPLETE' }; }
          }
          if (body.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          } else {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant' }, message) }] }));
          }
        } catch (e) { res.statusCode = 500; res.end(String(e)); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    const happy = fixture('existing');
    let closed = false, committedAfterClose = false;
    const happyCtx = loadContext(source, happy.cwd, {
      createWriteStream(file, opts) { const w = fs.createWriteStream(file, opts); w.once('close', () => { closed = true; }); return w; },
      renameSync(from, to) { if (to === happy.dest) committedAfterClose = closed; return fs.renameSync(from, to); },
      unlinkSync(file) { assert.notStrictEqual(file, happy.dest, 'never unlink destination'); return fs.unlinkSync(file); }
    });
    const result = await happyCtx.download({ path: 'target.bin', url: base + '/blob' });
    check('existing destination replaced byte-for-byte only after writer close', result.text.startsWith('[OK]') && same(happy.dest, fresh) && committedAfterClose);
    check('previous binary version is a complete published backup', backups(happy.cwd).length === 1 && same(backups(happy.cwd)[0], old) && result.text.includes('Previous version:'));
    check('success leaves no part or backup staging files', !files(happy.cwd).some(f => f.includes('.part-') || f.endsWith('.bak.tmp')));
    check('fresh recovery context restores previous version', loadContext(source, happy.cwd).restoreLatestBackup('target.bin') && same(happy.dest, old));
    const noOld = S.freshCwd('new');
    const noOldResult = await loadContext(source, noOld).download({ path: 'nested/new.bin', url: base + '/blob' });
    check('new nested target needs no previous backup', noOldResult.text.startsWith('[OK]') && same(path.join(noOld, 'nested', 'new.bin'), fresh) && backups(noOld).length === 0);

    const denied = await fail('commit EPERM', f => ({ renameSync(from, to) { if (to === f.dest) throw ioError('commit denied'); return fs.renameSync(from, to); } }));
    check('commit failure retains a complete rollback copy', backups(denied.cwd).length === 1);
    await fail('backup rename EPERM', () => ({ renameSync(from, to) { if (to.endsWith('.bak')) throw ioError('backup publication denied'); return fs.renameSync(from, to); } }));
    await fail('partial backup ENOSPC', () => ({ copyFileSync(from, to) { fs.writeFileSync(to, 'partial'); throw ioError('backup disk full', 'ENOSPC'); } }));
    for (const kind of ['temp fsync', 'backup fsync', 'temp close']) {
      await fail(kind, () => {
        const names = new Map();
        return {
          openSync(file, flags) { const fd = fs.openSync(file, flags); names.set(fd, String(file)); return fd; },
          fsyncSync(fd) { const file = names.get(fd) || ''; if (kind === 'temp fsync' && file.includes('.part-') || kind === 'backup fsync' && file.endsWith('.bak.tmp')) throw ioError(kind, 'EIO'); return fs.fsyncSync(fd); },
          closeSync(fd) { const file = names.get(fd) || ''; names.delete(fd); fs.closeSync(fd); if (kind === 'temp close' && file.includes('.part-')) throw ioError('close reported failure', 'EIO'); }
        };
      });
    }
    await fail('writer close EIO', () => ({ createWriteStream(file, opts) {
      const w = fs.createWriteStream(file, opts), destroy = w._destroy;
      // Real fd is closed first; inject a close error before the close event.
      w._destroy = function(error, callback) { destroy.call(this, error, actual => callback(actual || ioError('writer close', 'EIO'))); };
      return w;
    } }));
    await fail('upstream premature close', () => ({}), { route: '/cut' });

    const collided = fixture('collision');
    const foreignPart = collided.dest + '.part-' + process.pid + '-' + '0'.repeat(16);
    fs.writeFileSync(foreignPart, 'FOREIGN_PART');
    const collisionResult = await loadContext(source, collided.cwd, {}, { crypto: { randomBytes: n => Buffer.alloc(n) } }).download({ path: 'target.bin', url: base + '/blob' });
    check('exclusive temp collision neither overwrites nor deletes foreign file', collisionResult.text.startsWith('Download error:') && same(collided.dest, old) && fs.readFileSync(foreignPart, 'utf8') === 'FOREIGN_PART');
    const residue = await fail('cleanup EPERM', () => ({
      renameSync(from, to) { if (from.includes('.part-')) throw ioError('commit denied'); return fs.renameSync(from, to); },
      unlinkSync(file) { if (file.includes('.part-')) throw ioError('cleanup denied'); return fs.unlinkSync(file); }
    }), { residue: true });
    check('failed cleanup reports exact remaining temporary path', residue.result.text.includes('temporary file retained at ') && files(residue.cwd).filter(f => f.includes('.part-')).length === 1);

    const pruning = fixture('retention');
    const backupDir = path.join(pruning.cwd, '.7coder', 'backups'); fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 6; i++) {
      const file = path.join(backupDir, 'target.bin.2099-01-0' + i + 'T00-00-00-000Z.bak');
      fs.writeFileSync(file, 'older backup'); fs.utimesSync(file, new Date('2099-01-01'), new Date('2099-01-01'));
    }
    const snapshot = loadContext(source, pruning.cwd).backupExistingFile(pruning.dest);
    check('rollback copy survives clock skew while per-file retention stays bounded', backups(pruning.cwd).length === 5 && same(snapshot, old));

    // Abrupt exit at the two sides of the single commit operation. The worker
    // runs original functions in its own Node process and never runs finally.
    const worker = path.join(S.runDir, 'commit-worker.js');
    fs.writeFileSync(worker, 'const fs=require("fs"),path=require("path");\n' +
      'const load=require(' + JSON.stringify(__filename) + ').loadContext;\n' +
      'const cwd=process.argv[2],mode=process.argv[3],dest=path.join(cwd,"target.bin");\n' +
      'const source=fs.readFileSync(' + JSON.stringify(S.IDX) + ',"utf8");\n' +
      'const ctx=load(source,cwd,{renameSync(from,to){if(to===dest){if(mode==="before")process.exit(86);fs.renameSync(from,to);process.exit(87);}return fs.renameSync(from,to);}},' +
      '{axios:async()=>({data:require("stream").Readable.from([Buffer.from(' + JSON.stringify(Array.from(fresh)) + ')])})});\n' +
      'ctx.download({path:"target.bin",url:"http://fixture.invalid"}).then(()=>process.exit(99)).catch(()=>process.exit(98));\n');
    for (const mode of ['before', 'after']) {
      const f = fixture('crash-' + mode);
      const stopped = S.spawnSync(S.NODE_BIN, [worker, f.cwd, mode], { timeout: 8000, encoding: 'utf8' });
      check('abrupt exit ' + mode + ' commit leaves complete destination and backup', stopped.status === (mode === 'before' ? 86 : 87) && same(f.dest, mode === 'before' ? old : fresh) && backups(f.cwd).length === 1 && same(backups(f.cwd)[0], old));
      const restart = S.spawnSync(S.NODE_BIN, ['-e',
        'const fs=require("fs");const ctx=require(' + JSON.stringify(__filename) + ').loadContext(fs.readFileSync(' + JSON.stringify(S.IDX) + ',"utf8"),' + JSON.stringify(f.cwd) + ');if(!ctx.restoreLatestBackup("target.bin"))process.exit(2);console.log("RECOVERED");'
      ], { timeout: 8000, encoding: 'utf8' });
      check('new Node process recovers previous version after ' + mode + ' commit exit', restart.status === 0 && restart.stdout.includes('RECOVERED') && same(f.dest, old));
    }

    const realCwd = S.freshCwd('real-cli');
    const realDest = path.join(realCwd, '中文 空格', 'target.bin');
    fs.mkdirSync(path.dirname(realDest)); fs.writeFileSync(realDest, old);
    const real = await S.runCli({ port: server.address().port, args: ['--prompt', 'replace fixture target'], cwd: realCwd,
      env: { PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false' }, timeoutMs: 8000 });
    check('actual CLI replaces Chinese/space path via local fixture and returns success', real.code === 0 && real.out.includes('DOWNLOAD_COMPLETE') && !real.out.includes('[ERROR]') && cliToolResult && cliToolResult.content.startsWith('[OK] Downloaded') && same(realDest, fresh));
    const restarted = await S.runCli({ port: server.address().port, args: [], cwd: realCwd,
      env: { PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'false' }, stdinSteps: [{ t: '/undo 中文 空格/target.bin\n/bye\n', d: 0 }], timeoutMs: 8000 });
    check('actual restarted REPL /undo restores binary previous version', restarted.code === 0 && restarted.out.includes('[OK] Restored') && same(realDest, old));
    console.log('DOWNLOAD/COMMIT: ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); S.cleanup();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
