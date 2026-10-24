// Suite K: REAL-endpoint end-to-end tests (no mocks).
// Requires env: REAL_TEST=1 plus OPENAI_API_KEY / OPENAI_ENDPOINT / REAL_MODEL
// (defaults to qwen3.7-plus on the qwen compatible-mode endpoint). Skips
// gracefully when REAL_TEST is unset, so CI stays offline.
//
// Usage:
//   REAL_TEST=1 OPENAI_API_KEY=... OPENAI_ENDPOINT=... REAL_MODEL=qwen3.7-plus node test/runner-k.js
const fs = require('fs');
const path = require('path');
const REAL = process.env.REAL_TEST === '1';
if (!REAL) { console.log('SUITE K SKIPPED: set REAL_TEST=1 to opt in to real endpoints.'); process.exit(0); }
const { create, parseSSE, workflowObserved } = require('./_endpoint');
const ENDPOINT = process.env.OPENAI_ENDPOINT || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.REAL_MODEL || 'qwen3.7-plus';
const H = create({ suite:'K (REAL)',endpoint:ENDPOINT,key:KEY,model:MODEL });
const { S } = H, { NODE_BIN, RUN_ONLY, record, freshCwd, spawnSync } = S;
const chat = (body, timeout) => H.request(body, timeout);
const assembleSSE = body => parseSSE(body).content;
let workspace = null;

const scenarios = [];

// K1: real multi-file coding task, verified on disk
scenarios.push({
  name: 'real-coding',
  fn: async () => {
    workspace = workspace || freshCwd('k1');
    const res = await chat({ stream: true, messages: [{ role: 'user', content:
      'Create stringutils.js exporting reverseWords(s) (words of s in reversed order, single-space separated), ' +
      'then create test.js that requires it, asserts reverseWords(\'a b c\') === \'c b a\', prints PASS, ' +
      'then run node test.js and report the result.' }] });
    const reply = assembleSSE(res.body);
    const impl = path.join(workspace, 'stringutils.js');
    const test = path.join(workspace, 'test.js');
    record('real: both files created on disk', fs.existsSync(impl) && fs.existsSync(test), 'reply=' + reply.substring(0, 120));
    if (fs.existsSync(test)) {
      const run = spawnSync(NODE_BIN, [test], { encoding: 'utf8', cwd: workspace, timeout: 30000 });
      record('real: independent re-run of the generated test passes', run.stdout.includes('PASS') && run.status === 0, 'out=' + (run.stdout + run.stderr).substring(0, 80));
    } else {
      record('real: independent re-run of the generated test passes', false, 'test.js missing');
    }
    record('real: reply mentions the verification', /PASS|pass/.test(reply), reply.substring(0, 100));
  }
});

// K2: Chinese round-trip through the full stack
scenarios.push({
  name: 'real-chinese',
  fn: async () => {
    const res = await chat({ stream: true, messages: [{ role: 'user', content:
      '创建文件 中文.txt，内容恰好为四个汉字：你好世界（不要句号，不要换行）。然后用一句话确认已创建。' }] });
    const reply = assembleSSE(res.body);
    const file = path.join(workspace, '中文.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    record('real-cn: CJK filename created with exact content', content === '你好世界', 'content=' + JSON.stringify(content));
    record('real-cn: reply is valid CJK (no replacement chars)', reply.length > 0 && !reply.includes('\uFFFD'), reply.substring(0, 80));
  }
});

// K3: real model drives workflow_tool end-to-end
scenarios.push({
  name: 'real-workflow',
  fn: async () => {
    const res = await chat({ stream: true, messages: [{ role: 'user', content:
      'You MUST call the workflow_tool now. Its steps argument is a JSON array of {tool,args,optional} objects. ' +
      'Use it to: step1 write_file to wf.txt with content WF-RAN; step2 read_file wf.txt. Then tell me the step results.' }] });
    const reply = assembleSSE(res.body);
    const file = path.join(workspace, 'wf.txt');
    record('real-wf: exact workflow call/results and file effects observed', workflowObserved(parseSSE(res.body)) && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'WF-RAN', 'file=' + fs.existsSync(file) + ' reply=' + reply.substring(0, 100));
  }
});

// K4: multi-turn memory over HTTP with the real model
scenarios.push({
  name: 'real-memory',
  fn: async () => {
    const hist = [{ role: 'user', content: 'Remember this codeword: ZEBRA-77. Reply with just: noted.' }];
    const r1 = await chat({ stream: true, messages: hist.slice() });
    const a1 = assembleSSE(r1.body);
    hist.push({ role: 'assistant', content: a1 });
    hist.push({ role: 'user', content: 'What codeword did I ask you to remember? Reply with just the codeword.' });
    const r2 = await chat({ stream: true, messages: hist });
    const a2 = assembleSSE(r2.body);
    record('real-memory: codeword recalled across turns', a2.includes('ZEBRA-77'), 'a1=' + a1.substring(0, 40) + ' a2=' + a2.substring(0, 60));
  }
});

// K5: real task with a deliberate error to fix (resilience loop)
scenarios.push({
  name: 'real-fix',
  fn: async () => {
    fs.writeFileSync(path.join(workspace, 'broken.js'), 'console.log("BROKEN-MARK"');  // syntax error: unclosed paren
    const res = await chat({ stream: true, messages: [{ role: 'user', content:
      'broken.js has a syntax error. Run node broken.js, read the error, fix the file, run it again, and report the final output which should contain FIXED-MARK-OK. ' +
      'First add a line console.log("FIXED-MARK-OK") inside the string so the program prints it, i.e. make it print FIXED-MARK-OK.' }] });
    const reply = assembleSSE(res.body);
    const run = spawnSync(NODE_BIN, [path.join(workspace, 'broken.js')], { encoding: 'utf8', cwd:workspace, timeout: 30000 });
    record('real-fix: repaired program produces requested output', run.status === 0 && run.stdout.trim() === 'FIXED-MARK-OK', 'exit=' + run.status + ' out=' + (run.stdout + run.stderr).substring(0, 80));
    record('real-fix: reply reports the fix', /FIXED-MARK|fix/i.test(reply), reply.substring(0, 100));
  }
});

(async () => {
  const t0 = Date.now();
  try {
    const selected=scenarios.filter(sc=>!RUN_ONLY.length||RUN_ONLY.includes(sc.name));
    if(selected.length){workspace=freshCwd('shared');await H.start(workspace);}
    for(const sc of selected){
      console.log('--- scenario: '+sc.name+' (REAL '+MODEL+')');
      try{await sc.fn();}catch(e){record(sc.name+' (scenario crashed)',false,e.message);}
    }
  }catch(e){record('real endpoint startup',false,e.message);}
  finally{try{await H.stop();}catch(e){record('real endpoint close',false,e.message);}}
  S.finish(t0);
})();
