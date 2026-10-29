'use strict';
const assert = require('assert'), { create } = require('./_g-economics-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
for (const kind of ['bypass', 'approve', 'decline']) {
  const F = create(kind), schema = Array.from(new Set(F.names), name => ({ type: 'function', function: { name } }));
  const log = Array.from({ length: F.recoveryStep + 1 }, (_, step) => clone(step === F.summaryStep ? { model: F.summaryModel, max_tokens: 128, messages: [{ role: 'user', content: F.summaryPrompt }] } : { model: F.model, stream: true, tools: schema, messages: [{ role: 'system', content: 'STABLE_SYSTEM' }].concat(F.tail(step)) }));
  check(kind + ': complete main summary and short recovery requests accepted', F.transcript(log));
  check(kind + ': absent missing and repeated summary cannot pass', !F.transcript([]) && !F.transcript(log.filter((_, step) => step !== F.summaryStep)) && !F.transcript(log.concat(log[F.summaryStep])));
  function rejects(label, mutate) { const rows = clone(log); mutate(rows); check(kind + ': ' + label, !F.transcript(rows)); }
  rejects('same call counts with summary on wrong model cannot pass', rows => rows[F.summaryStep].model = F.model);
  rejects('wrong main model cannot pass', rows => rows[0].model = F.summaryModel);
  rejects('tool-bearing summary cannot masquerade as no extra approval call', rows => rows[F.summaryStep].tools = schema);
  rejects('summary must be buffered without stream field', rows => rows[F.summaryStep].stream = false);
  rejects('changed summary token budget cannot pass', rows => rows[F.summaryStep].max_tokens = 512);
  rejects('summary must receive exact raw task and full final response', rows => rows[F.summaryStep].messages[0].content = F.summaryPrompt.slice(0, -1));
  rejects('correct tool ID with wrong result body cannot pass', rows => rows[1].messages[3].content += 'wrong');
  rejects('changed actual tool arguments cannot pass', rows => rows[1].messages[2].tool_calls[0].function.arguments = '{}');
  rejects('main without offered tool schemas cannot pass', rows => delete rows[0].tools);
  rejects('recovery must retain complete prior history', rows => rows[F.recoveryStep].messages.splice(2, 2));
  rejects('continued task must not be polluted by reinjected worklog', rows => rows[F.recoveryStep].messages[2 * F.n + 3].content = F.recovery + '\n\n' + F.worklog);
  rejects('persisted summary cannot replace actual final reply in conversation', rows => rows[F.recoveryStep].messages[2 * F.n + 2].content = F.summary);
  rejects('recovery keeps original system context', rows => rows[F.recoveryStep].messages[0].content += 'drift');
  if (process.env.G_ECONOMICS_ORACLES_ONLY === 'transcript') continue;
  const id = 'exec-' + 'ef'.repeat(12) + '-1', nextId = id.slice(0, -1) + '2';
  const runtime = [{ scope: 'cli-task', status: 'ok', executionId: id }, { scope: 'cli-task', status: 'ok', executionId: nextId }];
  if (kind === 'decline') runtime.unshift({ scope: 'tool', status: 'declined', executionId: id, callId: F.calls[0].id });
  const audits = F.calls.map((call, i) => { const args = {}; for (const key of Object.keys(F.args[i])) args[key] = JSON.stringify(F.args[i][key]); return { type: 'tool', tool: F.names[i], callId: call.id, executionId: id, mode: kind === 'bypass' ? 'bypass' : 'default', status: kind === 'decline' ? 'declined' : 'ok', args, result: F.results[i].substring(0, 160) }; });
  check(kind + ': real audit authority joins correct task and permission mode', F.audit(audits, runtime));
  check(kind + ': missing duplicated wrong-status and wrong-task audit cannot pass', !F.audit(audits.slice(1), runtime) && !F.audit(audits.concat(audits[0]), runtime) && !F.audit(audits.map((row, i) => i ? row : { ...row, status: 'error' }), runtime) && !F.audit(audits.map(row => ({ ...row, executionId: nextId })), runtime));
  check(kind + ': wrong permission mode args and file result cannot pass', !F.audit(audits.map(row => ({ ...row, mode: 'auto' })), runtime) && !F.audit(audits.map(row => ({ ...row, args: {} })), runtime) && !F.audit(audits.map(row => ({ ...row, result: 'wrong' })), runtime));
  check(kind + ': failed duplicate invalid task and extra tool failure cannot pass', !F.audit(audits, runtime.map(row => row.scope === 'cli-task' ? { ...row, status: 'error' } : row)) && !F.audit(audits, runtime.concat(runtime[runtime.length - 1])) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: 'fake' }))) && !F.audit(audits, runtime.concat({ scope: 'tool', status: 'error' })));
  if (kind === 'decline') check('decline: missing or wrong correlated refusal diagnostic cannot pass', !F.audit(audits, runtime.filter(row => row.scope !== 'tool')) && !F.audit(audits, runtime.map(row => row.scope === 'tool' ? { ...row, executionId: nextId } : row)));
  const prelude = kind === 'bypass' ? '' : '[PERM] Proposed change to ' + F.file + ':\n' + F.diff + '\n' + F.question;
  const output = prelude + F.reply + '\n[OK] 7CODER.md updated with complete summary\n' + F.recovered + '\nGoodbye!';
  check(kind + ': exact final next reply and one persisted summary message accepted', F.output(output, 0));
  check(kind + ': nonzero exit duplicated reply missing response and duplicate summary update rejected', !F.output(output, 1) && !F.output(output + F.reply, 0) && !F.output(output.replace(F.recovered, ''), 0) && !F.output(output + '[OK] 7CODER.md updated with complete summary', 0));
  if (kind !== 'bypass') check(kind + ': generic preview words cannot replace real diff and approval question', !F.output(output.replace(F.diff, 'invented preview'), 0) && !F.output(output.replace(F.question, ''), 0));
  else check('bypass: accidental permission prompt cannot pass', !F.output(output + '(y/n)', 0));
}
console.log('G/ECONOMICS/ORACLES ' + checks + '/' + checks);
