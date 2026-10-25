// Negative controls use the exact predicates called by runner-i, no Agent mutation.
const assert = require('assert'), F = require('./_i-context-fixture');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const tools = [{ type: 'function', function: { name: 'read_file' } }];
const system = { role: 'system', content: 'fixture system' }, user = content => ({ role: 'user', content });
function request(model, messages, stream) { return Object.assign({ model, messages }, model === F.main ? { tools: clone(tools) } : {}, stream ? { stream: true } : {}); }
const result = { role: 'tool', tool_call_id: F.readCall.id, content: F.seed };
const call = { role: 'assistant', content: null, tool_calls: [F.readCall] };
const dead = [
  request(F.main, [system, user(F.deadPrompt)]),
  request(F.main, [system, user(F.deadPrompt), call, result]),
  request(F.light, [user('Summarize this coding conversation. Part 1/1.\n\nuser: ' + F.deadPrompt)]),
  request(F.main, [system, user('[CONTEXT COMPRESSION] Earlier turns:\n' + F.digest), call, result,
    { role: 'assistant', content: F.firstReply }, user(F.nextPrompt)])
];
const giant = [request(F.main, [system, user(F.giantPrompt)])];
const content = [
  request(F.main, [system].concat(F.contentMessages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })))),
  request(F.main, [system, user(F.rejectedInput)]),
  request(F.main, [system, user(F.stringInput)], true)
];
function reject(label, base, oracle, mutate) { const value = clone(base); mutate(value); check(label, !oracle(value)); }
const contentOnly = process.env.I_CONTEXT_ORACLE_SCOPE === 'content';
if (!contentOnly) {
check('complete four-request dead-zone transcript is accepted', F.deadEvidence(dead));
reject('empty evidence cannot pass through every()', dead, F.deadEvidence, a => a.length = 0);
reject('missing final main call fails even with a compression marker', dead, F.deadEvidence, a => a.pop());
reject('repeated final call is not mistaken for progress', dead, F.deadEvidence, a => a.push(clone(a[3])));
reject('auxiliary request cannot consume a main script step', dead, F.deadEvidence, a => a[2].model = F.main);
reject('compression marker with wrong digest is insufficient', dead, F.deadEvidence, a => a[3].messages[1].content = '[CONTEXT COMPRESSION]\nwrong');
reject('summary dropping the middle of the original task is detected', dead, F.deadEvidence, a => a[2].messages[0].content = 'Part 1/1.\n\nuser: ' + F.deadPrompt.replace('x'.repeat(600), 'x'));
reject('lost tool result after compression is detected', dead, F.deadEvidence, a => a[3].messages.splice(3, 1));
reject('duplicate tool result after compression is detected', dead, F.deadEvidence, a => a[3].messages.splice(3, 0, clone(a[3].messages[3])));
reject('wrong tool identity cannot borrow another result', dead, F.deadEvidence, a => a[3].messages[3].tool_call_id = 'other-read');
reject('changed tool argument is not covered by the original call', dead, F.deadEvidence, a => a[1].messages[2].tool_calls[0].function.arguments = '{"path":"wrong.txt"}');
reject('active second task remains exact rather than a matching prefix', dead, F.deadEvidence, a => a[3].messages[5].content += '-CHANGED');
reject('tool payload drift between pre/post compression is detected', dead, F.deadEvidence, a => a[3].messages[3].content += '-CHANGED');
reject('first assistant reply remains present in next task', dead, F.deadEvidence, a => a[3].messages[4].content = 'wrong prior reply');
check('one complete giant instruction is accepted', F.giantEvidence(giant));
reject('giant input truncation fails despite retained prefix and tail', giant, F.giantEvidence, a => a[0].messages[1].content = F.giantPrompt.replace('y'.repeat(8000), 'y'));
reject('an extra summary call fails the giant-task no-progress guard', giant, F.giantEvidence, a => a.push(clone(dead[2])));
}
check('complete JSON/nonretryable rejection/stream recovery transcript is accepted', F.contentEvidence(content));
reject('object substring cannot substitute for complete nested JSON', content, F.contentEvidence, a => a[0].messages[1].content = '{"weird":"object"}');
reject('object coercion to [object Object] is detected', content, F.contentEvidence, a => a[0].messages[1].content = '[object Object]');
reject('assistant structured history cannot disappear', content, F.contentEvidence, a => a[0].messages.splice(2, 1));
reject('string newline normalization is detected', content, F.contentEvidence, a => a[2].messages[1].content = F.stringInput.replace(/\r\n/g, '\n'));
reject('string prefix match cannot hide tail loss', content, F.contentEvidence, a => a[2].messages[1].content = F.stringInput.slice(0, -1));
reject('request contamination with prior object history is detected', content, F.contentEvidence, a => a[2].messages.splice(1, 0, clone(a[0].messages[1])));
reject('missing failed request cannot masquerade as recovery', content, F.contentEvidence, a => a.splice(1, 1));
reject('unexpected retry of nonretryable HTTP 400 is detected', content, F.contentEvidence, a => a.splice(1, 0, clone(a[1])));
reject('wrong transport branch cannot pass stream coverage', content, F.contentEvidence, a => delete a[2].stream);
reject('wrong model cannot pass content continuity', content, F.contentEvidence, a => a[2].model = 'wrong');
check('literal [object Object] inside a real string remains valid data', F.contentEvidence(content) && content[2].messages[1].content.includes('[object Object]'));
console.log('I/CONTEXT/ORACLES ' + checks + '/' + checks + '; SKIP 0' + (contentOnly ? '; selected content checks only; first 17 NOT RUN' : ''));
