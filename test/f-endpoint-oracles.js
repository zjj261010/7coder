'use strict';
const assert = require('assert'), F = require('./_f-endpoint-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const log = F.prompts.map(prompt => ({ method: 'POST', url: '/v1/chat/completions', body: { model: F.model, stream: true, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: 'read_file' } }] } }));
check('three exact model requests at canonical path are accepted', F.transcript(log));
check('empty missing and extra requests are rejected', !F.transcript([]) && !F.transcript(log.slice(1)) && !F.transcript(log.concat(log[0])));
function rejects(label, mutate) { const copy = JSON.parse(JSON.stringify(log)); mutate(copy); check(label, !F.transcript(copy)); }
rejects('unremoved multiple slashes are rejected', rows => rows[2].url = '/v1////chat/completions');
rejects('single extra slash is rejected', rows => rows[1].url = '/v1//chat/completions');
rejects('wrong prefix and arbitrary mock route are rejected', rows => rows[0].url = '/anything');
rejects('wrong method is rejected', rows => rows[0].method = 'GET');
rejects('replayed first task cannot pass later request', rows => rows[1].body.messages[1].content = F.prompts[0]);
rejects('wrong model is rejected', rows => rows[1].body.model = 'summary');
rejects('buffered branch cannot substitute streaming CLI', rows => rows[1].body.stream = false);
rejects('extra historical turns cannot contaminate another private workspace', rows => rows[2].body.messages.push({ role: 'user', content: 'extra' }));
rejects('missing tool schema is rejected', rows => delete rows[1].body.tools);
check('only exact complete unique reply and exit zero prove completion', F.completed(F.replies[0], 0, 0) && !F.completed(F.replies[0], 1, 0) && !F.completed(F.replies[0] + F.replies[0], 0, 0) && !F.completed(F.replies[0], 0, 1) && !F.completed(F.replies[0] + '[ERROR]', 0, 0));
console.log('F/ENDPOINT/ORACLES ' + checks + '/' + checks);
