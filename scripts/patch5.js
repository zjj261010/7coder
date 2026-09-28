const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/test/runner-b.js';
let s = fs.readFileSync(p, 'utf8');
// remove the misplaced block (inside runCli)
const start = s.indexOf('// --- B9: LMStudio-style in-stream context-overflow error surfaces ---');
const endMarker = "});\n\n\n";
if (start >= 0) {
  const end = s.indexOf(endMarker, start);
  if (end < 0) { console.error('end not found'); process.exit(1); }
  s = s.slice(0, start) + s.slice(end + endMarker.length);
  console.log('misplaced block removed');
}
// insert before the LAST (async () => { which is the runner entry
if (!s.includes("name: 'lmstudio-ctx'")) {
  const anchor = s.lastIndexOf('(async () => {');
  const scenariosDecl = s.indexOf('const scenarios = [];');
  if (anchor < 0 || scenariosDecl < 0 || anchor < scenariosDecl) { console.error('bad anchor positions'); process.exit(1); }
  const sc = [
    "// --- B9: LMStudio-style in-stream context-overflow error surfaces ---",
    "scenarios.push({",
    "  name: 'lmstudio-ctx',",
    "  fn: async () => {",
    "    const cwd = freshCwd('b-lmstudio');",
    "    const m = startChaos('lmstudio-ctx');",
    "    await new Promise(r => setTimeout(r, 600));",
    "    const r = await runCli({ port: m.port, args: ['--prompt', 't'], env: { MAX_RETRIES: '3', PERMISSION_MODE: 'bypass' }, cwd });",
    "    const surfaced = r.out.includes('upstream error:') && r.out.includes('context length');",
    "    const attempts = (r.out.match(/API attempt/g) || []).length;",
    "    record('lmstudio: context-overflow error surfaced (no more empty-response)', surfaced, r.out.substring(r.out.length - 200));",
    "    record('lmstudio: upstream error not retried', surfaced && attempts === 1, 'attempts=' + attempts);",
    "    stopMock(m);",
    "  }",
    "});",
    "",
    ""
  ].join('\n');
  s = s.slice(0, anchor) + sc + s.slice(anchor);
  console.log('re-inserted at runner entry');
}
fs.writeFileSync(p, s);
console.log('final check: ' + (s.includes("name: 'lmstudio-ctx'") && s.lastIndexOf("name: 'lmstudio-ctx'") > s.indexOf('const scenarios = [];')));
