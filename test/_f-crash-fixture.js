const { requestError } = require('./_protocol');
const main = 'f-crash-main', summary = 'f-crash-summary', crashPrompt = 'F3_WAIT_BEFORE_FORCE', recoverPrompt = 'F3_RECOVER_SAME_WORKSPACE';
const notes = '\uFEFF    ORIGINAL_中文😀\r\n\r\n# User notes\r\n  retained tail  ', previous = 'PREVIOUS_DISTINCT_NOTES\r\n';
const reply = 'RECOVERED-OK ' + 'Recovery completed in the same workspace. '.repeat(7), saved = 'recovery summary';
const call = { id: 'f3-sleep', type: 'function', function: { name: 'sleep_tool', arguments: '{"ms":60000}' } };
const user = prompt => prompt + "\n\nthis is what's already been done.\n" + notes.slice(1);
const summaryPrompt = 'Create a short, concise summary (1-2 sentences) of what has been done in response to the user\'s task. Do not list tools, just describe the output/effect.\nUser task: "' + recoverPrompt + '"\nAction/Response: "' + reply + '"';
const script = [
  { expect: { model: main, tools: true, toolIds: [], lastUserIncludes: user(crashPrompt) }, reply: { role: 'assistant', content: null, tool_calls: [call] } },
  { expect: { model: main, tools: true, toolIds: [], lastUserIncludes: user(recoverPrompt) }, reply },
  { expect: { model: summary, tools: false, toolIds: [], lastUserIncludes: summaryPrompt }, reply: saved }
];
function step(request, index) {
  return !!request && !requestError(request, script[index].expect) && request.stream === (index !== 2 ? true : undefined) &&
    request.messages.length === (index === 2 ? 1 : 2) &&
    (index === 2 || request.messages[0].role === 'system' && typeof request.messages[0].content === 'string' && request.messages[0].content.length > 0) &&
    request.messages[index === 2 ? 0 : 1].role === 'user' && request.messages[index === 2 ? 0 : 1].content === (index === 2 ? summaryPrompt : user(index ? recoverPrompt : crashPrompt));
}
function admitted(log, output) {
  return Array.isArray(log) && log.length === 1 && step(log[0], 0) &&
    output.includes('[TOOL] [DANGER MODE] Executing tool: sleep_tool') && !/\[USAGE\]|Slept 60000ms|MOCK_PROTOCOL|\[ERROR\]/.test(output);
}
function forcedClose(forceAccepted, closed, code, signal, elapsedMs) {
  return forceAccepted === true && closed === true && (signal === 'SIGKILL' || Number.isInteger(code) && code !== 0) &&
    Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 15000;
}
function recovered(log) { return Array.isArray(log) && log.length === 3 && log.every(step); }
const document = '\uFEFF<!-- 7coder:auto-log:start -->\r\n- recovery summary\r\n<!-- 7coder:auto-log:end -->\r\n\r\n' + notes.slice(1);
module.exports = { main, summary, crashPrompt, recoverPrompt, notes, previous, reply, saved, call, script, user, summaryPrompt, admitted, forcedClose, recovered, document };
