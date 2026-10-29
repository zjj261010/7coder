'use strict';
const assert = require('assert'), F = require('./_g-command-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const schema = [{ type: 'function', function: { name: 'sleep_tool' } }];
const log = [0, 1, 2, 3].map(step => {
  if (step === 1) return { model: F.light, messages: [{ role: 'user', content: F.notePrompt }] };
  const round = step ? step - 1 : 0, messages = [{ role: 'system', content: 'STABLE_SYSTEM' }];
  for (let i = 0; i <= round; i++) { messages.push({ role: 'user', content: F.prompts[i] }); if (i < round) messages.push({ role: 'assistant', content: F.replies[i] }); }
  return { model: F.main, stream: true, tools: schema, messages };
});
check('exact four requests preserve three drafts and independent BTW request', F.transcript(log, 'queue'));
check('missing empty and extra requests cannot pass', !F.transcript([], 'queue') && !F.transcript(log.slice(1), 'queue') && !F.transcript(log.concat(log[3]), 'queue'));
function rejects(label, mutate) { const copy = clone(log); mutate(copy); check(label, !F.transcript(copy, 'queue')); }
rejects('light model cannot consume main request', rows => rows[0].model = F.light);
rejects('BTW cannot consume streaming main transport', rows => rows[1].stream = true);
rejects('main history cannot lose first user turn', rows => rows[3].messages.splice(1, 2));
rejects('late note cannot pollute already running first task', rows => rows[0].messages[1].content += F.summary);
rejects('late note cannot pollute third draft', rows => rows[3].messages[5].content += F.summary);
rejects('queued marker cannot be lost from second draft', rows => rows[2].messages[3].content = F.summary);
rejects('original unsummarized note cannot substitute successful summary', rows => rows[2].messages[3].content = F.marker + '\n\n' + F.note);
rejects('previous assistant response cannot drift', rows => rows[3].messages[2].content += 'wrong');
rejects('system context cannot drift between drafts', rows => rows[3].messages[0].content += 'wrong');
rejects('injected nonexistent tool result cannot pass', rows => rows[2].messages[2].tool_calls = [F.call]);
const warning = 'A task is running - wait before /clear.\nA task is running - wait before /undo.\nA task is already running - queued lines are still appended to the next task.\n';
const output = warning + 'A task is running - wait before /clear.\nA task is already running - queued lines are still appended to the next task.\n' + F.replies.join('\n') + '\nGoodbye!';
check('exact command guards all replies and normal quit are required', F.queueOutput(output, 0) && !F.queueOutput(output, 1));
check('Goodbye alone and duplicated reply cannot pass queue scenario', !F.queueOutput('Goodbye!', 0) && !F.queueOutput(output + F.replies[0], 0));
check('actual clear or missing rejection cannot pass', !F.queueOutput(output + '[OK] Conversation cleared.', 0) && !F.queueOutput(output.replace('A task is running - wait before /undo.', ''), 0));
const ids = [1, 2, 3].map(n => 'exec-' + 'cd'.repeat(12) + '-' + n), events = ids.map(id => ({ scope: 'cli-task', status: 'ok', executionId: id }));
check('three distinct successful task terminals are required', F.queueRuntime(events) && !F.queueRuntime(events.slice(1)) && !F.queueRuntime(events.concat(events[0])) && !F.queueRuntime(events.map(e => ({ ...e, executionId: ids[0] }))));
check('cancelled or malformed task identity cannot pass success evidence', !F.queueRuntime(events.map((e, i) => i ? e : { ...e, status: 'cancelled' })) && !F.queueRuntime(events.map((e, i) => i ? e : { ...e, executionId: 'fake' })));
const quitLog = [{ model: F.main, stream: true, tools: schema, messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'G1_QUIT_ACTIVE' }] }];
const cancelled = [{ scope: 'cli-task', status: 'cancelled', executionId: ids[0] }], audit = [{ type: 'tool', tool: 'sleep_tool', callId: F.call.id, status: 'cancelled', executionId: ids[0] }];
const quitText = '[TOOL] [DANGER MODE] Executing tool: sleep_tool\nGoodbye!';
check('one actual active quit request and matching cancelled task/tool are accepted', F.transcript(quitLog, 'quit') && F.quitResult(false, 0, 100, quitText, cancelled, audit));
check('cleanup kill natural sleep completion missing dispatch or slow close cannot pass', !F.quitResult(true, 0, 100, quitText, cancelled, audit) && !F.quitResult(false, 0, 5000, quitText, cancelled, audit) && !F.quitResult(false, 0, 100, 'Goodbye!', cancelled, audit) && !F.quitResult(false, 0, 100, quitText + 'Slept 60000ms', cancelled, audit));
check('wrong cancellation status identity or missing audit cannot pass', !F.quitResult(false, 0, 100, quitText, events.slice(0, 1), audit) && !F.quitResult(false, 0, 100, quitText, cancelled, []) && !F.quitResult(false, 0, 100, quitText, cancelled, [{ ...audit[0], executionId: ids[1] }]));
const note = '\n---\n**BTW** 2026-10-29T00:00:00.000Z\nOriginal note: ' + F.note + '\nInjected summary: ' + F.summary + '\n\n';
check('one complete persisted BTW record is accepted without loose keyword matches', F.persistedNote(note) && !F.persistedNote(note + note) && !F.persistedNote(note.replace('2026-10-29T00:00:00.000Z', 'bad-date')) && !F.persistedNote(note.replace(F.note, 'wrong')));
console.log('G/COMMAND/ORACLES ' + checks + '/' + checks);
