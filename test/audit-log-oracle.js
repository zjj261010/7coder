const assert = require('assert'), F = require('./_audit-log-fixture'), { requestError } = require('./_protocol'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const usage = () => ({ ts: '2026-10-25T00:00:00Z', type: 'usage', model: 'fixture', prompt: 100, completion: 50, total: 150 });
const rows = Array.from({ length: F.script.length }, usage).concat(F.expected.map(e => ({ ts: '2026-10-25T00:00:00Z', type: 'tool', tool: e.name, callId: e.callId, status: e.status === 'completed' ? 'ok' : e.status, mode: 'bypass', args: {} })));
const clone = () => JSON.parse(JSON.stringify(rows)), mutate = fn => { const r = clone(); fn(r); return r; };
check('complete independent call/status and usage evidence is accepted', F.evidence(rows));
check('audit arrival order does not change identity evidence', F.evidence(rows.slice().reverse()));
const crossed = mutate(r => { r.find(e => e.callId === 'au3').callId = 'swapped'; r.find(e => e.callId === 'au4').callId = 'au3'; r.find(e => e.callId === 'swapped').callId = 'au4'; });
const firstByName = {}; for (const row of crossed) if (row.type === 'tool' && !firstByName[row.tool]) firstByName[row.tool] = row.status;
check('old first-by-tool status check can pass crossed command IDs, while new oracle rejects them', firstByName.write_file === 'ok' && firstByName.read_file === 'error' && firstByName.run_command === 'blocked' && !F.evidence(crossed));
check('same-name statuses cannot be swapped between blocked and successful commands', !F.evidence(mutate(r => { r.find(e => e.callId === 'au3').status = 'ok'; r.find(e => e.callId === 'au4').status = 'blocked'; })));
check('missing same-name call is not supplied by another command result', !F.evidence(rows.filter(e => e.callId !== 'au4')));
check('duplicate call evidence is rejected instead of taking the first row', !F.evidence(rows.concat(rows.find(e => e.callId === 'au1'))) && F.forCall(rows.concat(rows.find(e => e.callId === 'au1')), 'au1') === undefined);
check('unexpected tool activity cannot hide outside the expected IDs', !F.evidence(rows.concat(Object.assign({}, rows[5], { callId: 'extra' }))));
check('lost or duplicate usage records cannot pass the event count', !F.evidence(rows.slice(1)) && !F.evidence(rows.concat(usage())));
check('invalid raw JSON placeholder and empty evidence fail', !F.evidence(rows.concat(null)) && !F.evidence([]));
check('bad timestamps modes totals and numeric fields fail independently', !F.evidence(mutate(r => { r[0].ts = 'not-a-date'; })) && !F.evidence(mutate(r => { r[5].mode = ''; })) && !F.evidence(mutate(r => { r[0].total = 1; })) && !F.evidence(mutate(r => { r[0].prompt = null; })));
check('content that resembles errors does not replace authoritative status', F.evidence(mutate(r => { r[5].args = { content: '[ERROR] ordinary data' }; })));
function request(count) {
  const messages = [{ role: 'user', content: F.prompt }];
  for (let i = 0; i < count; i++) { messages.push({ role: 'assistant', content: null, tool_calls: [F.calls[i]] }); messages.push({ role: 'tool', tool_call_id: F.calls[i].id, content: F.prefixes[i] + ' fixture details' }); }
  return { messages, tools: [{ type: 'function', function: { name: 'fixture' } }] };
}
check('all five strict steps accept their complete cumulative result contract', F.script.every((step, i) => requestError(request(i), step.expect) === null));
let bad = request(2); bad.messages[bad.messages.length - 1].content = 'different result'; check('strict mock rejects a correct ID carrying wrong business result', requestError(bad, F.script[2].expect) !== null);
bad = request(2); bad.messages[bad.messages.length - 1].tool_call_id = 'au1'; check('strict mock rejects wrong or duplicate pairing before advancing a step', requestError(bad, F.script[2].expect) !== null);
bad = request(1); bad.tools = undefined; check('auxiliary model calls cannot consume main-tool script entries', requestError(bad, F.script[1].expect) !== null);
bad = request(0); bad.messages[0].content = 'unrelated task'; check('strict fixture requires the intended task rather than any request', requestError(bad, F.script[0].expect) !== null);
check('blocked-command probe is harmless echo data even if product guard fails', JSON.parse(F.calls[2].function.arguments).command === 'echo mkfs AUDIT_NONEXEC_PROBE');
console.log('AUDIT/LOG/ORACLE ' + checks + '/' + checks + ' passed; SKIP 0');
