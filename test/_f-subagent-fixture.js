const { requestError } = require('./_protocol');
const main = 'f-subagent-main', light = 'f-subagent-light', prompt = 'F4_PARENT_TASK', task = 'F4_CHILD_TASK_KEEP_中文😀', name = 'digger';
const files = [0, 1].map(i => 'READ' + i + '_HEAD_' + String(i).repeat(1980) + '_READ' + i + '_TAIL');
const reads = files.map(value => '     1\t' + value);
const parentCall = { id: 's0', type: 'function', function: { name: 'agent_tool', arguments: JSON.stringify({ name, task }) } };
const readCalls = [0, 1].map(i => ({ id: 'sb' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'big' + i + '.txt' }) } }));
const digest = 'F4_DIGEST_FIRST_READ_COMPLETED_DO_NOT_REPEAT', childDone = 'F4_CHILD_DONE', done = 'F4_PARENT_DONE';
const parentResult = 'Sub-agent "digger" result:\n' + childDone;
const summaryPrompt = 'Summarize this coding conversation compactly. Keep: user goals, hard constraints, files touched, completed side effects (do not repeat them), key decisions, errors hit and their fixes, open threads. Max 15 bullet lines. Part 1/1.\n\nassistant: "" [called: ' + JSON.stringify([readCalls[0]]) + ']\ntool: ' + reads[0];
const compressed = '[CONTEXT COMPRESSION] Earlier turns were summarized to fit the context window. Summary of everything before this point:\n' + digest;
const assistant = call => ({ role: 'assistant', content: null, tool_calls: [call] });
const result = (call, content) => ({ role: 'tool', tool_call_id: call.id, content });
const plain = [
  [{ role: 'user', content: prompt }],
  [{ role: 'user', content: task }],
  [{ role: 'user', content: task }, assistant(readCalls[0]), result(readCalls[0], reads[0])],
  [{ role: 'user', content: summaryPrompt }],
  [{ role: 'user', content: compressed }, { role: 'user', content: task }, assistant(readCalls[1]), result(readCalls[1], reads[1])],
  [{ role: 'user', content: prompt }, Object.assign({}, assistant(parentCall), { content: '' }), result(parentCall, parentResult)]
];
const expectedIds = [[], [], ['sb0'], [], ['sb1'], ['s0']];
const replies = [assistant(parentCall), assistant(readCalls[0]), assistant(readCalls[1]), digest, childDone, done];
const script = plain.map((messages, i) => ({ expect: { model: i === 3 ? light : main, tools: i !== 3, toolIds: expectedIds[i],
  lastUserIncludes: messages.filter(m => m.role === 'user').slice(-1)[0].content }, reply: replies[i] }));
function transcript(log) {
  if (!Array.isArray(log) || log.length !== 6) return false;
  return log.every((request, i) => {
    if (requestError(request, script[i].expect) || (request.stream === true) !== (i === 0 || i === 5)) return false;
    if (i === 3) return JSON.stringify(request.messages) === JSON.stringify(plain[i]);
    const system = request.messages[0];
    return !!system && system.role === 'system' && typeof system.content === 'string' &&
      system.content.includes('running as a SUB-AGENT named "digger"') === (i >= 1 && i <= 4) &&
      JSON.stringify(request.messages.slice(1)) === JSON.stringify(plain[i]);
  });
}
function audit(rows) {
  if (!Array.isArray(rows)) return false;
  const actual = rows.filter(row => row && row.type === 'tool'), calls = readCalls.concat(parentCall);
  return actual.length === 3 && calls.every(call => {
    const found = actual.filter(row => row.callId === call.id);
    return found.length === 1 && found[0].tool === call.function.name && found[0].status === 'ok';
  });
}
module.exports = { main, light, prompt, task, files, reads, parentCall, readCalls, digest, childDone, done, parentResult, summaryPrompt, compressed, plain, script, transcript, audit };
