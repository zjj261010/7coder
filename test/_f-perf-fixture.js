'use strict';
const { requestError } = require('./_protocol');
const main = 'f-perf-main', summary = 'f-perf-summary', count = 20;
const tasks = Array.from({ length: count }, (_, i) => 'F1_TASK_' + (i + 1));
const replies = tasks.map(task => task + '_REPLY中文😀 ' + 'Complete unique task output. '.repeat(9));
const summaries = tasks.map(task => task + '_SUMMARY中文😀');
const coldPrompt = 'F1_COLD', httpPrompt = 'F1_HTTP', coldReply = 'F1_COLD_EXACT', httpReply = 'F1_HTTP_EXACT中文😀';
function summaryPrompt(i) { return `Create a short, concise summary (1-2 sentences) of what has been done in response to the user's task. Do not list tools, just describe the output/effect.\nUser task: "${tasks[i]}"\nAction/Response: "${replies[i]}"`; }
const script = tasks.reduce((steps, task, i) => steps.concat([
  { expect: { model: main, tools: true, toolIds: [], lastUserIncludes: task }, reply: replies[i] },
  { expect: { model: summary, tools: false, toolIds: [], lastUserIncludes: summaryPrompt(i) }, reply: summaries[i] }
]), []);
const startupScript = [coldPrompt, httpPrompt].map((prompt, i) => ({ expect: { model: main, tools: true, toolIds: [], lastUserIncludes: prompt }, reply: i ? httpReply : coldReply }));
function startup(log) {
  return Array.isArray(log) && log.length === 2 && log.every((body, i) => !requestError(body, startupScript[i].expect) && body.stream === true &&
    body.messages.length === 2 && body.messages[0].role === 'system' && typeof body.messages[0].content === 'string' && body.messages[0].content &&
    body.messages[1].role === 'user' && body.messages[1].content === (i ? httpPrompt : coldPrompt));
}
function transcript(log) {
  if (!Array.isArray(log) || log.length !== count * 2) return false;
  return log.every((body, step) => {
    const i = Math.floor(step / 2), light = step % 2 === 1;
    if (requestError(body, script[step].expect) || body.stream !== (light ? undefined : true)) return false;
    const m = body.messages;
    if (light) return m.length === 1 && m[0].role === 'user' && m[0].content === summaryPrompt(i);
    if (m.length !== 2 + i * 2 || m[0].role !== 'system' || typeof m[0].content !== 'string' || !m[0].content || m[0].content !== log[0].messages[0].content) return false;
    for (let j = 0; j <= i; j++) {
      if (m[j * 2 + 1].role !== 'user' || m[j * 2 + 1].content !== tasks[j]) return false;
      if (j < i && (m[j * 2 + 2].role !== 'assistant' || m[j * 2 + 2].content !== replies[j] || m[j * 2 + 2].tool_calls)) return false;
    }
    return true;
  });
}
function document(n) { return '<!-- 7coder:auto-log:start -->\n' + summaries.slice(0, n).map(s => '- ' + s).join('\n') + '\n<!-- 7coder:auto-log:end -->\n'; }
function terminal(events) { const tasks = Array.isArray(events) ? events.filter(e => e && e.scope === 'cli-task') : []; return tasks.length === count && tasks.every(e => e.status === 'ok'); }
function output(text, code) { return code === 0 && typeof text === 'string' && replies.every(reply => text.split(reply).length === 2) && !/MOCK_PROTOCOL|\[ERROR\]|EXECUTION_DEADLINE|Error writing to 7CODER/.test(text); }
function within(ms, limit) { return Number.isFinite(ms) && ms >= 0 && ms < limit; }
module.exports = { main, summary, count, tasks, replies, summaries, coldPrompt, httpPrompt, coldReply, httpReply, script, startupScript, startup, transcript, document, terminal, output, within, summaryPrompt };
