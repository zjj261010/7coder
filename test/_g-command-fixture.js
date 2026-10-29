'use strict';
const http = require('http'), { requestError } = require('./_protocol');
const { executionIdentity } = require('../lib/execution-identity');
const main = 'g-command-main', light = 'g-command-note', first = 'G1_ACTIVE_TASK', marker = 'G1_NEXT_DRAFT_MARKER', third = 'G1_THIRD_DRAFT_ONLY';
const note = 'G1_NEXT_NOTE', summary = 'G1_NOTE_SUMMARY中文😀', prompts = [first, marker + '\n\n' + summary, third];
const replies = ['G1_FIRST_EXACT中文😀', 'G1_SECOND_EXACT中文😀', 'G1_THIRD_EXACT中文😀'];
const call = { id: 'g1-quit-sleep', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":60000}' } };
const notePrompt = `You are 7coder's BTW sub-agent (light model only).
The user just appended this note to the CURRENT heavy-model coding task WITHOUT interrupting it:

"${note}"

Summarize EXACTLY what the user wants in 1-2 clear, concise sentences.
Output ONLY the summarized user message text (no extra explanation, no quotes, no prefixes).
Make it read like a direct continuation of the user's task instructions for the main agent.`;
const clearWarning = 'A task is running - wait before /clear.', undoWarning = 'A task is running - wait before /undo.';
const busyWarning = 'A task is already running - queued lines are still appended to the next task.';
function occurrences(text, value) { return typeof text === 'string' ? text.split(value).length - 1 : 0; }
function guards(text, clears, busy = 1) { return occurrences(text, clearWarning) === clears && occurrences(text, undoWarning) === 1 && occurrences(text, busyWarning) === busy && !text.includes('[OK] Conversation cleared.'); }
function stepError(body, kind, step, log) {
  if (!body || !['queue', 'quit'].includes(kind) || !Number.isInteger(step) || step < 0 || step >= (kind === 'queue' ? 4 : 1)) return 'unexpected request';
  const isNote = kind === 'queue' && step === 1, round = step === 0 ? 0 : step - 1;
  const expectedPrompt = isNote ? notePrompt : kind === 'quit' ? 'G1_QUIT_ACTIVE' : prompts[round];
  const error = requestError(body, { model: isNote ? light : main, tools: !isNote, toolIds: [], lastUserIncludes: expectedPrompt });
  if (error) return error;
  if (body.stream !== (isNote ? undefined : true)) return 'wrong transport';
  const m = body.messages;
  if (isNote) return m.length === 1 && m[0].role === 'user' && m[0].content === notePrompt ? null : 'wrong complete BTW request';
  if (m.length !== (kind === 'quit' ? 2 : 2 + round * 2) || m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content) return 'wrong complete main history';
  if (kind === 'quit') return m[1].role === 'user' && m[1].content === expectedPrompt ? null : 'wrong quit task';
  if (step > 0 && log && m[0].content !== log[0].messages[0].content) return 'system drift';
  for (let i = 0; i <= round; i++) {
    if (m[i * 2 + 1].role !== 'user' || m[i * 2 + 1].content !== prompts[i]) return 'wrong draft ownership';
    if (i < round && (m[i * 2 + 2].role !== 'assistant' || m[i * 2 + 2].content !== replies[i] || m[i * 2 + 2].tool_calls)) return 'wrong prior response';
  }
  return null;
}
function transcript(log, kind) { return Array.isArray(log) && log.length === (kind === 'queue' ? 4 : 1) && log.every((body, i) => !stepError(body, kind, i, log)); }
function queueOutput(text, code) { return code === 0 && guards(text, 2, 2) && replies.every(reply => occurrences(text, reply) === 1) && occurrences(text, 'Goodbye!') === 1 && !/\[ERROR\]|MOCK_PROTOCOL|Note not queued|BTW sub-agent error/.test(text); }
function queueRuntime(events) { const tasks = Array.isArray(events) ? events.filter(e => e && e.scope === 'cli-task') : []; return tasks.length === 3 && tasks.every(e => e.status === 'ok' && executionIdentity(e.executionId)) && new Set(tasks.map(e => e.executionId)).size === 3; }
function quitResult(forced, code, elapsed, text, events, audits) {
  if (forced || code !== 0 || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 5000 || occurrences(text, 'Goodbye!') !== 1 || !text.includes('[TOOL] [DANGER MODE] Executing tool: sleep_tool') || text.includes('Slept 60000ms')) return false;
  const tasks = Array.isArray(events) ? events.filter(e => e && e.scope === 'cli-task') : [], tools = Array.isArray(audits) ? audits.filter(e => e && e.type === 'tool') : [];
  return tasks.length === 1 && tasks[0].status === 'cancelled' && tools.length === 1 && tools[0].status === 'cancelled' && tools[0].tool === 'sleep_tool' && tools[0].callId === call.id &&
    !!executionIdentity(tasks[0].executionId) && tools[0].executionId === tasks[0].executionId;
}
function persistedNote(text) {
  if (typeof text !== 'string') return false;
  const match = /^\n---\n\*\*BTW\*\* ([^\n]+)\nOriginal note: G1_NEXT_NOTE\nInjected summary: G1_NOTE_SUMMARY中文😀\n\n$/.exec(text);
  return !!match && Number.isFinite(Date.parse(match[1]));
}
async function start(kind) {
  const log = [], errors = [], sockets = new Set(), held = new Map();
  const server = http.createServer((req, res) => {
    let raw = '', bytes = 0; req.setEncoding('utf8'); req.on('error', error => errors.push(error.message));
    req.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) req.destroy(Error('G1 fixture input limit')); else raw += text; });
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('wrong model route');
        const body = JSON.parse(raw), step = log.length, error = stepError(body, kind, step, log); if (error) throw Error(error); log.push(body);
        const reply = () => {
          if (kind === 'queue' && step === 1) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: summary } }] })); return; }
          const delta = kind === 'quit' ? { role: 'assistant', content: '', tool_calls: [Object.assign({ index: 0 }, call)] } : { role: 'assistant', content: replies[step ? step - 1 : 0] };
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
        };
        if (kind === 'queue' && step < 2) held.set(step, reply); else reply();
      } catch (error) { errors.push(error.message); res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'MOCK_PROTOCOL ' + error.message } })); }
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { log, errors, endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', waiting: step => held.has(step), release(step) { const reply = held.get(step); if (!reply) throw Error('G1 step is not held'); held.delete(step); reply(); }, async close() { held.clear(); for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); } };
}
module.exports = { main, light, first, marker, third, note, summary, prompts, replies, call, notePrompt, guards, stepError, transcript, queueOutput, queueRuntime, quitResult, persistedNote, start };
