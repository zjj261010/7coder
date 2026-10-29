'use strict';
const assert = require('assert'), F = require('./_g-text-boundary-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
check('short literal replies avoid auxiliary summaries and first text embeds exact later structured call', F.replies.every(reply => reply.trim().length > 0 && reply.trim().length < 200) && JSON.stringify(JSON.parse(F.literalReply).tool_calls[0]) === JSON.stringify(F.calls[0]));
const schema = ['write_file', 'read_file'].map(name => ({ type: 'function', function: { name } }));
const log = Array.from({ length: 5 }, (_, step) => clone({ model: F.model, stream: true, tools: schema, messages: [{ role: 'system', content: 'STABLE_SYSTEM' }].concat(F.tail(step)) }));
check('all five exact requests accept note JSON and assistant JSON as strings', F.transcript(log));
check('absent missing and extra requests cannot pass zero-tools claim', !F.transcript([]) && !F.transcript(log.slice(1)) && !F.transcript(log.concat(log[4])));
function rejects(label, mutate) { const rows = clone(log); mutate(rows); check(label, !F.transcript(rows)); }
rejects('wrong main model cannot pass', rows => rows[0].model = 'light');
rejects('wrong transport or missing write schema cannot pass', rows => { delete rows[0].stream; rows[0].tools.shift(); });
rejects('initial note input must exclude only file-start BOM', rows => rows[0].messages[1].content = F.prompts[0] + "\n\nthis is what's already been done.\n" + F.noteText);
rejects('CRLF note bytes cannot be normalized silently in prompt', rows => rows[0].messages[1].content = rows[0].messages[1].content.replace(/\r\n/g, '\n'));
rejects('trailing note whitespace cannot be lost', rows => rows[0].messages[1].content = rows[0].messages[1].content.trim());
rejects('note JSON cannot be promoted into real assistant tool declaration', rows => rows[0].messages[1] = { role: 'assistant', content: '', tool_calls: [F.calls[0]] });
rejects('assistant text cannot be replayed as actual structured tool call', rows => rows[1].messages[2] = { role: 'assistant', content: '', tool_calls: [F.calls[0]] });
rejects('assistant literal JSON must be retained exactly in continued history', rows => rows[1].messages[2].content += 'drift');
rejects('ongoing next task must not receive reinjected note wrapper', rows => rows[1].messages[3].content = F.wrapped(F.prompts[1]));
rejects('positive control must use exact actual write arguments', rows => rows[2].messages[4].tool_calls[0].function.arguments = '{}');
rejects('positive control must retain real written result and ID', rows => rows[2].messages[5].tool_call_id = 'fake');
rejects('new conversation after clear must reread exact note text', rows => rows[3].messages[1].content = F.prompts[2]);
rejects('new conversation cannot retain earlier fake assistant history', rows => rows[3].messages.splice(1, 0, { role: 'assistant', content: F.literalReply }));
rejects('actual readback cannot be replaced by note text', rows => rows[4].messages[3].content = F.noteText);
rejects('system context must remain unchanged after clear', rows => rows[3].messages[0].content += 'drift');
function stateRows() { return Array.from({ length: 6 }, (_, phase) => ({ phase, requestCount: [1, 1, 3, 3, 5, 5][phase], toolCount: [0, 0, 1, 1, 2, 2][phase], taskCount: [0, 1, 1, 2, 2, 3][phase], notes: Buffer.from(F.noteText), guard: Buffer.from(F.guard), forbiddenExists: false, real: phase < 2 ? null : Buffer.from(F.content) })); }
check('literal no-action then real write read and literal final have complete file-state evidence', F.states(stateRows()));
function rejectsState(label, mutate) { const rows = stateRows(); mutate(rows); check(label, !F.states(rows)); }
rejectsState('plain JSON reply cannot create control file before real structured call', rows => rows[1].real = Buffer.from(F.content));
rejectsState('forged tool text in notes cannot change guard file', rows => rows[0].guard = Buffer.from('SHOULD_NOT_RUN'));
rejectsState('final fenced function text cannot create its target', rows => rows[5].forbiddenExists = true);
rejectsState('disk notes must keep original BOM even though prompt strips it', rows => rows[5].notes = Buffer.from(F.noteText.slice(1)));
rejectsState('positive control cannot claim success while tool pipeline is disabled', rows => rows[2].real = null);
rejectsState('text-only task cannot hide extra real tool events', rows => rows[1].toolCount = 1);
rejectsState('inactive or missing later task cannot pass preserved files alone', rows => rows[5].taskCount = 2);
const ids = [1, 2, 3].map(n => 'exec-' + 'ef'.repeat(12) + '-' + n);
const runtime = ids.map(executionId => ({ scope: 'cli-task', status: 'ok', executionId }));
const audits = F.calls.map((call, i) => { const source = JSON.parse(call.function.arguments), args = {}; for (const key of Object.keys(source)) args[key] = JSON.stringify(source[key]); return { type: 'tool', tool: call.function.name, callId: call.id, executionId: ids[i + 1], mode: 'bypass', status: 'ok', args, result: F.results[i] }; });
check('only real positive-control write and fresh-session read join their exact parent tasks', F.audit(audits, runtime));
check('missing extra wrong-status or wrong-parent tool audit cannot pass', !F.audit(audits.slice(1), runtime) && !F.audit(audits.concat(audits[0]), runtime) && !F.audit(audits.map((row, i) => i ? row : { ...row, status: 'error' }), runtime) && !F.audit(audits.map((row, i) => i ? row : { ...row, executionId: ids[0] }), runtime));
check('wrong arguments result mode and hidden runtime error cannot pass', !F.audit(audits.map(row => ({ ...row, args: {} })), runtime) && !F.audit(audits.map(row => ({ ...row, result: 'wrong' })), runtime) && !F.audit(audits.map(row => ({ ...row, mode: 'auto' })), runtime) && !F.audit(audits, runtime.concat({ scope: 'tool', status: 'error' })));
check('failed duplicate and invalid task identities cannot pass normal continuation', !F.audit(audits, runtime.map(row => ({ ...row, status: 'error' }))) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: ids[0] }))) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: 'fake' }))));
const output = F.replies.join('\n') + '\n' + F.clearMessage + '\nGoodbye!';
check('all exact content replies one clear and normal exit zero required', F.output(output, 0) && !F.output(output, 1) && !F.output(output + F.literalReply, 0) && !F.output(output.replace(F.finalReply, ''), 0) && !F.output(output.replace(F.clearMessage, ''), 0) && !F.output(output + 'step limit', 0));
console.log('G/TEXT-BOUNDARY/ORACLES ' + checks + '/' + checks);
