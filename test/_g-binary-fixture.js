'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const model = 'g-binary-main', file = 'binary 中文/img data.bin';
const prompts = ['G7_BINARY_FIRST_DOWNLOAD', 'G7_BINARY_SECOND_DOWNLOAD', 'G7_READ_AFTER_REAL_UNDO'];
const replies = ['G7_FIRST_EXACT中文😀', 'G7_SECOND_EXACT中文😀', 'G7_RESTORED_EXACT中文😀'];
function bytes(size, factor, add) { const out = Buffer.alloc(size); for (let i = 0; i < size; i++) out[i] = (i * factor + add) % 256; return out; }
const original = bytes(4096, 31, 7), first = bytes(65539, 17, 19), second = bytes(8193, 13, 23);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const writeError = 'Write error: Unsupported text encoding or binary data: only lossless UTF-8 is supported. Convert a copy explicitly; original bytes were not changed.';
const binaryResult = '[BINARY] ' + file + ' looks binary - refused to read as text. Use download_tool or a shell command instead.';
const restored = '[OK] Restored ' + file + ' from the newest backup (v1, sequence 2).';
function readEvidence(cwd) {
  const dir = path.join(cwd, '.7coder', 'backups', 'v1'), names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const records = names.filter(name => /^\d{16}-[0-9a-f]{32}$/.test(name)).map(directory => ({ directory,
    manifest: JSON.parse(fs.readFileSync(path.join(dir, directory, 'manifest.json'), 'utf8')), payload: fs.readFileSync(path.join(dir, directory, 'data.bak')) }));
  const parent = path.join(cwd, path.dirname(file));
  const residue = names.filter(name => name.startsWith('.stage-') || name.startsWith('.deleting-')).concat(fs.readdirSync(parent).filter(name => name.startsWith('.7coder-restore-') || name.startsWith(path.basename(file) + '.part-')));
  return { store: fs.existsSync(path.join(dir, 'store.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')) : null, records, residue };
}
function evidenceValid(e, count) {
  if (![0, 1, 2].includes(count) || !e || !Array.isArray(e.records) || e.records.length !== count || !Array.isArray(e.residue) || e.residue.length) return false;
  if (count === 0) return e.store === null;
  const store = e.store;
  if (!store || store.kind !== '7coder-backup-store-v1' || store.version !== 1 || !/^[0-9a-f]{32}$/.test(store.storeId) || store.lastSequence !== count) return false;
  const ids = new Set();
  return e.records.every((record, i) => {
    const m = record && record.manifest, wanted = i ? first : original;
    if (!m || !/^[0-9a-f]{32}$/.test(m.snapshotId) || ids.has(m.snapshotId)) return false; ids.add(m.snapshotId);
    return m.kind === '7coder-backup-manifest-v1' && m.version === 1 && m.sequence === i + 1 && m.storeId === store.storeId && m.sourceRel === file &&
      m.sourceKey === (process.platform === 'win32' ? file.toLowerCase() : file) && Number.isFinite(Date.parse(m.createdAt)) &&
      record.directory === String(i + 1).padStart(16, '0') + '-' + m.snapshotId && Buffer.isBuffer(record.payload) && record.payload.equals(wanted) &&
      m.bytes === wanted.length && m.sha256 === digest(wanted);
  });
}
function sameEvidence(a, b) {
  return evidenceValid(a, 2) && evidenceValid(b, 2) && JSON.stringify(a.store) === JSON.stringify(b.store) && a.records.every((record, i) => record.directory === b.records[i].directory && JSON.stringify(record.manifest) === JSON.stringify(b.records[i].manifest) && record.payload.equals(b.records[i].payload));
}
function stagesValid(rows) {
  return Array.isArray(rows) && rows.length === 3 && rows.every((row, i) => row && row.step === [1, 2, 4][i] &&
    row.requestCount === [2, 3, 5][i] && row.toolCount === i + 1 && row.taskCount === (i === 2 ? 1 : 0) &&
    row.payloadCount === i && Buffer.isBuffer(row.bytes) && row.bytes.equals([original, first, second][i]) && evidenceValid(row.evidence, i));
}
function undosValid(rows, before) {
  return Array.isArray(rows) && rows.length === 2 && rows.every((row, i) => row && row.restoreCount === i + 1 && row.requestCount === 5 && row.toolCount === 3 && row.taskCount === 2 &&
    row.payloadCount === 2 && Buffer.isBuffer(row.bytes) && row.bytes.equals(first) && sameEvidence(before, row.evidence));
}
function create(origin) {
  const names = ['write_file', 'download_tool', 'download_tool', 'read_file'];
  const args = [{ path: file, content: 'text overwritten' }, { path: file, url: origin + '/payload/one.bin' }, { path: file, url: origin + '/payload/two.bin' }, { path: file }];
  const calls = names.map((name, i) => ({ id: 'g7-' + i, type: 'function', function: { name, arguments: JSON.stringify(args[i]) } }));
  const countAt = step => [0, 1, 2, 2, 3, 3, 4][step];
  function result(i, records) {
    if (i === 0) return writeError; if (i === 3) return binaryResult;
    const record = records[i - 1]; if (!record || !/^\d{16}-[0-9a-f]{32}$/.test(record)) throw Error('G7 missing actual published record');
    return '[OK] Downloaded ' + args[i].url + ' to ' + path.normalize(file) + ' (' + (i === 1 ? first.length : second.length) + ' bytes)\nPrevious version: ' + path.join('.7coder', 'backups', 'v1', record, 'data.bak') + ' (restore with /undo ' + path.normalize(file) + ')';
  }
  function pair(m, i, records) { m.push({ role: 'assistant', content: '', tool_calls: [calls[i]] }, { role: 'tool', tool_call_id: calls[i].id, content: result(i, records) }); }
  function tail(step, records) {
    const m = [{ role: 'user', content: prompts[0] }];
    for (let i = 0; i < Math.min(countAt(step), 2); i++) pair(m, i, records);
    if (step >= 3) { m.push({ role: 'assistant', content: replies[0] }, { role: 'user', content: prompts[1] }); if (step >= 4) pair(m, 2, records); }
    if (step >= 5) { m.push({ role: 'assistant', content: replies[1] }, { role: 'user', content: prompts[2] }); if (step === 6) pair(m, 3, records); }
    return m;
  }
  function stepError(body, step, log, records) {
    if (!Number.isInteger(step) || step < 0 || step > 6) return 'extra model request';
    const error = requestError(body, { model, tools: true, toolIds: calls.slice(0, countAt(step)).map(call => call.id) }); if (error) return error;
    if (body.stream !== true || !names.every(name => body.tools.some(tool => tool && tool.function && tool.function.name === name))) return 'wrong transport or offered schema';
    const m = body.messages;
    if (m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content || JSON.stringify(m.slice(1)) !== JSON.stringify(tail(step, records))) return 'wrong complete binary history at step ' + step;
    if (step && log && m[0].content !== log[0].messages[0].content) return 'system drift';
    return null;
  }
  function transcript(log, records) { return Array.isArray(records) && records.length === 2 && records.every((record, i) => typeof record === 'string' && record.startsWith(String(i + 1).padStart(16, '0') + '-') && /^\d{16}-[0-9a-f]{32}$/.test(record)) && Array.isArray(log) && log.length === 7 && log.every((body, step) => !stepError(body, step, log, records)); }
  function audit(audits, runtime, records) {
    if (!Array.isArray(audits) || !Array.isArray(runtime)) return false;
    const tasks = runtime.filter(row => row && row.scope === 'cli-task'), tools = audits.filter(row => row && row.type === 'tool'), failures = runtime.filter(row => row && row.scope === 'tool');
    if (tasks.length !== 3 || !tasks.every(row => row.status === 'ok' && executionIdentity(row.executionId)) || new Set(tasks.map(row => row.executionId)).size !== 3 || tools.length !== 4) return false;
    if (failures.length !== 1 || failures[0].callId !== calls[0].id || failures[0].executionId !== tasks[0].executionId || failures[0].id !== 'write_file' || failures[0].status !== 'error' || failures[0].message !== writeError) return false;
    return calls.every((call, i) => { const row = tools[i]; return row.callId === call.id && row.executionId === tasks[i <= 1 ? 0 : i - 1].executionId && row.tool === names[i] && row.mode === 'bypass' && row.status === (i === 0 ? 'error' : 'ok') && row.args && Object.keys(args[i]).every(key => row.args[key] === JSON.stringify(args[i][key])) && row.result === result(i, records).split('\n')[0].substring(0, 160); });
  }
  return { origin, names, args, calls, countAt, result, tail, stepError, transcript, audit };
}
function output(text, code) { return code === 0 && typeof text === 'string' && replies.concat('Goodbye!').every(value => text.split(value).length === 2) && text.split(restored).length === 3 && !/\[ERROR\]|\[REPL\]|MOCK_PROTOCOL|step limit|No backup found|\[UNDO (?:FAILED|UNKNOWN|WARNING)\]/.test(text); }
async function start(getEvidence) {
  const log = [], errors = [], payloads = [], sockets = new Set(), held = new Map(); let spec;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && ['/payload/one.bin', '/payload/two.bin'].includes(req.url)) {
      const expected = payloads.length === 0 ? '/payload/one.bin' : payloads.length === 1 ? '/payload/two.bin' : null;
      if (req.url !== expected) { errors.push('wrong or duplicate payload request'); res.writeHead(409); res.end(); return; }
      payloads.push(req.url); const data = req.url === '/payload/one.bin' ? first : second;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }); res.end(data); return;
    }
    let raw = '', bytes = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
    req.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) req.destroy(Error('G7 fixture input limit')); else raw += text; });
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong actual model route');
        const body = JSON.parse(raw), step = log.length, records = getEvidence().records.map(row => row.directory), error = spec.stepError(body, step, log, records); if (error) throw Error(error); log.push(body);
        const send = () => {
          const index = step === 0 ? 0 : step === 1 ? 1 : step === 3 ? 2 : step === 5 ? 3 : -1;
          const delta = index >= 0 ? { role: 'assistant', content: '', tool_calls: [Object.assign({ index: 0 }, spec.calls[index])] } : { role: 'assistant', content: step === 2 ? replies[0] : step === 4 ? replies[1] : replies[2] };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        };
        if ([1, 2, 4].includes(step)) held.set(step, send); else send();
      } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  spec = create('http://127.0.0.1:' + server.address().port);
  return { spec, log, errors, payloads, endpoint: spec.origin + '/v1', waiting: step => held.has(step), release(step) { const send = held.get(step); if (!send) throw Error('G7 model step not held'); held.delete(step); send(); }, async close() { held.clear(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { model, file, prompts, replies, original, first, second, digest, writeError, binaryResult, restored, readEvidence, evidenceValid, sameEvidence, stagesValid, undosValid, create, output, start };
