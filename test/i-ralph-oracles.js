'use strict';
const assert = require('assert'), R = require('./_i-ralph-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function transcript(f, count) { return Array.from({ length: count }, (_, i) => ({ model: f.model, stream: true, tools: [{ type: 'function', function: { name: 'read_file' } }], messages: [{ role: 'system', content: 'private fixture system' }].concat(f.expected(i)) })); }
for (const variant of R.cases) {
  const f = R.create(variant), log = transcript(f, variant.count);
  const output = variant.loops.map(i => '[LOOP] Ralph Wiggum Loop - Iteration ' + i + ': reply\n').join('') + (variant.fulfilled ? '[OK] Completion promise fulfilled at iteration ' + variant.fulfilled + '!' : '');
  check('complete ' + variant.key + ' rounds and progress are accepted', f.evidence(log) && f.progress(output));
}
const fallback = R.create(R.cases.find(value => value.key === 'fallback')), base = transcript(fallback, 3);
function reject(label, mutate) { const log = clone(base); mutate(log); check(label, !fallback.evidence(log)); }
reject('empty history cannot satisfy round bounds', a => { a.length = 0; });
reject('the old two-round completion fixture cannot prove fallback=3', a => a.pop());
reject('an extra round beyond fallback limit is rejected', a => a.push(clone(a[2])));
reject('light-model request cannot consume a refinement round', a => { a[1].model = 'i-ralph-light'; });
reject('summary request cannot consume a refinement round', a => { a[2].model = 'i-ralph-summary'; });
reject('missing tool availability cannot masquerade as a main request', a => { delete a[1].tools; });
reject('wrong transport branch is rejected', a => { a[1].stream = false; });
reject('wrong iteration number is rejected even if refine wording remains', a => { a[1].messages[3].content = a[1].messages[3].content.replace('iteration 2', 'iteration 9'); });
reject('original task cannot vanish in the final refinement', a => { a[2].messages[1].content = 'task lost'; });
reject('previous assistant reply cannot be silently replaced', a => { a[2].messages[2].content = 'different response'; });
reject('unrequested tool result cannot be added to a refinement', a => a[1].messages.push({ role: 'tool', tool_call_id: 'ghost', content: 'done' }));
check('one fulfillment banner alone cannot prove three-round fallback', !fallback.progress('Completion promise fulfilled at iteration 2!'));
check('two loop banners cannot prove three-round fallback', !fallback.progress('[LOOP] Ralph Wiggum Loop - Iteration 1:\n[LOOP] Ralph Wiggum Loop - Iteration 2:'));
const early = R.create(R.cases.find(value => value.key === 'early'));
check('early completion cannot occur at wrong iteration', !early.progress('[LOOP] Ralph Wiggum Loop - Iteration 1:\nCompletion promise fulfilled at iteration 3!'));
check('early completion cannot coexist with an unexpected later loop', !early.progress('[LOOP] Ralph Wiggum Loop - Iteration 1:\nCompletion promise fulfilled at iteration 2!\n[LOOP] Ralph Wiggum Loop - Iteration 3:'));
check('duplicate completion banners cannot pass early termination', !early.progress('[LOOP] Ralph Wiggum Loop - Iteration 1:\nCompletion promise fulfilled at iteration 2!\nCompletion promise fulfilled at iteration 2!'));
assert.strictEqual(checks, 21); console.log('I/RALPH-ORACLES 21/21');
