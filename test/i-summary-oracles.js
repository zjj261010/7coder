const assert = require('assert'), F = require('./_i-summary-fixture');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const logs = Array.from({ length: 4 }, (_, i) => ({ model: F.model,
  messages: (i % 2 ? [] : [{ role: 'system', content: 'independent fixture system' }]).concat([{ role: 'user', content: i % 2 ? F.summaryPrompt(Math.floor(i / 2)) : F.task(Math.floor(i / 2)) }]),
  ...(i % 2 ? {} : { tools: [{ type: 'function', function: { name: 'read_file' } }] }), ...(i === 0 ? { stream: true } : {}) }));
function reject(label, change) { const value = clone(logs); change(value); check(label, !F.evidence(value, F.document(2))); }
check('complete task/reply pairs and exact two-bullet document pass', F.evidence(logs, F.document(2)));
reject('empty evidence cannot pass vacuous every', value => value.length = 0);
reject('missing summary request fails despite correct final document', value => value.splice(1, 1));
reject('duplicate model request cannot silently repeat final fixture step', value => value.push(clone(value[3])));
reject('auxiliary call cannot consume main step', value => value[0].tools = undefined);
reject('summary must not advertise tools', value => value[1].tools = clone(value[0].tools));
reject('wrong model cannot supply otherwise matching content', value => value[1].model = 'wrong');
reject('JSON main call cannot substitute for streamed branch', value => delete value[0].stream);
reject('summary must use the buffered response branch', value => value[1].stream = true);
reject('stream summary must include complete response tail', value => value[1].messages[0].content = value[1].messages[0].content.replace('STREAM_TAIL', ''));
reject('JSON summary must retain its own task identity', value => value[3].messages[0].content = value[3].messages[0].content.replace(F.tasks[1], F.tasks[0]));
reject('first task summary cannot replace second task response', value => value[3].messages[0].content = value[1].messages[0].content);
reject('second task must receive exact prior work summary', value => value[2].messages[1].content = F.tasks[1]);
check('keywords outside markers cannot substitute for actual summary bullets', !F.evidence(logs, F.summaries.join('\n')));
check('duplicate or reversed bullets cannot pass exactly-once ordered persistence', !F.evidence(logs, F.document(2) + '- ' + F.summaries[1]) && !F.evidence(logs, F.document(2).replace(F.summaries[0], 'TEMP').replace(F.summaries[1], F.summaries[0]).replace('TEMP', F.summaries[1])));
const idle = { load: { summaries: { active: false, pending: 0, bytes: 0 } }, runtime: { activeTasks: 0, activeTools: 0 } };
check('only a fully settled queue and idle core pass', F.settled(idle) && !F.settled({}));
for (const [section, key, value] of [['load', 'active', true], ['load', 'pending', 1], ['load', 'bytes', 1], ['runtime', 'activeTasks', 1], ['runtime', 'activeTools', 1]]) {
  const dirty = clone(idle); (section === 'load' ? dirty.load.summaries : dirty.runtime)[key] = value;
  check('unreleased ' + key + ' blocks settled state', !F.settled(dirty));
}
check('strict fixture refuses requests beyond its four valid steps', F.stepError(logs[0], 4) === 'script exhausted');
console.log('I/SUMMARY/ORACLES ' + checks + '/' + checks + '; SKIP 0');
