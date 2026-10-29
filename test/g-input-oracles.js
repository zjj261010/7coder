'use strict';
const assert = require('assert'), F = require('./_g-input-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value)), schema = [{ type: 'function', function: { name: 'sleep_tool' } }];
function initial(prompt) { return { model: F.main, stream: true, tools: schema, messages: [{ role: 'system', content: 'STABLE_SYSTEM' }, { role: 'user', content: prompt }] }; }
const surface = [initial(F.surfacePrompt)], eof = [initial(F.eofPrompt), initial(F.eofPrompt)];
eof[1].messages.push({ role: 'assistant', content: '', tool_calls: [F.call] }, { role: 'tool', tool_call_id: F.call.id, content: '[OK] Slept 1500ms' });
check('exact literal slash task and one main request are accepted', F.transcript(surface, 'surface'));
check('missing extra and positional fallback requests cannot pass', !F.transcript([], 'surface') && !F.transcript(surface.concat(surface), 'surface') && !F.transcript([initial('/help')], 'surface'));
check('bare BTW cannot be replaced by light request or trimmed away', !F.transcript([{ ...surface[0], model: F.light }], 'surface') && !F.transcript([initial('/btw')], 'surface'));
check('buffered transport or extra whitespace in actual task cannot pass', !F.transcript([{ ...surface[0], stream: false }], 'surface') && !F.transcript([initial('   \n' + F.surfacePrompt)], 'surface'));
const surfaceText = 'No task entered.\nNo task entered.\n' + F.surfaceReply + '\nGoodbye!';
check('both empty drafts exact response and uppercase quit completion are required', F.surfaceOutput(surfaceText, 0) && !F.surfaceOutput(surfaceText, 1));
check('loose keyword missing empty check and duplicate response cannot pass', !F.surfaceOutput('No task entered.\n' + F.surfaceReply + '\nGoodbye!', 0) && !F.surfaceOutput(surfaceText + F.surfaceReply, 0));
check('unexpected BTW work or REPL error cannot pass', !F.surfaceOutput(surfaceText + '[BTW]', 0) && !F.surfaceOutput(surfaceText + '[REPL] failed', 0));
check('EOF full two-request tool history is accepted', F.transcript(eof, 'eof'));
check('EOF missing extra or empty requests cannot pass', !F.transcript([], 'eof') && !F.transcript(eof.slice(0, 1), 'eof') && !F.transcript(eof.concat(eof[1]), 'eof'));
function rejects(label, mutate) { const rows = clone(eof); mutate(rows); check(label, !F.transcript(rows, 'eof')); }
rejects('tool ID mismatch cannot pass', rows => rows[1].messages[3].tool_call_id = 'other');
rejects('wrong actual tool result cannot pass', rows => rows[1].messages[3].content = '[OK] Slept 1ms');
rejects('wrong tool duration cannot pass', rows => rows[1].messages[2].tool_calls[0].function.arguments = '{"ms":1}');
rejects('changed initial task cannot pass', rows => rows[1].messages[1].content = 'other');
rejects('system context drift cannot pass', rows => rows[1].messages[0].content += 'drift');
rejects('wrong assistant content convention cannot pass', rows => rows[1].messages[2].content = null);
const observation = [{ event: 'stdin-readline-close', stdinEnded: true }];
check('actual readline close with stdin ended is accepted', F.observedEOF(observation));
check('parent pipe finish absent duplicate or non-EOF close cannot substitute observation', !F.observedEOF([]) && !F.observedEOF(observation.concat(observation)) && !F.observedEOF([{ event: 'stdin-readline-close', stdinEnded: false }]) && !F.observedEOF([{ event: 'parent-pipe-finish', stdinEnded: true }]));
check('natural close requires zero exit no signal no cleanup kill bounded duration', F.naturalEOF(0, null, false, 1500, F.eofReply) && !F.naturalEOF(1, null, false, 1500, F.eofReply) && !F.naturalEOF(0, 'SIGTERM', false, 1500, F.eofReply) && !F.naturalEOF(0, null, true, 1500, F.eofReply) && !F.naturalEOF(0, null, false, 10000, F.eofReply) && !F.naturalEOF(0, null, false, -1, F.eofReply));
check('BYE cancellation broken prompt or duplicate output cannot masquerade as EOF completion', !F.naturalEOF(0, null, false, 1500, F.eofReply + 'Goodbye!') && !F.naturalEOF(0, null, false, 1500, F.eofReply + '[CANCELLED]') && !F.naturalEOF(0, null, false, 1500, F.eofReply + 'ERR_USE_AFTER_CLOSE') && !F.naturalEOF(0, null, false, 1500, F.eofReply + F.eofReply));
const id = 'exec-' + 'ab'.repeat(12) + '-1', runtime = [{ scope: 'cli-task', status: 'ok', executionId: id }], audits = [{ type: 'tool', tool: 'sleep_tool', callId: F.call.id, status: 'ok', executionId: id, result: '[OK] Slept 1500ms' }];
check('one actual successful task and tool with common execution identity are required', F.terminal(runtime) && F.toolCompleted(audits, runtime));
check('cancelled duplicate or malformed terminals cannot pass', !F.terminal(runtime.concat(runtime)) && !F.terminal([{ ...runtime[0], status: 'cancelled' }]) && !F.terminal([{ ...runtime[0], executionId: 'fake' }]));
check('missing cancelled wrong-ID or wrong-result tool evidence cannot pass', !F.toolCompleted([], runtime) && !F.toolCompleted([{ ...audits[0], status: 'cancelled' }], runtime) && !F.toolCompleted([{ ...audits[0], executionId: id.slice(0, -1) + '2' }], runtime) && !F.toolCompleted([{ ...audits[0], result: 'completed' }], runtime));
console.log('G/INPUT/ORACLES ' + checks + '/' + checks);
