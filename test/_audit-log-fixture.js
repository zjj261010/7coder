// Test-only business expectations for Suite B's isolated audit scenario.
const { auditMatches, resultForCall } = require('./_protocol');
const prompt = 'AUDIT_CALL_ID_TASK';
const calls = [
  { id: 'au1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'ok.txt', content: 'fine' }) } },
  { id: 'au2', type: 'function', function: { name: 'read_file', arguments: '{"path":"ghost.txt"}' } },
  // Safe even if the super-dangerous-command guard regresses: only echo data.
  { id: 'au3', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo mkfs AUDIT_NONEXEC_PROBE"}' } },
  { id: 'au4', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo check Bearer sk-audit-secret-12345"}' } }
];
const prefixes = ['Written: ok.txt', 'Read error:', 'BLOCKED: Super-dangerous command', 'Command OK:'];
const expected = [
  { callId: 'au1', name: 'write_file', status: 'completed' },
  { callId: 'au2', name: 'read_file', status: 'error' },
  { callId: 'au3', name: 'run_command', status: 'blocked' },
  { callId: 'au4', name: 'run_command', status: 'completed' }
];
const script = calls.map((call, index) => ({ expect: expectation(index), reply: { role: 'assistant', content: null, tool_calls: [call] } }));
script.push({ expect: expectation(calls.length), reply: { role: 'assistant', content: 'AUDIT-DONE' } });
function expectation(count) {
  const toolResults = {};
  for (let i = 0; i < count; i++) toolResults[calls[i].id] = prefixes[i];
  return { tools: true, lastUserIncludes: prompt, toolIds: calls.slice(0, count).map(c => c.id), toolResults };
}
function validEvent(e) {
  if (!e || typeof e.ts !== 'string' || !Number.isFinite(Date.parse(e.ts))) return false;
  if (e.type === 'usage') return typeof e.model === 'string' && !!e.model &&
    Number.isFinite(e.prompt) && e.prompt >= 0 && Number.isFinite(e.completion) && e.completion >= 0 && e.total === e.prompt + e.completion;
  return e.type === 'tool' && e.mode === 'bypass' && typeof e.tool === 'string' && typeof e.callId === 'string' && typeof e.status === 'string';
}
function evidence(rows) {
  return Array.isArray(rows) && rows.every(validEvent) && rows.filter(e => e.type === 'usage').length === script.length &&
    rows.filter(e => e.type === 'tool').length === calls.length && auditMatches(expected, rows.filter(e => e.type === 'tool'));
}
function forCall(rows, id) { return resultForCall(rows.filter(e => e && e.type === 'tool'), id); }
module.exports = { prompt, calls, expected, prefixes, script, validEvent, evidence, forCall };
