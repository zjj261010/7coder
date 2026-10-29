'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), F = require('./_g-prototype-fixture');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
const source = fs.readFileSync(path.join(__dirname, '_g-prototype-observer.js'), 'utf8');
function observe(mutation) {
  const writes = [], errors = []; let exit;
  const context = vm.createContext({
    require(name) { assert.strictEqual(name, 'fs'); return { writeSync(fd, text) { assert.strictEqual(fd, 3); writes.push(text); } }; },
    process: { once(event, callback) { assert.strictEqual(event, 'exit'); assert.ok(!exit); exit = callback; }, stderr: { write(text) { errors.push(text); } } }
  });
  vm.runInContext(source, context);
  if (mutation) vm.runInContext(mutation, context);
  assert.strictEqual(typeof exit, 'function'); exit();
  assert.deepStrictEqual(errors, []); assert.strictEqual(writes.length, 1);
  return writes[0].trim().split('\n').map(line => JSON.parse(line));
}
const clean = observe('');
check('passive observer accepts unchanged actual realm', F.cleanObservation(clean));
check('enumerable pollution in isolated realm is detected', !F.cleanObservation(observe('Object.prototype.g3PollutedSentinel = "changed";')));
check('nonenumerable pollution in isolated realm is detected', !F.cleanObservation(observe('Object.defineProperty(Object.prototype, "g3PollutedSentinel", {value: "changed"});')));
check('descriptor value change with identical own keys is detected', !F.cleanObservation(observe('Object.prototype.hasOwnProperty = function () { return false; };')));
check('removed baseline descriptor is detected', !F.cleanObservation(observe('delete Object.prototype.propertyIsEnumerable;')));
check('polluted getter is inspected without invoking it', !F.cleanObservation(observe('Object.defineProperty(Object.prototype, "g3PollutedSentinel", {get: function () { throw Error("must not invoke getter"); }});')));
check('inherited toJSON cannot forge clean observer output', !F.cleanObservation(observe('Object.prototype.toJSON = function () { return {event:"prototype-exit",keysEqual:true,descriptorsEqual:true,ordinaryProtoSame:true,ordinaryClean:true}; };')));
check('negative controls leave host ordinary objects unchanged', !Object.prototype.hasOwnProperty.call(Object.prototype, 'g3PollutedSentinel') && !Object.prototype.hasOwnProperty.call(Object.prototype, 'toJSON'));
check('absent null and repeated observations cannot pass', !F.cleanObservation([]) && !F.cleanObservation([null]) && !F.cleanObservation(clean.concat(clean)));
check('wrong event missing flag false flag and string flag cannot pass', !F.cleanObservation([{ ...clean[0], event: 'fake' }]) && !F.cleanObservation([{ ...clean[0], keysEqual: undefined }]) && !F.cleanObservation([{ ...clean[0], descriptorsEqual: false }]) && !F.cleanObservation([{ ...clean[0], ordinaryClean: 'true' }]));
check('fixture encodes literal own proto constructor and prototype keys', Object.prototype.hasOwnProperty.call(JSON.parse(F.rawArgs[0]), '__proto__') && JSON.parse(F.rawArgs[1]).constructor.prototype.g3PollutedSentinel === F.marker && JSON.parse(F.rawArgs[2]).prototype.g3PollutedSentinel === F.marker);
const schema = Array.from(new Set(F.names), name => ({ type: 'function', function: { name } }));
const log = Array.from({ length: 6 }, (_, step) => clone({ model: F.model, stream: true, tools: schema, messages: [{ role: 'system', content: 'STABLE_SYSTEM' }].concat(F.tail(step)) }));
check('full six requests accept legitimate literal markers in args results and history', F.transcript(log) && JSON.stringify(log[5]).includes(F.marker));
check('absent missing and extra requests cannot pass', !F.transcript([]) && !F.transcript(log.slice(1)) && !F.transcript(log.concat(log[5])));
function rejects(label, mutate) { const rows = clone(log); mutate(rows); check(label, !F.transcript(rows)); }
rejects('wrong model cannot pass', rows => rows[0].model = 'wrong');
rejects('wrong main transport cannot pass', rows => delete rows[1].stream);
rejects('missing actual tool schema cannot pass', rows => rows[0].tools = [{ type: 'function', function: { name: 'unknown' } }]);
rejects('discarded literal proto argument cannot pass', rows => rows[1].messages[2].tool_calls[0].function.arguments = JSON.stringify({ path: F.file, content: F.initial }));
rejects('changed nested constructor argument cannot pass', rows => rows[2].messages[4].tool_calls[0].function.arguments = F.rawArgs[1].replace(F.marker, 'changed'));
rejects('changed prototype argument cannot pass', rows => rows[3].messages[6].tool_calls[0].function.arguments = F.rawArgs[2].replace(F.marker, 'changed'));
rejects('correct result ID with wrong file bytes cannot pass', rows => rows[3].messages[7].content += 'drift');
rejects('wrong result ID cannot pass', rows => rows[2].messages[5].tool_call_id = 'wrong');
rejects('lost previous history in recovery cannot pass', rows => rows[4].messages.splice(2, 2));
rejects('recovery must be a new exact user task', rows => rows[4].messages[9].content = F.prompt);
rejects('clean recovery must consume actual unchanged file result', rows => rows[5].messages[11].content += 'drift');
rejects('system context drift cannot pass', rows => rows[5].messages[0].content += 'drift');
const id = 'exec-' + 'cd'.repeat(12) + '-1', nextId = id.slice(0, -1) + '2';
const runtime = [{ scope: 'cli-task', status: 'ok', executionId: id }, { scope: 'cli-task', status: 'ok', executionId: nextId }];
const audits = F.calls.map((call, i) => ({ type: 'tool', callId: call.id, executionId: i === 3 ? nextId : id, tool: F.names[i], status: 'ok', args: { path: JSON.stringify(F.file), ...(i <= 1 ? { content: JSON.stringify(i ? F.appended : F.initial) } : {}) }, result: F.results[i].substring(0, 160) }));
check('four actual tool results join two successful distinct task identities', F.audit(audits, runtime));
check('missing duplicate failed or wrong-task audit cannot pass', !F.audit(audits.slice(1), runtime) && !F.audit(audits.concat(audits[0]), runtime) && !F.audit(audits.map((row, i) => i ? row : { ...row, status: 'error' }), runtime) && !F.audit(audits.map((row, i) => i === 3 ? { ...row, executionId: id } : row), runtime));
check('wrong file args and result preview cannot pass', !F.audit(audits.map((row, i) => i ? row : { ...row, args: {} }), runtime) && !F.audit(audits.map((row, i) => i ? row : { ...row, result: 'wrong' }), runtime));
check('duplicate invalid cancelled and tool-failure terminal evidence cannot pass', !F.audit(audits, runtime.concat(runtime[0])) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: id }))) && !F.audit(audits, runtime.map(row => ({ ...row, executionId: 'fake' }))) && !F.audit(audits, runtime.map(row => ({ ...row, status: 'cancelled' }))) && !F.audit(audits, runtime.concat({ scope: 'tool', status: 'error' })));
const output = F.reply + '\n' + F.recovered + '\nGoodbye!';
check('exact two replies once and normal exit zero are required', F.output(output, 0) && !F.output(output, 1) && !F.output(output + F.reply, 0) && !F.output(output.replace(F.recovered, ''), 0) && !F.output(output + 'Prototype probe failure', 0));
console.log('G/PROTOTYPE/ORACLES ' + checks + '/' + checks);
