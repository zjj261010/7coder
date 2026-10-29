const { requestError } = require('./_protocol');
function create(node) {
  const model = 'f-journey-main', prompt = 'F2_CREATE_FAIL_FIX_PASS', done = 'E2E-COMPLETE: project works';
  const original = 'if (1 + 1 !== 3) { console.error("FAIL: math broken"); process.exit(1); } console.log("all tests passed");';
  const fixed = 'if (1 + 1 !== 2) { console.error("FAIL: math broken"); process.exit(1); } console.log("all tests passed");';
  const tools = ['write_file', 'run_command', 'edit_file', 'run_command'], statuses = ['ok', 'error', 'ok', 'ok'];
  const args = [{ path: 'test.js', content: original }, { command: '"' + node + '" test.js' },
    { path: 'test.js', old_string: '1 + 1 !== 3', new_string: '1 + 1 !== 2' }, { command: '"' + node + '" test.js' }];
  const calls = tools.map((name, i) => ({ id: 'j' + (i + 1), type: 'function', function: { name, arguments: JSON.stringify(args[i]) } }));
  const script = Array.from({ length: 5 }, (_, i) => ({ expect: { model, tools: true, lastUserIncludes: prompt, toolIds: calls.slice(0, i).map(call => call.id) },
    reply: i < 4 ? { role: 'assistant', content: null, tool_calls: [calls[i]] } : done }));
  function transcript(log) {
    if (!Array.isArray(log) || log.length !== 5) return false;
    return log.every((request, i) => {
      if (requestError(request, script[i].expect) || request.stream !== true || request.messages.length !== 2 + i * 2) return false;
      const m = request.messages;
      if (m[0].role !== 'system' || !m[0].content || m[1].role !== 'user' || m[1].content !== prompt) return false;
      for (let j = 0; j < i; j++) {
        if (m[2 + j * 2].role !== 'assistant' || JSON.stringify(m[2 + j * 2].tool_calls) !== JSON.stringify([calls[j]]) ||
            m[3 + j * 2].role !== 'tool' || m[3 + j * 2].tool_call_id !== calls[j].id || typeof m[3 + j * 2].content !== 'string' ||
            m[3 + j * 2].content !== log[4].messages[3 + j * 2].content) return false;
      }
      return true;
    });
  }
  function audit(rows) {
    if (!Array.isArray(rows)) return false;
    const actual = rows.filter(row => row && row.type === 'tool');
    return actual.length === 4 && calls.every((call, i) => {
      const found = actual.filter(row => row.callId === call.id);
      return found.length === 1 && found[0].tool === tools[i] && found[0].status === statuses[i];
    });
  }
  function result(log, i) { return transcript(log) ? log[4].messages[3 + i * 2].content : null; }
  function failure(log, rows, runtime) {
    const content = result(log, 1);
    if (!audit(rows) || content === null || !content.startsWith('[ERROR] Command failed:') || !/^FAIL: math broken\r?$/m.test(content) || !Array.isArray(runtime)) return false;
    const errors = runtime.filter(row => row && row.scope === 'tool');
    return errors.length === 1 && errors[0].id === 'run_command' && errors[0].status === 'error' && errors[0].exitCode === 1;
  }
  function passed(log) { const content = result(log, 3); return content !== null && content.replace(/\r\n/g, '\n').trimEnd() === 'Command OK:\nall tests passed'; }
  return { model, prompt, done, original, fixed, tools, statuses, calls, script, transcript, audit, result, failure, passed };
}
module.exports = { create };
