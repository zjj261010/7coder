const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { loadContext } = require('./download-commit');
const H = require('./_endpoint').create({ suite: 'text-budget', endpoint: 'http://127.0.0.1:1', key: 'fixture', model: 'fixture', permissionMode: 'bypass' });
const S = H.S, source = fs.readFileSync(S.IDX, 'utf8'), limit = 8 * 1024 * 1024;
let checks = 0, model; const sockets = new Set();
const deadline = setTimeout(() => { console.error('TEXT/BUDGET deadline'); S.cleanup(); process.exit(1); }, 45000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(from, to) { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); }
function context(cwd, overrides) {
  const c = loadContext(source, cwd, overrides, { Buffer, appDir: path.dirname(S.IDX), console: { log() {}, warn() {} } });
  vm.runInContext('async function invokeTool(name,args,cancelled=null) {\n' + cut("  if (name === 'read_file') {", "  if (name === 'agent_tool') {") + cut("  if (name === 'notebook_edit_tool') {", "  if (name === 'ask_user_question_tool') {") + cut("  if (name === 'prompt_from_file') {", "  if (name === 'auto_approval_return') {") + '\n}' + cut('function simpleLineDiff(', '// ====================== SESSION PERSISTENCE'), c);
  return c;
}
function fixture(name, text) { const cwd = S.freshCwd(name), file = path.join(cwd, 'source.txt'); fs.writeFileSync(file, text); return { cwd, file }; }
function sparse(file, size) { const fd = fs.openSync(file, 'w'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
function noBackup(cwd) { return !fs.existsSync(path.join(cwd, '.7coder', 'backups')); }
function policy(c) {
  const questions = []; Object.assign(c, { DANGER_MODE: false, PERMISSION_MODE: 'default', subAgentModeOverride: null, workflowStepDepth: 0,
    isProtectedTarget: () => false, matchPermRule: () => null, isSuperDangerous: () => false,
    getToolMetadata: () => ({ risk: 'HIGH', explain: () => 'fixture' }), audit() {},
    askApproval: async q => { questions.push(q); return true; }, isAutoApprovalSafe: async () => ({ safe: true }),
    executeToolRaw: (name, args, conversation, bridge, cancelled) => c.invokeTool(name, args, cancelled) });
  vm.runInContext(cut('function effectivePermissionMode()', '// Runs a sub-agent:') + cut('async function safeExecuteToolInner(', '// ====================== APPROVAL'), c);
  c.approved = (name, args) => c.safeExecuteToolInner({ function: { name, arguments: JSON.stringify(args) } }, [], null, () => false, {});
  return questions;
}
(async () => {
  try {
    const explosion = fixture('replace-growth', 'a'.repeat(2048)), expCtx = context(explosion.cwd), large = '中'.repeat(4096);
    if (process.env.TEXT_BUDGET_PHASE !== 'tail') {
    const huge = fixture('huge-source', ''), operations = [ ['write_file', { content: 'new' }], ['append_file', { content: 'x' }], ['edit_file', { old_string: 'a', new_string: 'b' }], ['notebook_edit_tool', { edits: { cells: [] } }] ];
    sparse(huge.file, 100 * 1024 * 1024); let reads = 0, closes = 0;
    const hugeCtx = context(huge.cwd, { readSync(...a) { reads++; return fs.readSync(...a); }, closeSync(fd) { closes++; return fs.closeSync(fd); }, readFileSync() { throw Error('unbounded text read'); } });
    for (const [name, args] of operations) {
      const result = await hugeCtx.invokeTool(name, Object.assign({ path: 'source.txt' }, args));
      check(name + ' refuses oversized source before data read, backup or mutation', result.status === 'error' && result.text.includes('8388608-byte limit') && reads === 0 && noBackup(huge.cwd) && fs.statSync(huge.file).size === 100 * 1024 * 1024);
    }
    check('all refused source descriptors close', closes === operations.length);
    const refused = await expCtx.invokeTool('edit_file', { path: 'source.txt', old_string: 'a', new_string: large, replace_all: true });
    check('replace_all UTF8 growth is rejected before generating output or backup', refused.status === 'error' && refused.text.includes('Edited text exceeds') && fs.readFileSync(explosion.file, 'utf8') === 'a'.repeat(2048) && noBackup(explosion.cwd));
    const boundary = expCtx.replaceTextBounded('a', 'a', 'x'.repeat(limit), true);
    check('exact 8MiB replacement is accepted', boundary.count === 1 && Buffer.byteLength(boundary.text) === limit);
    const dense = expCtx.replaceTextBounded('a'.repeat(1024 * 1024), 'a', '', true);
    check('one million literal deletions complete without a per-match split array', dense.count === 1024 * 1024 && dense.text === '');
    const unicode = expCtx.replaceTextBounded('😀aa😀aa', '😀aa', '$&中文😀', true);
    check('multibyte replacement and dollar patterns preserve literal UTF8 bytes', unicode.count === 2 && unicode.text === '$&中文😀$&中文😀');
    assert.throws(() => expCtx.replaceTextBounded('aaaaa', 'aa', 'x', false), /found 2 times/);
    check('nonoverlapping matching preserves ambiguity and trailing-character semantics', expCtx.replaceTextBounded('aaaaa', 'aa', 'x', true).text === 'xxa');
    const append = fixture('append-limit', 'x'.repeat(limit)), appendCtx = context(append.cwd);
    const appendResult = await appendCtx.invokeTool('append_file', { path: 'source.txt', content: '中' });
    check('append refuses final byte overflow before backup and mutation', appendResult.status === 'error' && appendResult.text.includes('Appended text exceeds') && fs.statSync(append.file).size === limit && noBackup(append.cwd));
    const newline = fixture('newline-limit', 'a\r\n'), newlineCtx = context(newline.cwd), newlineResult = await newlineCtx.invokeTool('write_file', { path: 'source.txt', content: '\n'.repeat(limit / 2 + 1) });
    check('newline normalization growth cannot create an over-limit write', newlineResult.status === 'error' && fs.readFileSync(newline.file, 'utf8') === 'a\r\n' && noBackup(newline.cwd));
    const bom = fixture('bom-limit', '\uFEFFa'), bomCtx = context(bom.cwd), bomResult = await bomCtx.invokeTool('write_file', { path: 'source.txt', content: 'x'.repeat(limit) });
    check('preserved BOM participates in final byte limit before backup', bomResult.status === 'error' && fs.readFileSync(bom.file, 'utf8') === '\uFEFFa' && noBackup(bom.cwd));
    const newFile = fixture('input-limit', 'old'), inputCtx = context(newFile.cwd);
    const inputResult = await inputCtx.invokeTool('write_file', { path: 'nested/new.txt', content: '中'.repeat(Math.floor(limit / 3) + 1) });
    check('oversized new UTF8 content creates neither directory nor file', inputResult.status === 'error' && !fs.existsSync(path.join(newFile.cwd, 'nested')) && noBackup(newFile.cwd));
    }
    const nb = fixture('notebook-indent', '{"cells":[],"metadata":{}}'), nbCtx = context(nb.cwd);
    let deep = { value: 'safe string { [ , : \\" 😀' }; for (let i = 0; i < 100; i++) deep = { nested: deep };
    const nbResult = await nbCtx.invokeTool('notebook_edit_tool', { path: 'source.txt', edits: { metadata: { trees: Array.from({ length: 500 }, () => deep) } } });
    assert.ok(nbResult.text.includes('Formatted notebook exceeds'), 'notebook budget branch: ' + nbResult.text);
    check('deep notebook indentation is refused before allocating oversized pretty JSON or backup', nbResult.status === 'error' && fs.readFileSync(nb.file, 'utf8') === '{"cells":[],"metadata":{}}' && noBackup(nb.cwd));
    const samples = [{ cells: [], metadata: { text: '\\"{},:[]😀', bool: true, nil: null }, value: [1, {}, [], { arr: [false] }] }, [], {}, { empty: {}, arr: ['\n', '\\', '"'] }];
    check('bounded notebook preflight retains native two-space formatting for normal data', samples.every(value => nbCtx.stringifyNotebookBounded(value) === JSON.stringify(value, null, 2)));
    const nbOkay = await nbCtx.invokeTool('notebook_edit_tool', { path: 'source.txt', edits: { cells: [{ source: ['中文😀\n'] }] } });
    check('ordinary notebook edit writes valid JSON with complete original backup', nbOkay.status === 'ok' && JSON.parse(fs.readFileSync(nb.file)).cells[0].source[0] === '中文😀\n' && !noBackup(nb.cwd));
    const prompt = fixture('prompt-limit', 'x'.repeat(1024 * 1024)), promptCtx = context(prompt.cwd);
    check('exact 1MiB prompt is accepted in full', (await promptCtx.invokeTool('prompt_from_file', { file: 'source.txt' })).text.length === 1024 * 1024);
    fs.appendFileSync(prompt.file, '中'); let promptReads = 0;
    const tooBig = await context(prompt.cwd, { readSync(...args) { promptReads++; return fs.readSync(...args); } }).invokeTool('prompt_from_file', { file: 'source.txt' });
    check('oversized prompt is a structured error with zero content collection', tooBig.status === 'error' && tooBig.text.includes('1048576-byte limit') && promptReads === 0);
    const normal = fixture('approval-small', 'old\n'), normalCtx = context(normal.cwd), normalQs = policy(normalCtx);
    const normalResult = await normalCtx.approved('edit_file', { path: 'source.txt', old_string: 'old', new_string: '新' });
    check('default approval still receives actual small diff then executes bounded edit', normalResult.status === 'ok' && normalQs.length === 1 && normalQs[0].includes('- 1: old') && normalQs[0].includes('+ 1: 新') && fs.readFileSync(normal.file, 'utf8') === '新\n');
    const preview = fixture('approval-source', 'a\n'.repeat(65536)), previewCtx = context(preview.cwd), previewQs = policy(previewCtx);
    const previewResult = await previewCtx.approved('edit_file', { path: 'source.txt', old_string: 'a', new_string: 'b', replace_all: true });
    check('large-source preview falls back to complete action args without splitting lines', previewResult.status === 'ok' && previewQs.length === 1 && previewQs[0].includes('"replace_all": true') && previewQs[0].includes('"new_string": "b"') && previewQs[0].length < 65536 && fs.readFileSync(preview.file, 'utf8') === 'b\n'.repeat(65536));
    const deniedQs = policy(expCtx), approvalRefused = await expCtx.approved('edit_file', { path: 'source.txt', old_string: 'a', new_string: large, replace_all: true });
    check('explosive approval preview returns error before asking or executing', approvalRefused.status === 'error' && approvalRefused.text.startsWith('Approval preview error:') && deniedQs.length === 0 && noBackup(explosion.cwd));
    let modelCalls = 0;
    model = http.createServer((req, res) => { let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
      const body = JSON.parse(raw); modelCalls++;
      const task = body.messages.filter(m => m.role === 'user').slice(-1)[0].content;
      const message = body.messages.some(m => m.role === 'tool') ? { content: 'RECOVERED' } : { content: '', tool_calls: [{ id: task, type: 'function', function: { name: task === 'expand' ? 'edit_file' : 'read_file', arguments: JSON.stringify(task === 'expand' ? { path: 'source.txt', old_string: 'a', new_string: large, replace_all: true } : { path: 'source.txt', limit: 1 }) } }] };
      res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n');
    }); }); model.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => model.listen(0, '127.0.0.1', r));
    const actual = require('./_endpoint').create({ suite: 'text-budget-agent', endpoint: 'http://127.0.0.1:' + model.address().port, key: 'fixture', model: 'fixture', permissionMode: 'bypass' });
    try {
      await actual.start(explosion.cwd); const response = await actual.chat([{ role: 'user', content: 'expand' }], 8000), result = response.tools.find(t => t.type === 'result');
      check('actual Agent SSE/audit marks oversized replacement error with no mutation', result.status === 'error' && result.result.includes('Edited text exceeds') && fs.readFileSync(explosion.file, 'utf8') === 'a'.repeat(2048) && noBackup(explosion.cwd) && S.readLog(path.join(explosion.cwd, '.7coder', 'audit.jsonl')).some(row => row.type === 'tool' && row.callId === 'expand' && row.status === 'error'));
      const next = await actual.chat([{ role: 'user', content: 'read-next' }], 8000), info = JSON.parse((await actual.api('/api/info')).body);
      check('same Agent completes next read after rejected expansion and releases active state', next.content === 'RECOVERED' && next.tools.some(t => t.type === 'result' && t.status === 'completed' && t.result.includes('aaaa')) && modelCalls === 4 && info.runtime.activeTools === 0 && info.runtime.activeTasks === 0);
    } finally { await actual.stop(); actual.S.cleanup(); }
    console.log('TEXT/BUDGET ' + checks + '/' + checks + ' passed; ' + (process.env.TEXT_BUDGET_PHASE === 'tail' ? 'selected tail only; first 14 checks not run' : 'SKIP 0'));
  } finally { clearTimeout(deadline); await H.stop(); S.cleanup(); for (const socket of sockets) socket.destroy(); if (model) await new Promise(r => model.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
