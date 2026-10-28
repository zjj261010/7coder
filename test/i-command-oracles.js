'use strict';
const assert = require('assert'), F = require('./_i-command-fixture').create('C:\\private install\\node.exe');
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const outputs = ['[ERROR] Command failed:\nfixture', 'Command OK:\none\r\ntwo\r\n', 'Command OK:\n', 'Command OK:\n"quoted & ampersand"\r\n'];
const history = [{ role: 'system', content: 'private fixture system' }, { role: 'user', content: F.prompt }], log = [];
for (let i = 0; i < 5; i++) {
  log.push({ model: F.model, stream: true, tools: [{ type: 'function', function: { name: 'run_command' } }], messages: clone(history) });
  if (i < 4) history.push({ role: 'assistant', content: null, tool_calls: [F.calls[i]] }, { role: 'tool', tool_call_id: F.ids[i], content: outputs[i] });
}
const audits = F.ids.map((callId, i) => ({ type: 'tool', callId, tool: 'run_command', status: i === 0 ? 'error' : 'ok' }));
const runtime = [{ scope: 'tool', id: 'run_command', status: 'error', exitCode: 5 }];
check('complete command transcript, statuses and actual code are accepted', F.transcript(log) && F.audit(audits) && F.failure(log, audits, runtime));
function reject(label, base, predicate, mutate) { const value = clone(base); mutate(value); check(label, !predicate(value)); }
reject('empty evidence cannot pass', log, F.transcript, a => { a.length = 0; });
reject('missing final model request cannot pass', log, F.transcript, a => a.pop());
reject('repeated fallback final response cannot hide an extra request', log, F.transcript, a => a.push(clone(a[4])));
reject('auxiliary model cannot steal a command round', log, F.transcript, a => { a[1].model = 'light'; });
reject('nonstream branch cannot masquerade as the CLI stream', log, F.transcript, a => { a[0].stream = false; });
reject('modified command arguments fail despite valid IDs', log, F.transcript, a => { a[4].messages[2].tool_calls[0].function.arguments = '{"command":"echo success"}'; });
reject('wrong result ID fails despite matching output text', log, F.transcript, a => { a[4].messages[3].tool_call_id = 'wrong'; });
reject('duplicate result cannot pass pairing', log, F.transcript, a => a[4].messages.splice(4, 0, clone(a[4].messages[3])));
reject('old result drifting between successive requests is rejected', log, F.transcript, a => { a[1].messages[3].content = 'different outcome'; });
reject('wrong audit status fails even with Command OK text', audits, F.audit, a => { a[1].status = 'blocked'; });
reject('missing audit ID cannot pass', audits, F.audit, a => a.pop());
reject('duplicate audit ID cannot pass', audits, F.audit, a => a.push(clone(a[0])));
reject('audit for wrong tool cannot pass', audits, F.audit, a => { a[1].tool = 'read_file'; });
reject('missing numeric code fails despite exit word in output', runtime, a => F.failure(log, audits, a), a => { delete a[0].exitCode; });
reject('different numeric code cannot pass failure proof', runtime, a => F.failure(log, audits, a), a => { a[0].exitCode = 6; });
reject('extra failure record cannot be ignored by first-match lookup', runtime, a => F.failure(log, audits, a), a => a.push(clone(a[0])));
function changedResult(id, content) { const value = clone(log); for (const request of value) for (const message of request.messages) if (message.role === 'tool' && message.tool_call_id === id) message.content = content; return value; }
check('incidental one/two words or extra command output cannot pass chain assertion', F.stdout(changedResult('c2', 'Command OK:\none\ntwo\nUNEXPECTED'), 'c2') !== 'one\ntwo');
check('literal ampersand assertion detects lost quoting', F.stdout(changedResult('c4', 'Command OK:\nquoted\nampersand'), 'c4') !== '"quoted & ampersand"');
check('redirection success cannot be inferred from a refusal mentioning redirect', F.stdout(changedResult('c3', 'User declined redirect'), 'c3') === null);
assert.strictEqual(checks, 20); console.log('I/COMMAND-ORACLES 20/20');
