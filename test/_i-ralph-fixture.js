const { requestError } = require('./_protocol');
const model = 'i-ralph-main';
const cases = [
  { key: 'one', label: 'iterations=1 permits only initial round', env: { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '1' }, count: 1, loops: [1] },
  { key: 'two', label: 'iterations=2 stops after exactly one refinement', env: { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '2' }, count: 2, loops: [1, 2] },
  { key: 'fallback', label: 'iterations=0 falls back to three full rounds', env: { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '0', MAX_RETRIES: '3' }, count: 3, loops: [1, 2, 3] },
  { key: 'early', label: 'completion at round 2 stops before configured round 5', env: { ENABLE_RALPH_MODE: 'true', RALPH_ITERATIONS: '5' }, count: 2, loops: [1], fulfilled: 2 },
  { key: 'disabled', label: 'disabled loop performs one initial round', env: { ENABLE_RALPH_MODE: 'false', ENABLE_CLAUDE_LIKE_RALPH_WIGGUM_MODE: 'false', RALPH_ITERATIONS: '3' }, count: 1, loops: [] }
];
function create(variant) {
  const prompt = 'I8_RALPH_BUSINESS_' + variant.key;
  const refine = i => 'You are in Claude-Like Ralph Wiggum loop mode. This is iteration ' + i + '. Review and iterate. You may use any tools. If complete, start reply with exactly "RALPH_WIGGUM_COMPLETE" followed by final version.';
  const replies = Array.from({ length: variant.count }, (_, i) => (variant.fulfilled && i + 1 === variant.fulfilled ? 'RALPH_WIGGUM_COMPLETE ' : '') + 'I8_' + variant.key + '_REPLY_' + (i + 1));
  const expected = i => {
    const messages = [{ role: 'user', content: prompt }];
    for (let j = 0; j < i; j++) messages.push({ role: 'assistant', content: replies[j] }, { role: 'user', content: refine(j + 2) });
    return messages;
  };
  const script = replies.map((reply, i) => ({ expect: { model, tools: true, toolIds: [], lastUserIncludes: i ? refine(i + 1) : prompt }, reply }));
  function evidence(log) {
    return Array.isArray(log) && log.length === variant.count && log.every((request, i) => !requestError(request, script[i].expect) && request.stream === true &&
      request.messages[0].role === 'system' && typeof request.messages[0].content === 'string' && request.messages[0].content &&
      JSON.stringify(request.messages.slice(1)) === JSON.stringify(expected(i)));
  }
  function progress(output) {
    const iterations = [], fulfilled = [];
    let match, re = /\[LOOP\] Ralph Wiggum Loop - Iteration (\d+):/g;
    while ((match = re.exec(output))) iterations.push(Number(match[1]));
    re = /Completion promise fulfilled at iteration (\d+)!/g;
    while ((match = re.exec(output))) fulfilled.push(Number(match[1]));
    return JSON.stringify(iterations) === JSON.stringify(variant.loops) && JSON.stringify(fulfilled) === JSON.stringify(variant.fulfilled ? [variant.fulfilled] : []);
  }
  return { model, prompt, replies, script, expected, evidence, progress };
}
module.exports = { cases, create };
