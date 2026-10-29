'use strict';
const assert = require('assert'), F = require('./_g-differential-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const schema = ['read_file', 'edit_file'].map(name => ({ type: 'function', function: { name } }));
const log = Array.from({ length: 11 }, (_, step) => clone({ model: F.model, stream: true, tools: schema, messages: [{ role: 'system', content: 'STABLE_SYSTEM' }].concat(F.tail(step)) }));
check('exact eleven requests preserve all real results and independent next task', F.transcript(log));
check('missing empty and extra requests cannot pass', !F.transcript([]) && !F.transcript(log.slice(1)) && !F.transcript(log.concat(log[10])));
function rejects(label, mutate) { const rows = clone(log); mutate(rows); check(label, !F.transcript(rows)); }
rejects('wrong main model cannot pass', rows => rows[0].model = 'light');
rejects('wrong transport cannot pass', rows => delete rows[1].stream);
rejects('missing edit schema cannot pass', rows => rows[0].tools.pop());
rejects('changed page arguments cannot pass correct output alone', rows => rows[1].messages[2].tool_calls[0].function.arguments = JSON.stringify({ path: F.pageFile, offset: 1, limit: 20 }));
rejects('unchanged page text with reset line numbers cannot pass', rows => rows[1].messages[3].content = F.results[0].replace(/^    10\t/, '     1\t'));
rejects('deleted empty numbered line cannot pass', rows => rows[1].messages[3].content = F.results[0].replace('\n    12\t', ''));
rejects('lost Unicode cannot pass same line range', rows => rows[1].messages[3].content = F.results[0].replace('中文😀', '??'));
rejects('EOF view must retain terminal empty line 101', rows => rows[2].messages[5].content = F.results[1].replace('\n   101\t', ''));
rejects('ambiguous edit cannot masquerade as successful mutation', rows => rows[3].messages[7].content = F.results[3]);
rejects('three replacements cannot be reported as one', rows => rows[4].messages[9].content = F.results[3].replace('(3 replacement', '(1 replacement'));
rejects('global replacement cannot replace unique serial arguments in history', rows => rows[5].messages[10].tool_calls[0].function.arguments = JSON.stringify({ path: F.serialFile, old_string: 'TOKEN', new_string: F.replacement, replace_all: true }));
rejects('next task must independently read global result with exact bytes', rows => rows[9].messages[19].content += 'drift');
rejects('next task must independently read serial result with exact bytes', rows => rows[10].messages[21].content += 'drift');
rejects('correct serial bytes under wrong result ID cannot pass', rows => rows[10].messages[21].tool_call_id = F.calls[7].id);
rejects('recovery cannot drop earlier failed edit history', rows => rows[8].messages.splice(6, 2));
rejects('new task cannot replay original input', rows => rows[8].messages[17].content = F.prompt);
rejects('continued task cannot replace system context', rows => rows[8].messages[0].content += 'drift');
function stateRows() { return Array.from({ length: 5 }, (_, i) => { const step = i + 3; return { step, requestCount: step + 1, toolCount: step, taskCount: 0, pages: Buffer.from(F.pageText), global: Buffer.from(step === 3 ? F.original : F.finalFile), serial: Buffer.from(F.stages[Math.max(0, step - 4)]), hasBackups: step !== 3 }; }); }
check('held actual file snapshots include rejection and every sequential edit stage', F.states(stateRows()));
function rejectsState(label, mutate) { const rows = stateRows(); mutate(rows); check(label, !F.states(rows)); }
rejectsState('ambiguous failure must leave original bytes intact', rows => rows[0].global = Buffer.from(F.finalFile));
rejectsState('first unique edit cannot preemptively replace later occurrences', rows => rows[2].serial = Buffer.from(F.finalFile));
rejectsState('read-only source cannot be silently changed', rows => rows[3].pages = Buffer.from(F.pageText + 'drift'));
rejectsState('rejected edit cannot create a backup', rows => rows[0].hasBackups = true);
rejectsState('actual successful edit must create backup store', rows => rows[1].hasBackups = false);
rejectsState('early task terminal cannot masquerade as held in-progress work', rows => rows[4].taskCount = 1);
rejectsState('missing repeated or wrongly ordered snapshots cannot pass', rows => { rows[3] = rows[2]; });
const id = 'exec-' + 'ab'.repeat(12) + '-1', nextId = id.slice(0, -1) + '2';
const runtime = [{ scope: 'tool', status: 'error', id: 'edit_file', callId: F.calls[2].id, executionId: id, message: F.results[2] }, { scope: 'cli-task', status: 'ok', executionId: id }, { scope: 'cli-task', status: 'ok', executionId: nextId }];
const audits = F.calls.map((call, i) => { const args = {}; for (const key of Object.keys(F.args[i])) args[key] = JSON.stringify(F.args[i][key]); return { type: 'tool', tool: F.names[i], callId: call.id, executionId: i < 7 ? id : nextId, mode: 'bypass', status: i === 2 ? 'error' : 'ok', args, result: F.results[i].split('\n')[0].substring(0, 160) }; });
check('nine authoritative audit rows join two successful tasks and exactly one expected tool error', F.audit(audits, runtime));
check('missing duplicate false-success or wrong-task audit cannot pass', !F.audit(audits.slice(1), runtime) && !F.audit(audits.concat(audits[0]), runtime) && !F.audit(audits.map((row, i) => i === 2 ? { ...row, status: 'ok' } : row), runtime) && !F.audit(audits.map((row, i) => i === 7 ? { ...row, executionId: id } : row), runtime));
check('wrong args result and permission mode cannot pass', !F.audit(audits.map((row, i) => i ? row : { ...row, args: {} }), runtime) && !F.audit(audits.map((row, i) => i ? row : { ...row, result: 'wrong' }), runtime) && !F.audit(audits.map(row => ({ ...row, mode: 'auto' })), runtime));
check('expected error diagnostic must be unique and match call execution and reason', !F.audit(audits, runtime.slice(1)) && !F.audit(audits, runtime.concat(runtime[0])) && !F.audit(audits, runtime.map((row, i) => i ? row : { ...row, executionId: nextId })) && !F.audit(audits, runtime.map((row, i) => i ? row : { ...row, message: 'wrong' })));
check('failed invalid and duplicated task identities cannot pass successful continuation', !F.audit(audits, runtime.map(row => row.scope === 'cli-task' ? { ...row, status: 'error' } : row)) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: 'fake' }))) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: id }))));
const output = F.reply + '\n' + F.recovered + '\nGoodbye!';
check('exact two replies once and normal exit zero are required', F.output(output, 0) && !F.output(output, 1) && !F.output(output + F.reply, 0) && !F.output(output.replace(F.recovered, ''), 0) && !F.output(output + 'step limit', 0));
console.log('G/DIFFERENTIAL/ORACLES ' + checks + '/' + checks);
