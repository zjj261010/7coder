'use strict';
const assert = require('assert'), F = require('./_g-binary-fixture'); let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const clone = value => JSON.parse(JSON.stringify(value));
function evidence(count) {
  const storeId = 'ab'.repeat(16), records = Array.from({ length: count }, (_, i) => {
    const payload = Buffer.from(i ? F.first : F.original), snapshotId = (i ? 'cd' : 'ef').repeat(16);
    return { directory: String(i + 1).padStart(16, '0') + '-' + snapshotId, payload, manifest: { kind: '7coder-backup-manifest-v1', version: 1, storeId, snapshotId, sequence: i + 1,
      sourceRel: F.file, sourceKey: process.platform === 'win32' ? F.file.toLowerCase() : F.file, createdAt: '2026-10-30T00:00:00.000Z', bytes: payload.length, sha256: F.digest(payload) } };
  });
  return { store: count ? { kind: '7coder-backup-store-v1', version: 1, storeId, lastSequence: count } : null, records, residue: [] };
}
const E = evidence(2), paths = E.records.map(row => row.directory), spec = F.create('http://127.0.0.1:12345');
check('no record first snapshot and two distinct valid generations accepted', F.evidenceValid(evidence(0), 0) && F.evidenceValid(evidence(1), 1) && F.evidenceValid(E, 2));
function rejectsEvidence(label, mutate) { const e = evidence(2); mutate(e); check(label, !F.evidenceValid(e, 2)); }
rejectsEvidence('snapshot stores previous bytes rather than downloaded current version', e => e.records[0].payload = Buffer.from(F.first));
rejectsEvidence('tail corruption past 64KiB cannot pass prefix comparison', e => e.records[1].payload[e.records[1].payload.length - 1] ^= 255);
rejectsEvidence('manifest digest mismatch is rejected', e => e.records[1].manifest.sha256 = F.digest(F.second));
rejectsEvidence('manifest size mismatch is rejected', e => e.records[1].manifest.bytes--);
rejectsEvidence('foreign store identity is rejected', e => e.records[1].manifest.storeId = '01'.repeat(16));
rejectsEvidence('wrong source path is rejected', e => e.records[1].manifest.sourceRel = 'other.bin');
rejectsEvidence('directory and sequence drift are rejected', e => e.records[1].manifest.sequence = 1);
rejectsEvidence('reused snapshot ID is rejected', e => e.records[1].manifest.snapshotId = e.records[0].manifest.snapshotId);
rejectsEvidence('wrong sequence counter and retained restore temp cannot pass', e => { e.store.lastSequence = 3; e.residue.push('.7coder-restore-left'); });
check('missing extra and null records cannot pass', !F.evidenceValid({ ...E, records: E.records.slice(1) }, 2) && !F.evidenceValid({ ...E, records: E.records.concat(E.records[0]) }, 2) && !F.evidenceValid({ ...E, records: [null, E.records[1]] }, 2));
const schema = ['write_file', 'download_tool', 'read_file'].map(name => ({ type: 'function', function: { name } }));
const log = Array.from({ length: 7 }, (_, step) => clone({ model: F.model, stream: true, tools: schema, messages: [{ role: 'system', content: 'STABLE_SYSTEM' }].concat(spec.tail(step, paths)) }));
check('complete seven requests retain actual refusal downloads and binary readback', spec.transcript(log, paths));
check('missing empty extra or unbound record identities cannot pass', !spec.transcript([], paths) && !spec.transcript(log.slice(1), paths) && !spec.transcript(log.concat(log[6]), paths) && !spec.transcript(log, []));
function rejects(label, mutate) { const rows = clone(log); mutate(rows); check(label, !spec.transcript(rows, paths)); }
rejects('wrong model cannot pass same call count', rows => rows[0].model = 'light');
rejects('wrong transport or schema cannot pass', rows => { delete rows[0].stream; rows[0].tools.pop(); });
rejects('binary text write cannot masquerade as successful overwrite', rows => rows[1].messages[3].content = 'Written: ' + F.file);
rejects('changed actual download destination cannot pass', rows => rows[2].messages[4].tool_calls[0].function.arguments = JSON.stringify({ ...spec.args[1], path: 'other.bin' }));
rejects('download result must identify actual previous snapshot path', rows => rows[2].messages[5].content = spec.result(1, paths).replace(paths[0], paths[1]));
rejects('second download must report its complete byte count', rows => rows[4].messages[9].content = spec.result(2, paths).replace('8193 bytes', '4096 bytes'));
rejects('binary readback must retain actual structured refusal text', rows => rows[6].messages[13].content = 'some binary');
rejects('recovery cannot lose earlier download history', rows => rows[5].messages.splice(4, 2));
rejects('readback task cannot replay first user prompt', rows => rows[5].messages[11].content = F.prompts[0]);
rejects('system context cannot drift after undo', rows => rows[5].messages[0].content += 'drift');
function stageRows() { return [1, 2, 4].map((step, i) => ({ step, requestCount: [2, 3, 5][i], toolCount: i + 1, taskCount: i === 2 ? 1 : 0, payloadCount: i, bytes: Buffer.from([F.original, F.first, F.second][i]), evidence: evidence(i) })); }
check('real refusal then two completed downloads have distinct live bytes and snapshots', F.stagesValid(stageRows()));
const unchanged = stageRows(); unchanged[1].bytes = Buffer.from(F.original);
check('old false-positive path with no actual overwrite is rejected', !F.stagesValid(unchanged));
const skipped = stageRows(); skipped[1].bytes = Buffer.from(F.second);
check('skipping first generation cannot pass final-file comparison', !F.stagesValid(skipped));
const premature = stageRows(); premature[0].evidence = evidence(1);
check('refused text write cannot create a snapshot', !F.stagesValid(premature));
function undoRows() { return [1, 2].map(restoreCount => ({ restoreCount, requestCount: 5, toolCount: 3, taskCount: 2, payloadCount: 2, bytes: Buffer.from(F.first), evidence: evidence(2) })); }
check('two actual undo commands restore newest previous binary generation idempotently', F.undosValid(undoRows(), E));
for (const [label, wrong] of [['original generation', F.original], ['unchanged downloaded file', F.second]]) { const rows = undoRows(); rows[0].bytes = Buffer.from(wrong); check('undo cannot pass with ' + label, !F.undosValid(rows, E)); }
const extraWork = undoRows(); extraWork[1].requestCount++;
check('undo cannot secretly request new model work', !F.undosValid(extraWork, E));
const rewritten = evidence(2); rewritten.records[1].manifest.createdAt = '2026-10-30T01:00:00.000Z';
check('restore must preserve actual snapshot metadata and bytes', F.sameEvidence(E, evidence(2)) && !F.sameEvidence(E, rewritten));
const ids = [1, 2, 3].map(n => 'exec-' + 'cd'.repeat(12) + '-' + n);
const runtime = [{ scope: 'tool', status: 'error', id: 'write_file', callId: spec.calls[0].id, executionId: ids[0], message: F.writeError }].concat(ids.map(executionId => ({ scope: 'cli-task', status: 'ok', executionId })));
const audits = spec.calls.map((call, i) => { const args = {}; for (const key of Object.keys(spec.args[i])) args[key] = JSON.stringify(spec.args[i][key]); return { type: 'tool', callId: call.id, executionId: ids[i <= 1 ? 0 : i - 1], tool: spec.names[i], mode: 'bypass', status: i ? 'ok' : 'error', args, result: spec.result(i, paths).split('\n')[0].substring(0, 160) }; });
check('four actual tools join three successful independent tasks and expected binary-write error', spec.audit(audits, runtime, paths));
check('missing duplicate false-success and wrong-task audit cannot pass', !spec.audit(audits.slice(1), runtime, paths) && !spec.audit(audits.concat(audits[0]), runtime, paths) && !spec.audit(audits.map((row, i) => i ? row : { ...row, status: 'ok' }), runtime, paths) && !spec.audit(audits.map((row, i) => i === 2 ? { ...row, executionId: ids[0] } : row), runtime, paths));
check('missing wrong or duplicated expected diagnostic cannot pass', !spec.audit(audits, runtime.slice(1), paths) && !spec.audit(audits, runtime.concat(runtime[0]), paths) && !spec.audit(audits, runtime.map((row, i) => i ? row : { ...row, message: 'wrong' }), paths));
const output = F.replies.join('\n') + '\n' + F.restored + '\n' + F.restored + '\nGoodbye!';
check('exact replies two real restore reports and normal exit zero are required', F.output(output, 0) && !F.output(output, 1) && !F.output(output.replace(F.restored, ''), 0) && !F.output(output + F.replies[0], 0) && !F.output(output + 'No backup found', 0));
console.log('G/BINARY/ORACLES ' + checks + '/' + checks);
