const assert = require('assert'), F = require('./_f-disconnect-fixture'); let checks = 0;
const clone = value => JSON.parse(JSON.stringify(value));
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const frame = delta => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n';
const partial = frame({ content: F.partial }), tool = frame({ tool_call: { callId: F.call.id, name: 'sleep_tool', args: { ms: '60000' } } });
if (process.env.F_DISCONNECT_ONLY === 'tool-preview') {
  check('actual string-valued sanitized tool preview proves sleep admission', F.observed(tool, 'tool'));
  check('numeric raw arguments cannot substitute for actual preview contract', !F.observed(frame({ tool_call: { callId: F.call.id, name: 'sleep_tool', args: { ms: 60000 } } }), 'tool'));
  console.log('F/DISCONNECT/TOOL-PREVIEW 2/2; other assertions NOT RUN'); process.exit(0);
}
check('unfinished exact body and exact sleep call are distinct admitted boundaries', F.observed(partial, 'partial') && F.observed(tool, 'tool'));
check('role-only first chunk cannot prove actual model output', !F.observed(frame({ role: 'assistant' }), 'partial'));
check('normal DONE cannot substitute for unfinished output', !F.observed(partial + 'data: [DONE]\n\n', 'partial'));
check('partial keyword alone cannot substitute for exact body', !F.observed(frame({ content: F.partial + 'EXTRA' }), 'partial'));
check('tool call ID and duration must match', !F.observed(tool.replace(F.call.id, 'other'), 'tool') && !F.observed(tool.replace('60000', '1'), 'tool'));
const active = { runtime: { activeTasks: 1, activeTools: 1 }, load: { chatRequests: 1, chatActive: true } };
check('actual task and sleep counters must be active together', F.active(active, 'tool') && !F.active(active, 'partial'));
const idle = { runtime: { activeTasks: 0, activeTools: 0 }, load: { chatRequests: 0, chatBodyBytes: 0, chatActive: false, chatQueued: 0, summaries: { active: false, pending: 0, bytes: 0 } } };
check('complete idle snapshot passes and empty health response does not', F.idle(idle) && !F.idle({}));
for (const [section, key, value] of [['runtime', 'activeTasks', 1], ['runtime', 'activeTools', 1], ['load', 'chatRequests', 1], ['load', 'chatBodyBytes', 1], ['load', 'chatActive', true], ['load', 'chatQueued', 1]]) {
  const dirty = clone(idle); dirty[section][key] = value; check('retained ' + key + ' cannot count as recovered', !F.idle(dirty));
}
const queued = clone(idle); queued.load.summaries.pending = 1; check('ghost summary cannot hide behind idle core', !F.idle(queued));
const log = [0, 1].map(i => ({ model: F.model, ...(i ? {} : { stream: true }), tools: [{}], messages: [{ role: 'system', content: 'fixture system' }, { role: 'user', content: i ? F.next('tool') : F.prompt('tool') }] }));
check('two exact requests keep failed task out of next history', F.transcript(log, 'tool'));
check('missing or extra model work cannot be hidden', !F.transcript([], 'tool') && !F.transcript(log.concat(log[1]), 'tool'));
const wrong = clone(log); wrong[1].messages.push({ role: 'assistant', tool_calls: [F.call] }); check('pending old tool cannot leak to fresh task', !F.transcript(wrong, 'tool'));
const audits = [{ type: 'tool', callId: F.call.id, tool: 'sleep_tool', status: 'cancelled' }], runtime = [{ scope: 'http-task', status: 'cancelled' }];
check('cancelled sleep and cancelled task are both required', F.cancellation(audits, runtime, 'tool'));
check('missing or successful tool audit cannot prove cancellation', !F.cancellation([], runtime, 'tool') && !F.cancellation([{ ...audits[0], status: 'ok' }], runtime, 'tool'));
check('normal HTTP completion cannot prove disconnect cancellation', !F.cancellation(audits, [{ scope: 'http-task', status: 'ok' }], 'tool'));
assert.strictEqual(checks, 20); console.log('F/DISCONNECT/ORACLES 20/20; SKIP 0');
