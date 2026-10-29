'use strict';
const { requestError } = require('./_protocol'), { executionIdentity } = require('../lib/execution-identity');
const model = 'f-schema-main', prompts = ['F6_JSON_TASK', 'F6_STREAM_TASK'], replies = ['F6_JSON_EXACT中文😀\nJSON_TAIL', 'F6_STREAM_EXACT中文😀\nSTREAM_TAIL'];
const script = prompts.map((prompt, i) => ({ expect: { model, tools: true, toolIds: [], lastUserIncludes: prompt }, reply: replies[i] }));
function transcript(log) {
  return Array.isArray(log) && log.length === 2 && log.every((body, i) => !requestError(body, script[i].expect) && body.stream === (i ? true : undefined) &&
    body.messages.length === 2 && body.messages[0].role === 'system' && typeof body.messages[0].content === 'string' && body.messages[0].content &&
    body.messages[1].role === 'user' && body.messages[1].content === prompts[i]);
}
function envelope(value, object) {
  return !!(value && !value.error && value.object === object && Number.isInteger(value.created) && value.created > 0 &&
    typeof value.id === 'string' && value.id.startsWith('chatcmpl-') && executionIdentity(value.id.slice(9)) && value.model === model &&
    Array.isArray(value.choices) && value.choices.length === 1 && value.choices[0] && value.choices[0].index === 0);
}
function plain(value) { return envelope(value, 'chat.completion') && value.choices[0].finish_reason === 'stop' && value.choices[0].message && value.choices[0].message.role === 'assistant' && value.choices[0].message.content === replies[0] && !value.choices[0].message.tool_calls; }
function stream(raw) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) return null;
    const lines = raw.split(/\r?\n/).filter(line => line !== '' && !line.startsWith(':'));
    if (lines.length < 3 || lines.some(line => !line.startsWith('data:'))) return null;
    const data = lines.map(line => line.slice(5).trim());
    if (data[data.length - 1] !== '[DONE]' || data.filter(text => text === '[DONE]').length !== 1) return null;
    const chunks = data.slice(0, -1).map(text => JSON.parse(text));
    let content = '';
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i], last = i === chunks.length - 1;
      if (!envelope(chunk, 'chat.completion.chunk') || chunk.id !== chunks[0].id || chunk.created !== chunks[0].created) return null;
      const choice = chunk.choices[0], delta = choice.delta;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta) || choice.finish_reason !== (last ? 'stop' : null)) return null;
      if (Object.keys(delta).some(key => key !== 'content' && key !== 'role') || delta.role !== undefined && delta.role !== 'assistant') return null;
      if (last && Object.keys(delta).length) return null;
      if (delta.content !== undefined) { if (typeof delta.content !== 'string') return null; content += delta.content; }
    }
    return content === replies[1] ? { id: chunks[0].id, content, chunks } : null;
  } catch (error) { return null; }
}
module.exports = { model, prompts, replies, script, transcript, plain, stream };
