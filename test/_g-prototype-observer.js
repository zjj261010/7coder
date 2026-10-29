'use strict';
// Test preload only. Observe this Agent's realm without modifying prototypes.
// Keep original inspection/write functions and avoid JSON.stringify, whose
// behavior itself could be changed by an inherited toJSON property.
const write = require('fs').writeSync, keys = Reflect.ownKeys;
const describe = Object.getOwnPropertyDescriptor, getProto = Object.getPrototypeOf;
const prototype = Object.prototype, beforeKeys = keys(prototype), before = [];
for (let i = 0; i < beforeKeys.length; i++) before[i] = describe(prototype, beforeKeys[i]);
process.once('exit', () => {
  try {
    const afterKeys = keys(prototype);
    let keysEqual = afterKeys.length === beforeKeys.length, descriptorsEqual = true, ordinaryClean = true;
    for (let i = 0; i < beforeKeys.length; i++) {
      if (afterKeys[i] !== beforeKeys[i]) keysEqual = false;
      const a = before[i], b = describe(prototype, beforeKeys[i]);
      if (!b || a.value !== b.value || a.get !== b.get || a.set !== b.set || a.writable !== b.writable || a.enumerable !== b.enumerable || a.configurable !== b.configurable) descriptorsEqual = false;
    }
    const ordinary = {};
    for (let p = getProto(ordinary); p !== null; p = getProto(p)) if (describe(p, 'g3PollutedSentinel')) ordinaryClean = false;
    write(3, '{"event":"prototype-exit","keysEqual":' + keysEqual + ',"descriptorsEqual":' + descriptorsEqual + ',"ordinaryProtoSame":' + (getProto(ordinary) === prototype) + ',"ordinaryClean":' + ordinaryClean + '}\n');
  } catch (error) { process.stderr.write('Prototype probe failure: ' + error.message + '\n'); }
});
