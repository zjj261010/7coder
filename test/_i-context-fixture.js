// Suite I business oracles. Expected bytes/identities do not come from product code.
const { pairingValid, requestError } = require('./_protocol');
const main = 'i-context-main', light = 'i-context-light';
const deadPrompt = 'DZPAYLOAD-' + 'x'.repeat(600) + '-TAIL_CONSTRAINT_中文😀';
const nextPrompt = 'SECOND_TASK_DO_NOT_REPEAT_READ';
const giantPrompt = 'GIANT-' + 'y'.repeat(8000) + '-GIANT_TAIL_中文😀';
const seed = 'SEED_READ_BODY_中文😀';
const readCall = { id: 'i-dz-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"seed.txt"}' } };
const digest = 'DIGEST_OLD_USER_GOALS_AND_TAIL';
const firstReply = 'DEADZONE-FIRST-DONE', secondReply = 'DEADZONE-SECOND-DONE', giantReply = 'NOLOOP-DONE';
const expect = (model, lastUserIncludes, ids, results) => ({ model, tools: model === main, lastUserIncludes, toolIds: ids || [], toolResults: results || {} });
const deadScript = [
  { expect: expect(main, deadPrompt), reply: { role: 'assistant', content: null, tool_calls: [readCall] } },
  { expect: expect(main, deadPrompt, [readCall.id], { [readCall.id]: seed }), reply: firstReply },
  { expect: expect(light, deadPrompt), reply: digest },
  { expect: expect(main, nextPrompt, [readCall.id], { [readCall.id]: seed }), reply: secondReply }
];
const giantScript = [{ expect: expect(main, giantPrompt), reply: giantReply }];
const objectInput = { weird: 'object', n: 1, enabled: false, empty: null, nested: { text: '中文😀\n"\\' } };
const assistantInput = { done: ['literal', 0, false], note: 'ASSISTANT_OBJECT_TAIL' };
const stringInput = 'STRING_LITERAL [object Object] "quote" \\path\n中文😀\r\nSTRING_TAIL';
const contentMessages = [{ role: 'user', content: objectInput }, { role: 'assistant', content: assistantInput }, { role: 'user', content: stringInput }];
const objectReply = 'CF-OBJECT-DONE', stringReply = 'CF-STRING-DONE', rejectedInput = 'INTENTIONAL_UPSTREAM_REJECTION';
const contentScript = [
  { expect: expect(main, stringInput), reply: objectReply },
  { expect: expect(main, stringInput), reply: stringReply }
];
const plainMessages = request => request.messages.filter(m => m.role !== 'system');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function valid(log) { return Array.isArray(log) && log.length > 0 && log.every(r => r && pairingValid(r.messages)); }
function deadEvidence(log) {
  if (!valid(log) || log.length !== 4 || log.some((r, i) => requestError(r, deadScript[i].expect))) return false;
  const a = plainMessages(log[0]), b = plainMessages(log[1]), summarized = plainMessages(log[2]), c = plainMessages(log[3]);
  if (!same(a, [{ role: 'user', content: deadPrompt }]) || b.length !== 3 || c.length !== 5 || summarized.length !== 1) return false;
  const result = b[2];
  return b[1].role === 'assistant' && same(b[1].tool_calls, [readCall]) && result.role === 'tool' && result.tool_call_id === readCall.id &&
    result.content.includes(seed) && b[0].content === deadPrompt &&
    summarized[0].content.endsWith('Part 1/1.\n\nuser: ' + deadPrompt) &&
    c[0].role === 'user' && c[0].content.startsWith('[CONTEXT COMPRESSION]') && c[0].content.endsWith('\n' + digest) &&
    same(c.slice(1, 3), b.slice(1)) && same(c.slice(3), [{ role: 'assistant', content: firstReply }, { role: 'user', content: nextPrompt }]);
}
function giantEvidence(log) {
  return valid(log) && log.length === 1 && !requestError(log[0], giantScript[0].expect) &&
    same(plainMessages(log[0]), [{ role: 'user', content: giantPrompt }]);
}
function contentEvidence(log) {
  if (!valid(log) || log.length !== 3) return false;
  const expected = contentMessages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  return log.every(r => r.model === main && Array.isArray(r.tools) && r.tools.length > 0) &&
    !log[0].stream && same(plainMessages(log[0]), expected) &&
    !log[1].stream && same(plainMessages(log[1]), [{ role: 'user', content: rejectedInput }]) &&
    log[2].stream === true && same(plainMessages(log[2]), [{ role: 'user', content: stringInput }]);
}
module.exports = { main, light, deadPrompt, nextPrompt, giantPrompt, seed, readCall, digest, firstReply, secondReply, giantReply,
  deadScript, giantScript, objectInput, assistantInput, stringInput, contentMessages, contentScript, objectReply, stringReply, rejectedInput,
  deadEvidence, giantEvidence, contentEvidence };
