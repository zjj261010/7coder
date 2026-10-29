'use strict';
const assert = require('assert'), { create } = require('./_g-batch-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
for (const kind of ['readonly', 'mixed']) {
  const F = create(kind), schema = Array.from(new Set(F.names), name => ({ type: 'function', function: { name } }));
  const first = [{ role: 'system', content: 'STABLE_SYSTEM' }, { role: 'user', content: F.prompt }];
  const follow = first.concat({ role: 'assistant', content: '', tool_calls: F.calls }, F.calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: F.results[i] })));
  const log = [first, follow, follow.concat({ role: 'assistant', content: F.reply }, { role: 'user', content: F.recovery })].map(messages => ({ model: F.model, stream: true, tools: schema, messages }));
  check(kind + ': complete batch and independent next task retain all exact results', F.transcript(log));
  check(kind + ': missing empty and extra model calls are rejected', !F.transcript([]) && !F.transcript(log.slice(1)) && !F.transcript(log.concat(log[2])));
  function rejects(label, mutate) { const rows = clone(log); mutate(rows); check(kind + ': ' + label, !F.transcript(rows)); }
  rejects('swapped result bodies cannot pass correct ID order', rows => { const m = rows[1].messages; [m[3].content, m[5].content] = [m[5].content, m[3].content]; });
  rejects('missing tool result cannot pass', rows => rows[1].messages.splice(3, 1));
  rejects('duplicate result ID cannot pass', rows => rows[1].messages[4].tool_call_id = F.calls[0].id);
  rejects('changed batch arguments cannot pass', rows => rows[1].messages[2].tool_calls[0].function.arguments = '{}');
  rejects('buffered response cannot replace streamed main', rows => delete rows[1].stream);
  rejects('forced step-limit fallback without tools cannot masquerade as ordinary second round', rows => delete rows[1].tools);
  rejects('wrong model cannot consume batch followup', rows => rows[1].model = 'light');
  rejects('unoffered tool cannot pass protocol evidence', rows => rows[0].tools = [{ type: 'function', function: { name: 'unknown' } }]);
  rejects('recovery must retain full prior result history', rows => rows[2].messages[27].content += 'drift');
  rejects('recovery task cannot reuse first task prompt', rows => rows[2].messages[29].content = F.prompt);
  rejects('recovery cannot lose original system context', rows => rows[2].messages[0].content += 'drift');
  const id = 'exec-' + 'ab'.repeat(12) + '-1', nextId = id.slice(0, -1) + '2';
  const runtime = [{ scope: 'cli-task', status: 'ok', executionId: id }, { scope: 'cli-task', status: 'ok', executionId: nextId }];
  const audit = F.calls.map((call, i) => { const args = {}; for (const key of Object.keys(F.args[i])) args[key] = JSON.stringify(F.args[i][key]); return { type: 'tool', callId: call.id, executionId: id, tool: F.names[i], status: 'ok', ms: 1, args, result: F.results[i].substring(0, 160) }; });
  check(kind + ': twenty-five actual audit rows join only the batch task', F.audit(audit, runtime));
  check(kind + ': missing extra failed and wrong-task audit rows cannot pass', !F.audit(audit.slice(1), runtime) && !F.audit(audit.concat(audit[0]), runtime) && !F.audit(audit.map((row, i) => i ? row : { ...row, status: 'error' }), runtime) && !F.audit(audit.map((row, i) => i ? row : { ...row, executionId: nextId }), runtime));
  check(kind + ': argument and result preview drift cannot pass audit evidence', !F.audit(audit.map((row, i) => i ? row : { ...row, args: {} }), runtime) && !F.audit(audit.map((row, i) => i ? row : { ...row, result: 'wrong' }), runtime));
  check(kind + ': cancelled duplicated invalid identities and unexpected tool error cannot pass terminal evidence', !F.terminals(runtime.concat(runtime[0])) && !F.terminals(runtime.map(row => ({ ...row, executionId: id }))) && !F.terminals(runtime.map((row, i) => i ? row : { ...row, status: 'cancelled' })) && !F.terminals(runtime.map((row, i) => i ? row : { ...row, executionId: 'fake' })) && !F.terminals(runtime.concat({ scope: 'tool', status: 'error' })));
  const output = F.reply + '\n' + F.recovered + '\nGoodbye!';
  check(kind + ': exact independent replies once and normal exit zero are required', F.output(output, 0) && !F.output(output, 1) && !F.output(output + F.reply, 0) && !F.output(output.replace(F.recovered, ''), 0) && !F.output(output + 'step limit', 0));
  if (kind === 'mixed') { const reordered = audit.slice(); [reordered[1], reordered[2]] = [reordered[2], reordered[1]]; check('mixed: serial audit order is required as well as final model order', !F.audit(reordered, runtime)); }
  else { const reordered = audit.slice().reverse(); check('readonly: audit completion order may differ while results join by ID', F.audit(reordered, runtime)); }
}
console.log('G/BATCH/ORACLES ' + checks + '/' + checks);
