'use strict';
const http = require('http'), { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
function create(kind) {
  if (!['bypass', 'approve', 'decline'].includes(kind)) throw Error('Unknown G4 kind');
  const model = 'g-economics-main-' + kind, summaryModel = 'g-economics-summary-' + kind;
  const prompt = 'G4_' + kind + '_TASK', recovery = 'G4_' + kind + '_NEXT_TASK', file = 'out.txt', seedFile = 'seed.txt';
  const old = 'G4_OLD中文😀', fresh = 'G4_NEW中文😀', added = '|G4_APPEND中文😀', seed = 'G4_SEED中文😀';
  const names = kind === 'bypass' ? ['read_file', 'write_file', 'read_file', 'append_file'] : ['write_file'];
  const args = kind === 'bypass' ? [{ path: seedFile }, { path: file, content: fresh }, { path: file }, { path: file, content: added }] : [{ path: file, content: fresh }];
  const calls = names.map((name, i) => ({ id: 'g4-' + kind + '-' + i, type: 'function', function: { name, arguments: JSON.stringify(args[i]) } }));
  const results = kind === 'bypass' ? ['     1\t' + seed, 'Written: ' + file, '     1\t' + fresh, 'Appended: ' + file] : [kind === 'approve' ? 'Written: ' + file : 'User declined the tool action.'];
  const finalFile = kind === 'bypass' ? fresh + added : kind === 'approve' ? fresh : old;
  const reply = 'G4_' + kind + '_LONG_REPLY中文😀 ' + 'Exact long final response with no auxiliary decisions. '.repeat(5);
  const recovered = 'G4_' + kind + '_SHORT_NEXT中文😀', summary = 'G4_' + kind + '_SUMMARY中文😀\n' + (kind === 'decline' ? 'User refused the edit; original file retained.' : 'Exact approved file effects recorded.');
  const worklog = '<!-- 7coder:auto-log:start -->\n- ' + summary.replace(/\n/g, '\n  ') + '\n<!-- 7coder:auto-log:end -->\n';
  const diff = '- 1: ' + old + '\n+ 1: ' + fresh, question = 'Execute write_file?\n' + diff + '\n(y/n) ';
  const summaryPrompt = `Create a short, concise summary (1-2 sentences) of what has been done in response to the user's task. Do not list tools, just describe the output/effect.
User task: "${prompt}"
Action/Response: "${reply}"`;
  const n = calls.length, summaryStep = n + 1, recoveryStep = n + 2;
  function tail(step) {
    const messages = [{ role: 'user', content: prompt }];
    for (let i = 0; i < Math.min(step, n); i++) messages.push({ role: 'assistant', content: '', tool_calls: [calls[i]] }, { role: 'tool', tool_call_id: calls[i].id, content: results[i] });
    // Ongoing REPL sessions retain full history. Worklog injection is only
    // for a new session's first task, not every later task in this session.
    if (step === recoveryStep) messages.push({ role: 'assistant', content: reply }, { role: 'user', content: recovery });
    return messages;
  }
  function stepError(body, step, log) {
    if (!Number.isInteger(step) || step < 0 || step > recoveryStep) return 'extra model request';
    const isSummary = step === summaryStep;
    const error = requestError(body, { model: isSummary ? summaryModel : model, tools: !isSummary, toolIds: isSummary ? [] : calls.slice(0, Math.min(step, n)).map(call => call.id) });
    if (error) return error;
    if (body.stream !== (isSummary ? undefined : true)) return 'wrong model transport';
    if (isSummary) return body.max_tokens === 128 && body.tools === undefined && JSON.stringify(body.messages) === JSON.stringify([{ role: 'user', content: summaryPrompt }]) ? null : 'wrong exact action summary request';
    if (!calls.every(call => body.tools.some(tool => tool && tool.function && tool.function.name === call.function.name))) return 'missing offered tool schema';
    const m = body.messages;
    if (m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content || JSON.stringify(m.slice(1)) !== JSON.stringify(tail(step))) return 'wrong full main history or continued task input';
    if (step && log && m[0].content !== log[0].messages[0].content) return 'system drift';
    return null;
  }
  function transcript(log) { return Array.isArray(log) && log.length === recoveryStep + 1 && log.every((body, step) => !stepError(body, step, log)); }
  function audit(audits, runtime) {
    if (!Array.isArray(audits) || !Array.isArray(runtime)) return false;
    const tasks = runtime.filter(row => row.scope === 'cli-task'), tools = audits.filter(row => row.type === 'tool'), failures = runtime.filter(row => row.scope === 'tool');
    if (tasks.length !== 2 || !tasks.every(row => row.status === 'ok' && executionIdentity(row.executionId)) || tasks[0].executionId === tasks[1].executionId || tools.length !== n) return false;
    if (kind === 'decline') {
      if (failures.length !== 1 || failures[0].status !== 'declined' || failures[0].callId !== calls[0].id || failures[0].executionId !== tasks[0].executionId) return false;
    } else if (failures.length) return false;
    return calls.every((call, i) => {
      const row = tools[i];
      return row.callId === call.id && row.executionId === tasks[0].executionId && row.tool === names[i] && row.mode === (kind === 'bypass' ? 'bypass' : 'default') && row.status === (kind === 'decline' ? 'declined' : 'ok') &&
        row.args && Object.keys(args[i]).every(key => row.args[key] === JSON.stringify(args[i][key])) && row.result === results[i].substring(0, 160);
    });
  }
  function output(text, code) {
    if (code !== 0 || typeof text !== 'string' || ![reply, recovered, 'Goodbye!', '[OK] 7CODER.md updated with complete summary'].every(value => text.split(value).length === 2) || /\[ERROR\]|\[REPL\]|MOCK_PROTOCOL|step limit/.test(text)) return false;
    if (kind === 'bypass') return !text.includes('Proposed change') && !text.includes('(y/n)');
    return text.split('[PERM] Proposed change to ' + file + ':\n' + diff + '\n').length === 2 && text.split(question).length === 2;
  }
  async function start() {
    const log = [], errors = [], sockets = new Set(); let held;
    const server = http.createServer((req, res) => {
      let raw = '', bytes = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
      req.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) req.destroy(Error('G4 fixture input limit')); else raw += text; });
      req.on('end', () => {
        try {
          if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong actual route');
          const body = JSON.parse(raw), step = log.length, error = stepError(body, step, log); if (error) throw Error(error); log.push(body);
          if (step === summaryStep) { held = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: summary } }] })); }; return; }
          const delta = step < n ? { role: 'assistant', content: '', tool_calls: [Object.assign({ index: 0 }, calls[step])] } : { role: 'assistant', content: step === n ? reply : recovered };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { log, errors, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', waiting: () => !!held, release() { if (!held) throw Error('G4 summary not held'); const send = held; held = null; send(); }, async close() { held = null; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
  }
  return { kind, model, summaryModel, prompt, recovery, file, seedFile, seed, old, fresh, finalFile, calls, names, args, results, n, reply, recovered, summary, summaryPrompt, worklog, diff, question, summaryStep, recoveryStep, tail, stepError, transcript, audit, output, start };
}
module.exports = { create };
