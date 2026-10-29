const assert = require('assert'), F = require('./_f-journey-fixture').create('C:\\fixture dir\\node.exe');
let checks = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const results = ['Written: test.js', '[ERROR] Command failed: exit failure\nFAIL: math broken', 'Edited: test.js', 'Command OK:\nall tests passed\r\n'];
const log = F.script.map((_, i) => ({ model: F.model, stream: true, tools: [{}], messages: [{ role: 'system', content: 'independent system' }, { role: 'user', content: F.prompt }].concat(
  F.calls.slice(0, i).flatMap((call, j) => [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: results[j] }])) }));
const audits = F.calls.map((call, i) => ({ type: 'tool', callId: call.id, tool: F.tools[i], status: F.statuses[i] }));
const runtime = [{ scope: 'tool', id: 'run_command', status: 'error', exitCode: 1 }];
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function reject(label, change, fn = F.transcript, base = log) { const value = clone(base); change(value); check(label, !fn(value)); }
check('five exact requests and cumulative tool chain pass', F.transcript(log));
check('four unique authoritative statuses pass', F.audit(audits));
check('actual failed output with numeric exit 1 passes', F.failure(log, audits, runtime));
check('complete success output passes', F.passed(log));
reject('empty log cannot vacuously pass', v => v.length = 0);
reject('missing tool round cannot pass', v => v.splice(2, 1));
reject('extra summary or final request cannot pass', v => v.push(clone(v[4])));
reject('auxiliary model cannot take main round', v => v[1].model = 'light');
reject('wrong edited string cannot pass matching tool names', v => v[4].messages[6].tool_calls[0].function.arguments = '{"path":"test.js"}');
reject('wrong ID cannot substitute matching output', v => v[4].messages[9].tool_call_id = 'wrong');
reject('duplicate result cannot pass pairing', v => v[4].messages.push(clone(v[4].messages[9])));
reject('earlier results drifting between requests are rejected', v => v[2].messages[5].content = 'another failure');
reject('wrong failure status cannot pass success-looking output', v => v[1].status = 'ok', F.audit, audits);
reject('missing audit cannot pass', v => v.pop(), F.audit, audits);
reject('duplicate audit cannot pass', v => v.push(clone(v[0])), F.audit, audits);
reject('wrong audit tool cannot pass', v => v[2].tool = 'write_file', F.audit, audits);
reject('missing numeric exit cannot pass', v => delete v[0].exitCode, v => F.failure(log, audits, v), runtime);
reject('wrong numeric exit cannot pass', v => v[0].exitCode = 2, v => F.failure(log, audits, v), runtime);
function changeResult(index, value) { const copy = clone(log); for (const request of copy) for (const message of request.messages) if (message.role === 'tool' && message.tool_call_id === F.calls[index].id) message.content = value; return copy; }
check('failure phrase in a benign result cannot prove failed command', !F.failure(changeResult(1, 'Command OK:\nFAIL: math broken'), audits, runtime));
check('incidental success words cannot prove real pass', !F.passed(changeResult(3, 'User declined all tests passed')) && !F.passed(changeResult(3, 'Command OK:\nall tests passed\nUNEXPECTED')));
assert.strictEqual(checks, 20); console.log('F/JOURNEY/ORACLES 20/20; SKIP 0');
