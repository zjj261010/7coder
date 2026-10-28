'use strict';
const assert = require('assert'), F = require('./_i-flush-fixture').create('C:\\private install\\node.exe');
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const tools = [{ type: 'function', function: { name: 'run_command' } }], system = { role: 'system', content: 'private fixture system' };
const direct = [
  { model: F.main, stream: true, tools, messages: [system, { role: 'user', content: F.directPrompt }] },
  { model: F.summary, messages: [{ role: 'user', content: 'Summary instruction\nUser task: "' + F.directPrompt + '"\nAction/Response: "' + F.big + '"' }] }
];
const first = [system, { role: 'user', content: F.workerPrompt }];
const worker = [
  { model: F.main, stream: true, tools, messages: clone(first) },
  { model: F.main, stream: true, tools, messages: clone(first).concat([{ role: 'assistant', content: null, tool_calls: [F.call] }, { role: 'tool', tool_call_id: 'bg', content: 'Command OK:\n\n[STDERR]\n' + F.stderrMarker }]) }
];
const audits = [{ type: 'tool', callId: 'bg', tool: 'run_command', status: 'ok' }];
function reject(label, base, predicate, mutate) { const value = clone(base); mutate(value); check(label, !predicate(value)); }
check('complete direct main/summary sequence is accepted', F.directEvidence(direct));
check('exactly one complete 20KB reply in surrounding logs is accepted', F.flushed('header\n' + F.big + '\n[USAGE]'));
check('complete worker result and unique successful audit are accepted', F.workerEvidence(worker, audits));
reject('empty direct evidence cannot pass', direct, F.directEvidence, a => { a.length = 0; });
reject('missing summary cannot pass a complete flush run', direct, F.directEvidence, a => a.pop());
reject('extra final fallback request cannot be ignored', direct, F.directEvidence, a => a.push(clone(a[1])));
reject('main model cannot consume the summary step', direct, F.directEvidence, a => { a[1].model = F.main; });
reject('missing main tools is not a normal main request', direct, F.directEvidence, a => { delete a[0].tools; });
reject('summary must not have main tool availability', direct, F.directEvidence, a => { a[1].tools = tools; });
reject('summary must contain the entire response tail', direct, F.directEvidence, a => { a[1].messages[0].content = a[1].messages[0].content.slice(0, -20); });
check('duplicated full reply fails exact flush evidence', !F.flushed(F.big + F.big));
check('truncated reply fails despite retaining the marker prefix', !F.flushed(F.big.slice(0, -10)));
reject('auxiliary model cannot consume a worker tool round', worker, a => F.workerEvidence(a, audits), a => { a[1].model = F.summary; });
reject('nonstream worker result round is rejected', worker, a => F.workerEvidence(a, audits), a => { a[1].stream = false; });
reject('wrong call ID cannot pass on identical stderr text', worker, a => F.workerEvidence(a, audits), a => { a[1].messages[3].tool_call_id = 'wrong'; });
reject('changed command cannot hide behind original tool ID', worker, a => F.workerEvidence(a, audits), a => { a[1].messages[2].tool_calls[0].function.arguments = '{"command":"echo success"}'; });
reject('duplicated result cannot be ignored by first match', worker, a => F.workerEvidence(a, audits), a => a[1].messages.push(clone(a[1].messages[3])));
reject('blocked audit cannot be treated as successful stderr forwarding', audits, a => F.workerEvidence(worker, a), a => { a[0].status = 'blocked'; });
reject('missing audit cannot pass', audits, a => F.workerEvidence(worker, a), a => a.pop());
reject('duplicated audit cannot pass', audits, a => F.workerEvidence(worker, a), a => a.push(clone(a[0])));
reject('marker mentioned in refusal cannot pass exact successful tool result', worker, a => F.workerEvidence(a, audits), a => { a[1].messages[3].content = 'User declined: ' + F.stderrMarker; });
reject('partial stderr suffix cannot pass exact result', worker, a => F.workerEvidence(a, audits), a => { a[1].messages[3].content = 'Command OK:\n\n[STDERR]\n' + F.stderrMarker + 'TRAILING_CORRUPTION'; });
assert.strictEqual(checks, 22); console.log('I/FLUSH-ORACLES 22/22');
