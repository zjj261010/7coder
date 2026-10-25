// T22-10: original file tools, strict snapshots, real temporary files/local CLI.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { loadContext } = require('./download-commit');
const S = require('./_shared').create({ suite: 'text-encoding' });
const source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0, server;
const sockets = new Set();
const deadline = setTimeout(() => { console.error('TEXT/ENCODING suite deadline'); S.cleanup(); process.exit(1); }, 60000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'tool source boundaries');
  return source.slice(start, end);
}
function context(cwd, overrides) {
  const ctx = loadContext(source, cwd, overrides, { Buffer, makeToolResult: (status, text) => ({ status, text }) });
  vm.runInContext('async function invoke(name,args,cancelled=null) {\n' +
    cut("  if (name === 'read_file') {", "  if (name === 'agent_tool') {") +
    cut("  if (name === 'notebook_edit_tool') {", "  if (name === 'ask_user_question_tool') {") +
    cut("  if (name === 'prompt_from_file') {", "  if (name === 'auto_approval_return') {") + '\n}', ctx);
  return ctx;
}
const text = result => typeof result === 'string' ? result : result.text;
const same = (file, bytes) => fs.readFileSync(file).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
function backupFiles(cwd) {
  function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).reduce((all, name) => {
      const full = path.join(dir, name);
      return all.concat(fs.statSync(full).isDirectory() ? walk(full) : full.endsWith('.bak') ? [full] : []);
    }, []);
  }
  return walk(path.join(cwd, '.7coder', 'backups'));
}
function fixture(name, bytes) {
  const cwd = S.freshCwd(name), file = path.join(cwd, 'source.txt');
  fs.writeFileSync(file, bytes);
  return { cwd, file };
}
const gbk = Buffer.concat([Buffer.from('count=1\r\n// '), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]), Buffer.from('\r\n')]);
const args = { write_file: { content: 'count=2\n' }, append_file: { content: '\nadded=中文\n' }, edit_file: { old_string: 'count=1', new_string: 'count=2' } };
(async () => {
  try {
    for (const [label, bytes] of [
      ['GBK/CP936', gbk], ['UTF16LE BOM', Buffer.from('\uFEFFcount=1\r\n中文', 'utf16le')],
      ['UTF16BE BOM', Buffer.from([0xFE, 0xFF, 0, 0x61, 0, 0x3D, 0, 0x31])],
      ['truncated UTF8', Buffer.concat([Buffer.from('count=1\n'), Buffer.from([0xE4, 0xB8])])],
      ['NUL past first 4K', Buffer.concat([Buffer.from('count=1' + 'a'.repeat(5000)), Buffer.from([0])])]
    ]) {
      for (const op of ['edit_file', 'append_file', 'write_file']) {
        const f = fixture(label.replace(/\W/g, '') + '-' + op, bytes);
        const result = text(await context(f.cwd).invoke(op, Object.assign({ path: 'source.txt' }, args[op])));
        check(label + ' ' + op + ': refuse before mutation or backup', /error: Unsupported text encoding/.test(result) && same(f.file, bytes) && backupFiles(f.cwd).length === 0);
      }
    }
    const badRead = fixture('read-legacy', gbk);
    const readResult = await context(badRead.cwd).invoke('read_file', { path: 'source.txt' });
    check('legacy read reports structured error rather than corrupted model text', readResult.status === 'error' && /Read error: Unsupported text encoding/.test(readResult.text) && same(badRead.file, gbk));
    const promptResult = await context(badRead.cwd).invoke('prompt_from_file', { file: 'source.txt' });
    check('legacy prompt file cannot become corrupted task instructions', promptResult.status === 'error' && promptResult.text.includes('Unsupported text encoding'));
    const replacement = fixture('literal-replacement-char', '合法\uFFFD😀\ncount=1\n');
    const replCtx = context(replacement.cwd);
    const validRead = await replCtx.invoke('read_file', { path: 'source.txt' });
    const validEdit = text(await replCtx.invoke('edit_file', { path: 'source.txt', old_string: 'count=1', new_string: 'count=2' }));
    check('valid UTF8 replacement character and emoji are not falsely rejected', validRead.status === 'ok' && validRead.text.includes('合法\uFFFD😀') && validEdit.startsWith('[OK]') && same(replacement.file, '合法\uFFFD😀\ncount=2\n'));

    const original = '\uFEFF标题=中文\r\ncount=1\r\n尾部😀\r\n';
    const f = fixture('bom-crlf', original), ctx = context(f.cwd);
    const edited = '\uFEFF标题=中文\r\ncount=2\r\nadded=😀\r\n尾部😀\r\n';
    check('surgical edit normalizes LF snippet and preserves BOM/CRLF/untouched bytes', text(await ctx.invoke('edit_file', {
      path: 'source.txt', old_string: 'count=1\n', new_string: 'count=2\nadded=😀\n'
    })).startsWith('[OK]') && same(f.file, edited));
    check('strict edit snapshot preserves original bytes exactly', backupFiles(f.cwd).length === 1 && same(backupFiles(f.cwd)[0], original));
    check('append preserves original BOM and CRLF while normalizing new lines', text(await ctx.invoke('append_file', { path: 'source.txt', content: 'append=中文\n' })).startsWith('Appended:') && same(f.file, edited + 'append=中文\r\n'));
    check('append also snapshots its previous version', backupFiles(f.cwd).some(file => same(file, edited)));
    check('full text rewrite preserves existing BOM and newline style', text(await ctx.invoke('write_file', { path: 'source.txt', content: '重写\ncontent\n' })).startsWith('Written:') && same(f.file, '\uFEFF重写\r\ncontent\r\n'));
    check('whole-file BOM removal in replacement still preserves file BOM', text(await ctx.invoke('edit_file', { path: 'source.txt', old_string: '\uFEFF重写\r\ncontent\r\n', new_string: 'fresh\n' })).startsWith('[OK]') && same(f.file, '\uFEFFfresh\r\n'));
    for (const eol of ['\n', '\r']) {
      const line = fixture('eol-' + eol.charCodeAt(0), 'a' + eol + 'count=1' + eol + '中文' + eol);
      const result = await context(line.cwd).invoke('edit_file', { path: 'source.txt', old_string: 'count=1\r\n', new_string: 'count=2\nnext\n' });
      check('uniform newline ' + eol.charCodeAt(0) + ' is retained without adding BOM', text(result).startsWith('[OK]') && same(line.file, 'a' + eol + 'count=2' + eol + 'next' + eol + '中文' + eol));
    }
    const mixed = fixture('mixed-eol', 'A\r\ncount=1\nC\r'), mixedCtx = context(mixed.cwd);
    await mixedCtx.invoke('edit_file', { path: 'source.txt', old_string: 'count=1', new_string: 'count=2' });
    await mixedCtx.invoke('append_file', { path: 'source.txt', content: '\nD\n' });
    check('mixed newline files keep untouched bytes and literal appended endings', same(mixed.file, 'A\r\ncount=2\nC\r\nD\n'));
    const literal = fixture('literal-dollar', 'x x\n'), literalCtx = context(literal.cwd);
    const refused = text(await literalCtx.invoke('edit_file', { path: 'source.txt', old_string: 'x', new_string: '$&$1$$' }));
    check('ambiguous match rejects without creating backup', refused.includes('found 2 times') && same(literal.file, 'x x\n') && backupFiles(literal.cwd).length === 0);
    check('replace_all keeps dollar patterns literal', text(await literalCtx.invoke('edit_file', { path: 'source.txt', old_string: 'x', new_string: '$&$1$$', replace_all: true })).includes('2 replacement(s)') && same(literal.file, '$&$1$$ $&$1$$\n'));
    for (const [label, value] of [['unpaired surrogate', '\uD800'], ['NUL input', '\0']]) {
      const invalid = fixture('input-' + label.replace(/\W/g, ''), 'count=1\n');
      const result = text(await context(invalid.cwd).invoke('edit_file', { path: 'source.txt', old_string: 'count=1', new_string: value }));
      check(label + ': reject before backup or mutation', /Edit error: Text content/.test(result) && same(invalid.file, 'count=1\n') && backupFiles(invalid.cwd).length === 0);
    }
    const newCwd = S.freshCwd('new-text'), newCtx = context(newCwd);
    await newCtx.invoke('write_file', { path: 'nested/new.txt', content: '新文件\n' });
    await newCtx.invoke('append_file', { path: 'new-append.txt', content: '新追加\r\n' });
    check('new write/append create UTF8 without requiring an old backup', same(path.join(newCwd, 'nested', 'new.txt'), '新文件\n') && same(path.join(newCwd, 'new-append.txt'), '新追加\r\n') && backupFiles(newCwd).length === 0);
    check('append traversal is a tool error and cannot escape workspace', /^Append error: Security:/.test(text(await newCtx.invoke('append_file', { path: '../escape.txt', content: 'escape' }))));

    for (const op of ['write_file', 'append_file', 'edit_file']) {
      const denied = fixture('backup-denied-' + op, 'count=1\r\n中文\r\n');
      // T22-26 owned store: payload copies go through chunked writeSync on the
      // staging descriptor, not copyFileSync on a name.
      const result = text(await context(denied.cwd, { writeSync(fd, buffer, off, len) {
        throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
      } }).invoke(op, Object.assign({ path: 'source.txt' }, args[op])));
      check(op + ': partial backup failure blocks write and publishes no backup', /error: Cannot preserve previous file/.test(result) && same(denied.file, 'count=1\r\n中文\r\n') && backupFiles(denied.cwd).length === 0);
    }
    for (const kind of ['flush', 'publish', 'manifest']) {
      const denied = fixture('backup-' + kind, 'count=1\n');
      const overrides = kind === 'flush' ? { fsyncSync() { throw Error('backup flush failed'); } } :
        kind === 'publish' ? { renameSync() { throw Error('backup publication failed'); } } :
          { openSync(file, flags) { if (String(file).includes('.stage-') && path.basename(file) === 'manifest.json' && flags === 'wx') throw Error('backup manifest write denied'); return fs.openSync(file, flags); } };
      const result = text(await context(denied.cwd, overrides).invoke('edit_file', { path: 'source.txt', old_string: 'count=1', new_string: 'count=2' }));
      check('backup ' + kind + ' failure blocks edit', /Edit error: Cannot preserve previous file/.test(result) && same(denied.file, 'count=1\n'));
    }
    const skew = fixture('recovery-order', 'generation=1\n'), skewCtx = context(skew.cwd);
    const first = skewCtx.backupExistingFile(skew.file);
    fs.utimesSync(first, new Date('2099-01-01'), new Date('2099-01-01'));
    fs.writeFileSync(skew.file, 'generation=2\n');
    const second = skewCtx.backupExistingFile(skew.file);
    fs.writeFileSync(skew.file, 'generation=3\n');
    // T22-26 ordering is by monotonic sequence, not mtime: a tampered/rolled-
    // back clock on the older record cannot make /undo pick generation 1.
    check('rollback clock/tied times cannot make /undo select an older generation', first !== second && skewCtx.restoreLatestBackup('source.txt') && same(skew.file, 'generation=2\n'));

    const notebook = fixture('notebook', '\uFEFF{\r\n  "cells": [],\r\n  "metadata": {"keep": true}\r\n}');
    const nbResult = text(await context(notebook.cwd).invoke('notebook_edit_tool', { path: 'source.txt', edits: { cells: [{ cell_type: 'markdown', source: ['中文'] }] } }));
    const nbBytes = fs.readFileSync(notebook.file, 'utf8');
    check('notebook preserves UTF8 BOM/CRLF and unrelated metadata', nbResult === 'Notebook edited successfully' && nbBytes.startsWith('\uFEFF') && !/(^|[^\r])\n/.test(nbBytes) && JSON.parse(nbBytes.slice(1)).metadata.keep && backupFiles(notebook.cwd).length === 1);
    const nbDenied = fixture('notebook-denied', '{"cells":[],"metadata":{}}');
    const nbError = text(await context(nbDenied.cwd, { writeSync() { throw Error('backup denied'); } }).invoke('notebook_edit_tool', { path: 'source.txt', edits: { cells: ['new'] } }));
    check('notebook cannot continue after backup failure', nbError.startsWith('Notebook error: Cannot preserve previous file') && same(nbDenied.file, '{"cells":[],"metadata":{}}'));
    const partial = fixture('partial-write', 'count=1\n');
    const partialCtx = context(partial.cwd, { writeFileSync(file, data, encoding) {
      if (file === partial.file) { fs.writeFileSync(file, 'PARTIAL'); throw Error('write failed after partial output'); }
      return fs.writeFileSync(file, data, encoding);
    } });
    const partialResult = text(await partialCtx.invoke('write_file', { path: 'source.txt', content: 'new body\n' }));
    check('partial target write reports failure and retains recoverable complete previous version', partialResult.startsWith('Write error:') && backupFiles(partial.cwd).length === 1 && partialCtx.restoreLatestBackup('source.txt') && same(partial.file, 'count=1\n'));

    const realCwd = S.freshCwd('real-cli'), dir = path.join(realCwd, '中文 空格'); fs.mkdirSync(dir);
    const legacyPath = path.join(dir, 'legacy.txt'), utfPath = path.join(dir, 'u.txt'), binaryPath = path.join(realCwd, 'download.bin');
    fs.writeFileSync(legacyPath, gbk); fs.writeFileSync(utfPath, '\uFEFF状态=1\r\n'); fs.writeFileSync(binaryPath, Buffer.from([255, 0, 254]));
    let calls = 0, toolResults = [], base;
    server = http.createServer((req, res) => {
      if (req.method === 'GET') { res.end(Buffer.from([1, 0, 2])); return; }
      let raw = ''; req.on('data', d => raw += d);
      req.on('end', () => {
        try {
          const body = JSON.parse(raw); let message = { content: 'fixture summary' };
          if (body.tools) {
            if (++calls === 1) {
              const jobs = [
                ['edit_file', { path: '中文 空格/legacy.txt', old_string: 'count=1', new_string: 'count=2' }],
                ['append_file', { path: '中文 空格/legacy.txt', content: '中文\n' }],
                ['write_file', { path: '中文 空格/u.txt', content: '状态=2\n' }],
                ['read_file', { path: '中文 空格/legacy.txt' }],
                ['edit_file', { path: '中文 空格/u.txt', old_string: '状态=2\n', new_string: '状态=3\n' }],
                ['download_tool', { path: 'download.bin', url: base + '/blob' }]
              ];
              message = { content: '', tool_calls: jobs.map(([name, a], index) => ({ index, id: 't' + index, type: 'function', function: { name, arguments: JSON.stringify(a) } })) };
            } else { toolResults = body.messages.filter(m => m.role === 'tool'); message = { content: 'TEXT_SAFE_COMPLETE' }; }
          }
          if (body.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.end('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant' }, message) }] })); }
        } catch (e) { res.statusCode = 500; res.end(String(e)); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
    const real = await S.runCli({ port: server.address().port, args: ['--prompt', 'text fixture'], cwd: realCwd,
      env: { PERMISSION_MODE: 'bypass', MAX_RETRIES: '1', DREAM_ALLOW: 'false' }, timeoutMs: 8000 });
    check('actual CLI refuses legacy read/edit/append without byte corruption', real.code === 0 && real.out.includes('TEXT_SAFE_COMPLETE') && toolResults.length === 6 && [0, 1, 3].every(i => toolResults[i].content.includes('Unsupported text encoding')) && same(legacyPath, gbk));
    check('actual CLI uses shared strict snapshot for UTF8 writes and binary downloads', same(utfPath, '\uFEFF状态=3\r\n') && same(binaryPath, Buffer.from([1, 0, 2])) && toolResults[5].content.startsWith('[OK] Downloaded'));
    const restarted = await S.runCli({ port: server.address().port, args: [], cwd: realCwd,
      env: { PERMISSION_MODE: 'bypass', DREAM_ALLOW: 'false' }, stdinSteps: [{ t: '/undo 中文 空格/u.txt\n/undo download.bin\n/bye\n', d: 0 }], timeoutMs: 8000 });
    check('restarted REPL /undo chooses latest complete text/binary versions', restarted.code === 0 && restarted.out.includes('[OK] Restored') && same(utfPath, '\uFEFF状态=2\r\n') && same(binaryPath, Buffer.from([255, 0, 254])));
    console.log('TEXT/ENCODING: ' + checks + '/' + checks);
  } finally {
    clearTimeout(deadline); S.cleanup();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
