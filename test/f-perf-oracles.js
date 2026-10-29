'use strict';
const assert = require('assert'), F = require('./_f-perf-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const log = F.script.map((entry, step) => {
  const i = Math.floor(step / 2), light = step % 2 === 1, messages = light ? [{ role: 'user', content: F.summaryPrompt(i) }] : [{ role: 'system', content: 'FIXED_SYSTEM' }];
  if (!light) for (let j = 0; j <= i; j++) { messages.push({ role: 'user', content: F.tasks[j] }); if (j < i) messages.push({ role: 'assistant', content: F.replies[j] }); }
  return Object.assign({ model: light ? F.summary : F.main, messages }, light ? {} : { stream: true, tools: [{ type: 'function', function: { name: 'read_file' } }] });
});
check('complete forty-request conversation with twenty exact summaries is accepted', F.transcript(log));
for (const bad of [[], log.slice(0, -1), log.concat(log[39])]) assert.ok(!F.transcript(bad));
check('missing empty and extra requests cannot pass', true);
function rejects(label, mutate) { const copy = clone(log); mutate(copy); check(label, !F.transcript(copy)); }
rejects('old positional fallback response cannot substitute a later round', rows => rows[20].messages[21].content = F.tasks[0]);
rejects('lost early conversation turn cannot pass', rows => rows[38].messages.splice(1, 2));
rejects('changed previous assistant result cannot pass', rows => rows[38].messages[2].content += ' altered');
rejects('summary contamination of conversation cannot pass', rows => rows[2].messages[1].content += F.summaries[0]);
rejects('wrong light model cannot consume main step', rows => rows[20].model = F.summary);
rejects('wrong summary response tail cannot pass', rows => rows[39].messages[0].content = rows[39].messages[0].content.slice(0, -2));
rejects('buffered main transport cannot pass streaming evidence', rows => delete rows[0].stream);
rejects('streaming summary cannot pass buffered evidence', rows => rows[1].stream = true);
rejects('invented pending tool history cannot pass', rows => rows[38].messages[2].tool_calls = [{ id: 'ghost' }]);
rejects('system instruction drift cannot pass', rows => rows[38].messages[0].content += ' drift');
const events = F.tasks.map(() => ({ scope: 'cli-task', status: 'ok' }));
check('twenty exact successful terminal events are accepted', F.terminal(events));
check('failed missing extra and non-task events cannot inflate completion count', !F.terminal(events.slice(1)) && !F.terminal(events.concat(events[0])) && !F.terminal(events.map((e, i) => i ? e : { scope: 'cli-task', status: 'error' })) && !F.terminal(events.map(e => ({ scope: 'http-ready', status: e.status }))));
const text = F.replies.join('\n');
check('each complete reply once and zero exit are required', F.output(text, 0) && !F.output(text, 1) && !F.output(text + F.replies[0], 0) && !F.output(text.replace(F.replies[19], ''), 0) && !F.output(text + '[ERROR]', 0));
check('timing refuses absent negative NaN and exact deadline', F.within(1999, 2000) && ![null, undefined, NaN, -1, 2000, Infinity].some(ms => F.within(ms, 2000)));
const startup = [F.coldPrompt, F.httpPrompt].map(prompt => ({ model: F.main, stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: 'read_file' } }] }));
check('cold and HTTP stages require two exact independent requests', F.startup(startup) && !F.startup([]) && !F.startup(startup.slice(1)) && !F.startup(startup.concat(startup[1])));
const wrong = clone(startup); wrong[1].messages[1].content = F.coldPrompt;
check('cold task replay cannot substitute HTTP stage', !F.startup(wrong));
console.log('F/PERF/ORACLES ' + checks + '/' + checks);
