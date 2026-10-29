'use strict';
const http = require('http'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
function create(kind) {
  if (!['readonly', 'mixed'].includes(kind)) throw Error('Unknown G2 batch kind');
  const model = 'g-batch-' + kind, prompt = 'G2_BATCH_' + kind, recovery = 'G2_RECOVERY_' + kind;
  const reply = 'G2_BATCH_EXACT_' + kind + '中文😀', recovered = 'G2_RECOVERED_EXACT_' + kind + '中文😀', file = 'batch-trace.txt';
  let finalFile = 'G2_START中文😀';
  const args = [], names = [], results = [];
  for (let i = 0; i < 25; i++) {
    if (kind === 'readonly') { names.push('sleep_tool'); args.push({ ms: i + 1 }); results.push('[OK] Slept ' + (i + 1) + 'ms'); }
    else if (i === 0) { names.push('write_file'); args.push({ path: file, content: finalFile }); results.push('Written: ' + file); }
    else if (i % 2 === 1) { const part = '|追加' + ((i + 1) / 2) + '😀'; finalFile += part; names.push('append_file'); args.push({ path: file, content: part }); results.push('Appended: ' + file); }
    else { names.push('read_file'); args.push({ path: file }); results.push('     1\t' + finalFile); }
  }
  const calls = names.map((name, i) => ({ id: 'g2-' + kind + '-' + i, type: 'function', function: { name, arguments: JSON.stringify(args[i]) } }));
  function stepError(body, step, log) {
    if (!Number.isInteger(step) || step < 0 || step > 2) return 'extra model request';
    const error = requestError(body, { model, tools: true, toolIds: step ? calls.map(call => call.id) : [], lastUserIncludes: step === 2 ? recovery : prompt });
    if (error) return error;
    if (!calls.every(call => body.tools.some(tool => tool.function && tool.function.name === call.function.name))) return 'batch tool schema missing';
    const m = body.messages;
    if (body.stream !== true || m.length !== (step === 0 ? 2 : step === 1 ? 28 : 30) || m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content || m[1].role !== 'user' || m[1].content !== prompt) return 'wrong complete task or transport';
    if (!step) return null;
    if (log && JSON.stringify(m.slice(0, 2)) !== JSON.stringify(log[0].messages)) return 'initial task drift';
    if (m[2].role !== 'assistant' || m[2].content !== '' || JSON.stringify(m[2].tool_calls) !== JSON.stringify(calls)) return 'wrong complete batch declaration';
    for (let i = 0; i < calls.length; i++) { const result = m[i + 3]; if (result.role !== 'tool' || result.tool_call_id !== calls[i].id || result.content !== results[i]) return 'wrong ordered tool result at ' + i; }
    if (step === 2 && (m[28].role !== 'assistant' || m[28].content !== reply || m[28].tool_calls || m[29].role !== 'user' || m[29].content !== recovery)) return 'wrong independent recovery task';
    return null;
  }
  function transcript(log) { return Array.isArray(log) && log.length === 3 && log.every((body, step) => !stepError(body, step, log)); }
  function terminals(runtime) {
    const tasks = Array.isArray(runtime) ? runtime.filter(row => row && row.scope === 'cli-task') : [];
    return tasks.length === 2 && tasks.every(row => row.status === 'ok' && executionIdentity(row.executionId)) && tasks[0].executionId !== tasks[1].executionId && !runtime.some(row => row.scope === 'tool');
  }
  function audit(audits, runtime) {
    if (!terminals(runtime) || !Array.isArray(audits)) return false;
    const tools = audits.filter(row => row && row.type === 'tool'), execution = runtime.find(row => row.scope === 'cli-task').executionId;
    if (tools.length !== 25) return false;
    if (kind === 'mixed' && tools.some((row, i) => row.callId !== calls[i].id)) return false;
    return calls.every((call, i) => {
      const rows = tools.filter(row => row.callId === call.id);
      if (rows.length !== 1) return false;
      const row = rows[0], expectedArgs = {};
      for (const key of Object.keys(args[i])) expectedArgs[key] = JSON.stringify(args[i][key]);
      return row.executionId === execution && row.tool === names[i] && row.status === 'ok' && Number.isFinite(row.ms) && row.ms >= 0 &&
        JSON.stringify(row.args) === JSON.stringify(expectedArgs) && row.result === results[i].split('\n')[0].substring(0, 160);
    });
  }
  function output(text, code) { return code === 0 && typeof text === 'string' && [reply, recovered, 'Goodbye!'].every(value => text.split(value).length === 2) && !/step limit|\[ERROR\]|\[REPL\]|MOCK_PROTOCOL|EXECUTION_DEADLINE/.test(text); }
  async function start() {
    const log = [], errors = [], sockets = new Set();
    const server = http.createServer((req, res) => {
      let raw = '', bytes = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
      req.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) req.destroy(Error('G2 fixture input budget')); else raw += text; });
      req.on('end', () => {
        try {
          if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong actual route');
          const body = JSON.parse(raw), step = log.length, error = stepError(body, step, log); if (error) throw Error(error); log.push(body);
          const delta = step === 0 ? { role: 'assistant', content: '', tool_calls: calls.map((call, index) => Object.assign({ index }, call)) } : { role: 'assistant', content: step === 1 ? reply : recovered };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { log, errors, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
  }
  return { kind, model, prompt, recovery, reply, recovered, file, finalFile, args, names, results, calls, stepError, transcript, terminals, audit, output, start };
}
module.exports = { create };
