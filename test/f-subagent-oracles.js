const assert = require('assert'), F = require('./_f-subagent-fixture');
let checks = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const log = F.plain.map((messages, i) => ({ model: i === 3 ? F.light : F.main, ...(i === 3 ? {} : { tools: [{}] }), ...(i === 0 || i === 5 ? { stream: true } : {}),
  messages: (i === 3 ? [] : [{ role: 'system', content: 'independent system' + (i >= 1 && i <= 4 ? ' running as a SUB-AGENT named "digger"' : '') }]).concat(messages) }));
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function reject(label, mutate) { const value = clone(log); mutate(value); check(label, !F.transcript(value)); }
if (process.env.F_SUBAGENT_ONLY === 'content') {
  check('streamed parent empty content and buffered child null content pass exact transcript', F.transcript(log));
  reject('null parent content cannot replace actual SSE accumulator bytes', v => v[5].messages[2].content = null);
  console.log('F/SUBAGENT/CONTENT 2/2; other assertions NOT RUN'); process.exit(0);
}
if (process.env.F_SUBAGENT_ONLY === 'transport') {
  check('actual parent streamed and child buffered transport passes exact transcript', F.transcript(log));
  reject('streaming child cannot impersonate current buffered sub-agent path', v => v[1].stream = true);
  console.log('F/SUBAGENT/TRANSPORT 2/2; other assertions NOT RUN'); process.exit(0);
}
check('complete isolated parent/child/compression transcript passes', F.transcript(log));
reject('empty evidence cannot vacuously pass', v => v.length = 0);
reject('missing compressor cannot pass apparent child success', v => v.splice(3, 1));
reject('extra positional filler cannot be hidden', v => v.push(clone(v[5])));
reject('light model cannot impersonate child tool round', v => v[2].model = F.light);
reject('main model cannot impersonate auxiliary compressor', v => v[3].model = F.main);
reject('compression in parent system does not prove child compression', v => v[4].messages[0].content = 'parent system');
reject('child role cannot leak into parent after return', v => v[5].messages[0].content += ' running as a SUB-AGENT named "digger"');
reject('wrong read tool arguments cannot pass matching IDs', v => v[2].messages[2].tool_calls[0].function.arguments = '{"path":"other.txt"}');
reject('first file tail must reach compressor', v => v[3].messages[0].content = v[3].messages[0].content.replace('_READ0_TAIL', ''));
reject('active child task cannot be replaced by a digest', v => v[4].messages[2].content = F.digest);
reject('kept second file cannot be lost after compression', v => v[4].messages[4].content = 'partial');
reject('compressed old read cannot be replayed as current history', v => v[4].messages.push(clone(v[2].messages[3])));
reject('child result cannot be substituted with parent final reply', v => v[5].messages[3].content = F.done);
const audits = F.readCalls.concat(F.parentCall).map(call => ({ type: 'tool', callId: call.id, tool: call.function.name, status: 'ok' }));
check('three exact unique nested audit identities pass', F.audit(audits));
const wrong = clone(audits); wrong[0].status = 'error'; check('nested failure status cannot be hidden by parent ok', !F.audit(wrong));
check('missing or duplicate child audits cannot pass', !F.audit(audits.slice(1)) && !F.audit(audits.concat(audits[0])));
assert.strictEqual(checks, 17); console.log('F/SUBAGENT/ORACLES 17/17; SKIP 0');
