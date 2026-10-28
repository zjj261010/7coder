const { requestError } = require('./_protocol');
const main = 'i-flush-main', summary = 'i-flush-summary', directPrompt = 'I2_DIRECT_STREAM_CHECK', workerPrompt = 'I2_WORKER_STDERR_CHECK';
const big = 'FLUSHMARK-'.repeat(2000), directSummary = 'flush summary', workerDone = 'BG2-DONE', stderrMarker = 'BGERR-MARK';
function create(node) {
  const call = { id: 'bg', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({
    command: '"' + node + '" -e "process.stderr.write(Buffer.from(\'' + Buffer.from(stderrMarker).toString('base64') + '\',\'base64\'))"'
  }) } };
  const expect = (model, prompt, toolIds = []) => ({ model, tools: model === main, lastUserIncludes: prompt, toolIds });
  const directScript = [
    { expect: expect(main, directPrompt), reply: big },
    { expect: expect(summary, 'Action/Response: "' + big + '"'), reply: directSummary }
  ];
  const workerScript = [
    { expect: expect(main, workerPrompt), reply: { role: 'assistant', content: null, tool_calls: [call] } },
    { expect: Object.assign(expect(main, workerPrompt, ['bg']), { toolResults: { bg: '[STDERR]\n' + stderrMarker } }), reply: workerDone }
  ];
  function directEvidence(log) {
    return Array.isArray(log) && log.length === 2 && log.every((request, i) => !requestError(request, directScript[i].expect)) &&
      log[0].stream === true && log[0].messages.length === 2 && log[0].messages[0].role === 'system' && log[0].messages[1].role === 'user' && log[0].messages[1].content === directPrompt &&
      log[1].stream !== true && log[1].messages.length === 1 && log[1].messages[0].role === 'user' &&
      log[1].messages[0].content.endsWith('User task: "' + directPrompt + '"\nAction/Response: "' + big + '"');
  }
  function workerEvidence(log, audits) {
    if (!Array.isArray(log) || log.length !== 2 || log.some((request, i) => requestError(request, workerScript[i].expect) || request.stream !== true)) return false;
    const first = log[0].messages, second = log[1].messages;
    if (first.length !== 2 || first[0].role !== 'system' || first[1].role !== 'user' || first[1].content !== workerPrompt || second.length !== 4 || JSON.stringify(first) !== JSON.stringify(second.slice(0, 2))) return false;
    if (second[2].role !== 'assistant' || JSON.stringify(second[2].tool_calls) !== JSON.stringify([call]) || second[3].role !== 'tool' || second[3].tool_call_id !== 'bg' || second[3].content !== 'Command OK:\n\n[STDERR]\n' + stderrMarker) return false;
    if (!Array.isArray(audits)) return false;
    const tools = audits.filter(row => row && row.type === 'tool');
    return tools.length === 1 && tools[0].callId === 'bg' && tools[0].tool === 'run_command' && tools[0].status === 'ok';
  }
  function flushed(output) { return typeof output === 'string' && output.includes(big) && output.split('FLUSHMARK-').length - 1 === 2000; }
  return { main, summary, directPrompt, workerPrompt, big, directSummary, workerDone, stderrMarker, call, directScript, workerScript, directEvidence, workerEvidence, flushed };
}
module.exports = { create };
