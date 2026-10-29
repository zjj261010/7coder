const { requestError } = require('./_protocol');
const main = 'i-worklog-main', summary = 'i-worklog-summary';
const notes = '\uFEFF    CODE_首行缩进\r\n\r\n# My project notes\r\n\r\n- my own bullet stays\r\n\r\n## Plan\r\n- plan step\r\n\r\n  ';
const tasks = ['I5_FIRST_TASK', 'I5_SECOND_TASK'];
const replies = ['T1-REPLY ' + 'first task reply padded past the summary floor. '.repeat(6), 'T2-REPLY ' + 'second task reply padded past the summary floor. '.repeat(6)];
const summaries = ['first task summary\ncontinued 中文😀', 'second task summary\n- nested detail'];
const sections = [
  '<!-- 7coder:auto-log:start -->\r\n- first task summary\r\n  continued 中文😀\r\n<!-- 7coder:auto-log:end -->',
  '<!-- 7coder:auto-log:start -->\r\n- first task summary\r\n  continued 中文😀\r\n- second task summary\r\n  - nested detail\r\n<!-- 7coder:auto-log:end -->'
];
const document = index => '\uFEFF' + sections[index] + '\r\n\r\n' + notes.slice(1);
const firstUser = tasks[0] + '\n\nthis is what\'s already been done.\n' + notes.slice(1);
const summaryPrompt = index => 'Create a short, concise summary (1-2 sentences) of what has been done in response to the user\'s task. Do not list tools, just describe the output/effect.\nUser task: "' + tasks[index] + '"\nAction/Response: "' + replies[index] + '"';
const script = [0, 1, 2, 3].map(step => { const index = Math.floor(step / 2), auxiliary = step % 2 === 1;
  return { expect: { model: auxiliary ? summary : main, tools: !auxiliary, toolIds: [], lastUserIncludes: auxiliary ? summaryPrompt(index) : index ? tasks[index] : firstUser }, reply: auxiliary ? summaries[index] : replies[index] };
});
function evidence(log) {
  if (!Array.isArray(log) || log.length !== 4 || log.some((request, i) => requestError(request, script[i].expect))) return false;
  const history = [{ role: 'user', content: firstUser }];
  return log.every((request, step) => {
    const index = Math.floor(step / 2);
    if (step % 2) return request.stream !== true && JSON.stringify(request.messages) === JSON.stringify([{ role: 'user', content: summaryPrompt(index) }]);
    if (index) history.push({ role: 'assistant', content: replies[0] }, { role: 'user', content: tasks[1] });
    return request.stream === true && request.messages[0].role === 'system' && JSON.stringify(request.messages.slice(1)) === JSON.stringify(history);
  });
}
module.exports = { main, summary, notes, tasks, replies, summaries, document, firstUser, summaryPrompt, script, evidence };
