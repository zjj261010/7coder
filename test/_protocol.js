// Test oracle only: require every declared call to have exactly one result
// before the next non-tool message. Parallel results may arrive in any order.
function pairingError(messages) {
  if (!Array.isArray(messages) || !messages.length) return 'messages must be a nonempty array';
  const seen = new Set(), pending = new Set();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'invalid message';
    if (msg.role === 'tool') {
      if (typeof msg.tool_call_id !== 'string' || !pending.has(msg.tool_call_id)) return 'orphan, wrong or duplicate tool result';
      pending.delete(msg.tool_call_id);
      continue;
    }
    if (pending.size) return 'missing tool result before next message';
    if (msg.tool_calls !== undefined) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length) return 'invalid tool declaration';
      for (const call of msg.tool_calls) {
        if (!call || typeof call.id !== 'string' || !call.id || seen.has(call.id)) return 'missing or duplicate call ID';
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  return pending.size ? 'missing tool results at end' : null;
}
function requestError(body, expect) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid request object';
  const error = pairingError(body.messages);
  if (error) return error;
  if (!expect) return null;
  if (expect.model !== undefined && body.model !== expect.model) return 'unexpected model';
  if (expect.tools !== undefined && (Array.isArray(body.tools) && body.tools.length > 0) !== expect.tools) return 'unexpected tool availability';
  if (expect.lastUserIncludes !== undefined) {
    const users = body.messages.filter(m => m.role === 'user');
    if (!users.length || !String(users[users.length - 1].content).includes(expect.lastUserIncludes)) return 'unexpected last user';
  }
  const results = body.messages.filter(m => m.role === 'tool');
  if (expect.toolIds && JSON.stringify(results.map(m => m.tool_call_id)) !== JSON.stringify(expect.toolIds)) return 'unexpected tool result IDs';
  for (const id of Object.keys(expect.toolResults || {})) {
    const match = results.find(m => m.tool_call_id === id);
    if (!match || !String(match.content).includes(expect.toolResults[id])) return 'unexpected tool result content: ' + id;
  }
  return null;
}
function resultForCall(outputs, callId) {
  if (!Array.isArray(outputs) || typeof callId !== 'string' || !callId) return undefined;
  const matches = outputs.filter(row => row && row.callId === callId);
  return matches.length === 1 ? matches[0] : undefined;
}
function auditMatches(outputs, audits) {
  if (!Array.isArray(outputs) || !outputs.length || !Array.isArray(audits)) return false;
  const ids = new Set();
  return outputs.every(output => {
    if (!output || typeof output.callId !== 'string' || !output.callId || ids.has(output.callId) ||
        !['completed','error','blocked','declined','cancelled'].includes(output.status)) return false;
    ids.add(output.callId);
    const rows = audits.filter(row => row && row.callId === output.callId);
    return rows.length === 1 && rows[0].tool === output.name && rows[0].status === (output.status === 'completed' ? 'ok' : output.status);
  });
}
module.exports = { pairingError, pairingValid: messages => pairingError(messages) === null, requestError, resultForCall, auditMatches };
