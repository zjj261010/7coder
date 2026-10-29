const assert = require('assert'), F = require('./_f-crash-fixture');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const log = F.script.map((_, i) => ({ model: i === 2 ? F.summary : F.main, ...(i === 2 ? {} : { stream: true, tools: [{}] }),
  messages: (i === 2 ? [] : [{ role: 'system', content: 'independent system' }]).concat([{ role: 'user', content: i === 2 ? F.summaryPrompt : F.user(i ? F.recoverPrompt : F.crashPrompt) }]) }));
const output = '[TOOL] [DANGER MODE] Executing tool: sleep_tool';
check('one exact initial request plus actual dispatch diagnostic proves admission boundary', F.admitted(log.slice(0, 1), output));
check('empty model evidence cannot prove tool admission', !F.admitted([], output));
check('model response without dispatch diagnostic cannot prove admission', !F.admitted(log.slice(0, 1), 'ready'));
check('already finished task cannot count as killed while waiting', !F.admitted(log.slice(0, 1), output + '\n[USAGE]'));
check('request after sleep before kill cannot silently pass', !F.admitted(log.slice(0, 2), output));
if (process.env.F_CRASH_ONLY === 'admission') { assert.strictEqual(checks, 5); console.log('F/CRASH/ADMISSION 5/5; remaining assertions NOT RUN'); process.exit(0); }
check('acknowledged force and actual abnormal close under 15s pass', F.forcedClose(true, true, 1, null, 1000) && F.forcedClose(true, true, null, 'SIGKILL', 1000));
check('failed force cannot be replaced with natural close', !F.forcedClose(false, true, 1, null, 1000));
check('kill flag alone without actual close cannot pass', !F.forcedClose(true, false, 1, null, 1000));
check('successful normal close cannot count as crash', !F.forcedClose(true, true, 0, null, 1000));
check('natural 60s completion and invalid durations cannot pass', !F.forcedClose(true, true, 1, null, 60000) && !F.forcedClose(true, true, 1, null, NaN) && !F.forcedClose(true, true, 1, null, -1));
check('three exact fresh-process/summary requests pass', F.recovered(log));
for (const [label, mutate] of [
  ['missing request', v => v.splice(1, 1)], ['extra request', v => v.push(clone(v[2]))],
  ['summary taking main slot', v => v[1].model = F.summary],
  ['old task leaking across restart', v => v[1].messages.push({ role: 'assistant', tool_calls: [F.call] })],
  ['trimmed original notes', v => v[1].messages[1].content = v[1].messages[1].content.trimEnd()],
  ['truncated summary response', v => v[2].messages[0].content = v[2].messages[0].content.slice(0, -1)]
]) { const value = clone(log); mutate(value); check(label + ' is rejected', !F.recovered(value)); }
assert.strictEqual(checks, 17); console.log('F/CRASH/ORACLES 17/17; SKIP 0');
