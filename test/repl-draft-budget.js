const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const S = require('./_shared').create({ suite: 'repl-draft-budget' }), source = fs.readFileSync(S.IDX, 'utf8');
const a = source.indexOf('function replDraftByteLimit('), b = source.indexOf('// ====================== LIGHT/HEAVY CALLER', a), c = { Buffer }; assert.ok(a >= 0 && b > a); vm.runInNewContext(source.slice(a, b), c);
const limit = c.replDraftByteLimit(), fresh = () => ({ text: '', textBytes: 0, reservedBytes: 0 }); let checks = 0, server, child, closed = false; const sockets = new Set();
const deadline = setTimeout(() => { console.error('REPL/DRAFT/BUDGET deadline'); if (child && !closed) child.kill(); S.cleanup(); process.exit(1); }, 40000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
async function until(predicate, label) { const end = Date.now() + 7000; while (!predicate()) { if (Date.now() > end) throw Error('Timeout: ' + label); await new Promise(r => setTimeout(r, 10)); } }
(async () => { try {
  let d = fresh(); c.appendReplDraft(d, 'x'.repeat(limit)); check('exact 1MiB text is queued without truncation', d.textBytes === limit && d.text.length === limit);
  assert.throws(() => c.appendReplDraft(d, 'z'), /not queued/); check('overflow leaves full existing draft unchanged', d.textBytes === limit && d.text.endsWith('x') && d.reservedBytes === 0);
  d = fresh(); c.appendReplDraft(d, '中😀'); check('draft budget counts actual UTF8 bytes', d.textBytes === 7 && d.text === '中😀');
  const token = { draftReservedBytes: c.reserveReplNote(d, 'note') }; check('pending note reserves exact input plus delimiters', d.reservedBytes === 6);
  assert.throws(() => c.appendReplDraft(d, 'x'.repeat(limit - 7)), /not queued/); check('typed text cannot consume a pending note reservation', d.text === '中😀' && d.reservedBytes === 6);
  c.appendReplDraft(d, '\nSUMMARY\n', token); check('summary atomically substitutes its reservation', d.text === '中😀\nSUMMARY\n' && d.textBytes === 16 && d.reservedBytes === 0 && token.draftReservedBytes === 0);
  c.releaseReplNote(d, token); check('finally releasing consumed reservation is idempotent', d.reservedBytes === 0);
  d = fresh(); c.appendReplDraft(d, 'x'.repeat(limit - 8)); const first = { draftReservedBytes: c.reserveReplNote(d, 'a') }, second = { draftReservedBytes: c.reserveReplNote(d, 'b') };
  assert.throws(() => c.appendReplDraft(d, '\nTOO_LONG\n', first), /not queued/); check('oversized summary preserves text and all pending reservations', d.textBytes === limit - 8 && d.reservedBytes === 6 && first.draftReservedBytes === 3 && second.draftReservedBytes === 3);
  c.releaseReplNote(d, first); c.appendReplDraft(d, '\nb\n', second); check('failed note cleanup releases capacity for following note', d.reservedBytes === 0 && d.textBytes === limit - 5);
  assert.throws(() => c.reserveReplNote(d, '中😀'), /exceeds/); check('oversized note admission creates no reservation', d.reservedBytes === 0);
  const cwd = S.freshCwd('actual'); let noteCalls = 0, cancelled = 0, output = '', code = null; const main = [];
  function reply(res, body, content) { if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n'); } else res.end(JSON.stringify({ choices: [{ message: { content } }] })); }
  server = http.createServer((req, res) => { let raw = ''; req.on('data', d => raw += d); req.on('end', () => { const body = JSON.parse(raw);
    if (body.tools) { main.push(body); return reply(res, body, 'DRAFT_TASK_' + main.length); }
    const text = body.messages[0].content; if (text.includes('BTW sub-agent')) { noteCalls++; if (noteCalls === 1) { res.once('close', () => cancelled++); return; }
      return reply(res, body, text.includes('large-summary') ? 'y'.repeat(100) : 'FRESH_NOTE_SUMMARY'); }
    reply(res, body, 'fixture summary'); }); });
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  child = S.spawn(S.NODE_BIN, [S.IDX], { cwd, env: Object.assign({}, process.env, { OPENAI_API_KEY: 'fixture', OPENAI_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/v1', HEAVY_MODEL: 'fixture', LIGHT_MODEL: 'fixture', SUMMARY_MODEL: 'fixture', DREAM_ALLOW: 'false', PERMISSION_MODE: 'bypass', ENABLE_HTTP_SERVER: 'false', ENABLE_RALPH_MODE: 'false', MAX_RETRIES: '1' }) });
  child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d); child.stdin.on('error', () => {}); child.once('close', value => { code = value; closed = true; });
  const wait = (predicate, label) => until(() => { if (closed && !predicate()) throw Error('early exit: ' + output.slice(-3000)); return predicate(); }, label);
  await wait(() => output.includes('Commands:'), 'ready'); child.stdin.write('x'.repeat(limit - 1) + '\nOVERFLOW_TEXT\n/btw too-full\n');
  await wait(() => output.includes('[INPUT]') && output.includes('[BTW] Note not queued: Draft exceeds'), 'draft full'); check('actual full draft rejects text/note without starting a model', noteCalls === 0 && main.length === 0);
  child.stdin.write('/clear\n' + Array.from({ length: 33 }, (_, i) => '/btw old-note-' + i + '\n').join(''));
  await wait(() => noteCalls === 1 && output.includes('32 BTW notes are still pending'), 'queue admission');
  check('32-note queue admits one upstream request while the rest wait; note 33 is refused', (output.match(/small-model sub-agent summarizing/g) || []).length === 32 && noteCalls === 1);
  // One stdin chunk exercises /clear followed by new admission before the old
  // cancelled Promise chain has settled: clearing cannot reset the global cap.
  const beforeCap = (output.match(/32 BTW notes are still pending/g) || []).length; child.stdin.write('/clear\n/btw premature-new-note\n');
  await wait(() => cancelled === 1 && (output.match(/32 BTW notes are still pending/g) || []).length === beforeCap + 1, 'clear cancellation');
  check('clearing a draft cannot bypass the unsettled global note limit', noteCalls === 1 && !fs.existsSync(path.join(cwd, '.7coder', 'BTW.md')));
  child.stdin.write('FRESH_TASK\n/btw fresh\n'); await wait(() => output.includes('FRESH_NOTE_SUMMARY'), 'released capacity'); child.stdin.write('/execute-task-now\n');
  await wait(() => output.includes('DRAFT_TASK_1') && output.includes('[USAGE]'), 'recovered task'); const user = main[0].messages.filter(m => m.role === 'user').slice(-1)[0].content;
  check('cancelled queue releases capacity and cannot contaminate next draft', noteCalls === 2 && user.includes('FRESH_TASK') && user.includes('FRESH_NOTE_SUMMARY') && !/old-note|premature|OVERFLOW/.test(user));
  // A valid original note can receive a much larger model summary. It must be
  // rejected before modifying the draft or persistent BTW log.
  const btw = path.join(cwd, '.7coder', 'BTW.md'), saved = fs.readFileSync(btw); child.stdin.write('x'.repeat(limit - 32) + '\n/btw large-summary\n');
  await wait(() => noteCalls === 3 && output.includes('[BTW] Note not queued: Draft exceeds 1 MiB UTF-8 including queued notes; input was not queued.'), 'summary overflow');
  check('oversized model summary is not partially injected or persisted', fs.readFileSync(btw).equals(saved) && main.length === 1);
  child.stdin.write('/clear\nAFTER_REJECT\n/execute-task-now\n'); await wait(() => output.includes('DRAFT_TASK_2') && (output.match(/\[USAGE\]/g) || []).length === 2, 'post rejection');
  check('rejection does not stall the next task', main[1].messages.filter(m => m.role === 'user').slice(-1)[0].content === 'AFTER_REJECT');
  child.stdin.write('/bye\n'); await until(() => closed, 'close'); check('actual REPL exits cleanly without hidden async errors', code === 0 && !/UnhandledPromiseRejection|\[REPL\]/.test(output));
  console.log('REPL/DRAFT/BUDGET ' + checks + '/' + checks + ' passed; SKIP 0');
} finally { clearTimeout(deadline); if (child && !closed) child.kill(); for (const s of sockets) s.destroy(); if (server) await new Promise(r => server.close(r)); S.cleanup(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
