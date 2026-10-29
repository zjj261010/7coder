'use strict';
const crypto = require('crypto');
// One source per Agent: no clock dependence, retained history or per-ID cache.
function createExecutionIdentitySource(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(12);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 12) throw Error('Execution identity requires 12 random bytes');
  const session = bytes.toString('hex'); let sequence = 0;
  return () => {
    if (sequence >= Number.MAX_SAFE_INTEGER) throw Error('Execution identity sequence exhausted');
    return 'exec-' + session + '-' + (++sequence).toString(36);
  };
}
function executionIdentity(value) {
  return typeof value === 'string' && value.length <= 41 && /^exec-[a-f0-9]{24}-[1-9a-z][0-9a-z]{0,10}$/.test(value) ? value : undefined;
}
const nextExecutionId = createExecutionIdentitySource();
module.exports = { createExecutionIdentitySource, executionIdentity, nextExecutionId };
