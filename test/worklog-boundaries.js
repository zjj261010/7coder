'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { loadContext } = require('./download-commit'), F = require('./_i-worklog-fixture');
const S = require('./_shared').create({ suite: 'worklog-boundaries' }), source = fs.readFileSync(S.IDX, 'utf8');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
function cut(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start); return source.slice(start, end); }
const code = cut('const LOG_START =', '// ====================== CORE EXECUTION');
const pure = vm.createContext({}); vm.runInContext(code, pure);
const compose = pure.composeCompleteSummary, START = '<!-- 7coder:auto-log:start -->', END = '<!-- 7coder:auto-log:end -->';
function context(name, overrides) {
  const cwd = S.freshCwd(name), warnings = [], c = loadContext(source, cwd, overrides, { console: { log() {}, warn(...args) { warnings.push(args.join(' ')); }, error(...args) { warnings.push(args.map(value => value && value.message || String(value)).join(' ')); } } });
  vm.runInContext(code, c); return { cwd, c, warnings, file: path.join(cwd, '7CODER.md') };
}
try {
  check('empty worklog retains existing LF layout contract', compose('', 'first') === START + '\n- first\n' + END + '\n');
  const first = compose(F.notes, F.summaries[0]);
  check('first insertion preserves BOM, first-line indentation and every outside byte', first === F.document(0));
  const second = compose(first, F.summaries[1]);
  check('next update preserves complete multiline summary and exact original notes', second === F.document(1));
  check('BOM stays at byte-start exactly once', second.charCodeAt(0) === 0xFEFF && second.split('\uFEFF').length === 2);
  const prefix = '    user prefix  \r\n', suffix = '\r\n  user suffix\t\n\n ';
  const middle = prefix + START + '\r\n- old\r\n' + END + suffix;
  check('existing section is updated in place without reordering or trimming either side', compose(middle, 'new') === prefix + START + '\r\n- old\r\n- new\r\n' + END + suffix);
  check('identical multiline summary is a byte-exact no-op', compose(second, F.summaries[1]) === second);
  const nested = compose('', 'first\n\n- nested\n  code');
  check('nested bullet and blank/code lines remain one stored summary', nested === START + '\n- first\n  \n  - nested\n    code\n' + END + '\n');
  check('nested summary dedup survives encode/decode round trip', compose(nested, 'first\n\n- nested\n  code') === nested);
  const legacy = START + '\n- legacy first\nunindented continuation\n' + END + '\n';
  check('legacy unindented continuation survives next write instead of disappearing', compose(legacy, 'next').includes('- legacy first\n  unindented continuation\n- next'));
  let retained = '';
  for (let i = 0; i < 61; i++) retained = compose(retained, 'entry-' + i + '\ncontinuation-' + i);
  check('retention counts newest 60 complete entries rather than continuation lines', !retained.includes('- entry-0\n') && retained.includes('- entry-1\n  continuation-1') && retained.includes('- entry-60\n  continuation-60') && (retained.match(/^- /gm) || []).length === 60);
  for (const [label, text] of [
    ['missing end', START + '\n- note'], ['missing start', 'note\n' + END], ['reversed', END + START],
    ['duplicate start', START + START + END], ['duplicate end', START + END + END], ['unknown leading content', START + '\nUNKNOWN\n- note\n' + END]
  ]) { assert.throws(() => compose(text, 'new')); check(label + ' refuses ambiguous rewrite', true); }
  for (const marker of [START, END]) { assert.throws(() => compose(F.notes, 'summary ' + marker)); check('summary cannot insert reserved marker ' + marker.slice(-8), true); }
  check('blank summary performs no rewrite', compose(F.notes, '\r\n ') === F.notes);

  let f = context('real notes'); fs.writeFileSync(f.file, F.notes); f.c.updateCompleteSummary(F.summaries[0]);
  check('real writer preserves complete original bytes in prior version', fs.readFileSync(f.file + '.7coder-prev').equals(Buffer.from(F.notes)) && fs.readFileSync(f.file).equals(Buffer.from(F.document(0))));
  f.c.updateCompleteSummary(F.summaries[1]);
  check('real second write retains multiline entry and prior complete version', fs.readFileSync(f.file).equals(Buffer.from(F.document(1))) && fs.readFileSync(f.file + '.7coder-prev').equals(Buffer.from(F.document(0))));
  const previous = fs.readFileSync(f.file + '.7coder-prev'); f.c.updateCompleteSummary(F.summaries[1]);
  check('real dedup leaves both primary and previous version unchanged', fs.readFileSync(f.file).equals(Buffer.from(F.document(1))) && fs.readFileSync(f.file + '.7coder-prev').equals(previous));
  f = context('ambiguous notes'); const malformed = '\uFEFF  KEEP\n' + START + '\n- retained'; fs.writeFileSync(f.file, malformed); f.c.updateCompleteSummary('new');
  check('ambiguous existing log is preserved and reports actionable warning', fs.readFileSync(f.file).equals(Buffer.from(malformed)) && !fs.existsSync(f.file + '.7coder-prev') && f.warnings.some(value => value.includes('repair the retained file')));
  f = context('reserved summary'); fs.writeFileSync(f.file, F.notes); f.c.updateCompleteSummary('bad ' + END);
  check('reserved summary rejection preserves original primary and creates no backup', fs.readFileSync(f.file).equals(Buffer.from(F.notes)) && !fs.existsSync(f.file + '.7coder-prev') && f.warnings.some(value => value.includes('reserved worklog markers')));

  let reads = 0, target;
  f = context('changed before save', { openSync(file, flags, mode) { if (file === target && flags === 'r' && ++reads === 2) fs.writeFileSync(file, 'EXTERNAL_UPDATE'); return fs.openSync(file, flags, mode); } }); target = f.file;
  fs.writeFileSync(f.file, F.notes); f.c.updateCompleteSummary('new');
  check('writer refuses stale snapshot when notes change between read and commit', fs.readFileSync(f.file, 'utf8') === 'EXTERNAL_UPDATE' && !fs.existsSync(f.file + '.7coder-prev') && f.warnings.some(value => value.includes('State changed before commit')));

  const log = [
    { model: F.main, stream: true, tools: [{}], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: F.firstUser }] },
    { model: F.summary, messages: [{ role: 'user', content: F.summaryPrompt(0) }] },
    { model: F.main, stream: true, tools: [{}], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: F.firstUser }, { role: 'assistant', content: F.replies[0] }, { role: 'user', content: F.tasks[1] }] },
    { model: F.summary, messages: [{ role: 'user', content: F.summaryPrompt(1) }] }
  ];
  check('complete REPL worklog fixture transcript is accepted', F.evidence(log));
  const missing = JSON.parse(JSON.stringify(log)); missing.splice(1, 1);
  check('missing summary step cannot pass worklog history proof', !F.evidence(missing));
  const wrong = JSON.parse(JSON.stringify(log)); wrong[2].messages[2].content = 'different previous response';
  check('main history drifting across tasks is detected', !F.evidence(wrong));
  const truncated = JSON.parse(JSON.stringify(log)); truncated[3].messages[0].content = truncated[3].messages[0].content.slice(0, -20);
  check('truncated action summary input is detected', !F.evidence(truncated));
  assert.strictEqual(checks, 29); console.log('WORKLOG/BOUNDARIES 29/29');
} finally { S.cleanup(); }
