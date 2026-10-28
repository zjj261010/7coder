// I1's business oracle is independent of command output formatting internals.
const { requestError } = require('./_protocol');
const model = 'i-command-fixture', prompt = 'I1_CMD_PREFIX_BUSINESS_CHECK', done = 'I1-DONE';
const ids = ['c1', 'c2', 'c3', 'c4'], statuses = ['error', 'ok', 'ok', 'ok'];
function create(node) {
  const commands = ['"' + node + '" -e "process.exit(5)"', 'echo one & echo two', 'echo redirect > i1out.txt', 'echo "quoted & ampersand"'];
  const calls = commands.map((command, i) => ({ id: ids[i], type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }));
  const script = Array.from({ length: 5 }, (_, i) => ({ expect: { model, tools: true, lastUserIncludes: prompt, toolIds: ids.slice(0, i) },
    reply: i < 4 ? { role: 'assistant', content: null, tool_calls: [calls[i]] } : done }));
  function transcript(log) {
    if (!Array.isArray(log) || log.length !== 5) return false;
    if (requestError(log[4], script[4].expect) || log[4].messages.length !== 10) return false;
    return log.every((request, i) => {
      if (requestError(request, script[i].expect) || request.stream !== true || request.messages.length !== 2 + 2 * i) return false;
      const messages = request.messages;
      if (messages[0].role !== 'system' || typeof messages[0].content !== 'string' || !messages[0].content || messages[1].role !== 'user' || messages[1].content !== prompt) return false;
      for (let j = 0; j < i; j++) {
        const assistant = messages[2 + 2 * j], result = messages[3 + 2 * j];
        if (assistant.role !== 'assistant' || JSON.stringify(assistant.tool_calls) !== JSON.stringify([calls[j]]) || result.role !== 'tool' || result.tool_call_id !== ids[j] || typeof result.content !== 'string' || result.content !== log[4].messages[3 + 2 * j].content) return false;
      }
      return true;
    });
  }
  function audit(log) {
    if (!Array.isArray(log)) return false;
    const tools = log.filter(row => row && row.type === 'tool');
    return tools.length === 4 && ids.every((id, i) => {
      const matches = tools.filter(row => row.callId === id);
      return matches.length === 1 && matches[0].tool === 'run_command' && matches[0].status === statuses[i];
    });
  }
  function result(log, id) {
    if (!transcript(log)) return null;
    const messages = log[4].messages.filter(message => message.role === 'tool' && message.tool_call_id === id);
    return messages.length === 1 ? messages[0].content : null;
  }
  function stdout(log, id) {
    const content = result(log, id), prefix = 'Command OK:\n';
    return content !== null && content.startsWith(prefix) ? content.slice(prefix.length).replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).join('\n').trim() : null;
  }
  function failure(log, audits, runtime) {
    const content = result(log, ids[0]);
    if (!audit(audits) || content === null || !content.startsWith('[ERROR] Command failed:') || !Array.isArray(runtime)) return false;
    const errors = runtime.filter(row => row && row.scope === 'tool' && row.id === 'run_command');
    return errors.length === 1 && errors[0].status === 'error' && errors[0].exitCode === 5;
  }
  return { model, prompt, done, ids, calls, script, transcript, audit, result, stdout, failure };
}
module.exports = { create };
