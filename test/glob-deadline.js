const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const S = require('./_shared').create({ suite: 'glob-deadline' }), sockets = new Set();
let checks = 0, H, server;
const deadline = setTimeout(() => { console.error('GLOB/DEADLINE deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 20000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
(async () => {
  try {
    const cwd = S.freshCwd('中文 空格'), name = 'a'.repeat(80) + '!.txt'; fs.mkdirSync(path.join(cwd, 'src', 'deep'), { recursive: true });
    for (const file of [name, 'plain.txt', 'c++[1].txt', 'src/a.js', 'src/deep/b.js']) fs.writeFileSync(path.join(cwd, file), 'fixture');
    const script = path.join(S.runDir, 'glob-bounded.js');
    fs.writeFileSync(script, `const fs=require('fs'),path=require('path'),vm=require('vm'),{loadContext}=require(${JSON.stringify(path.join(__dirname, 'download-commit.js'))});
const source=fs.readFileSync(${JSON.stringify(S.IDX)},'utf8'),cwd=${JSON.stringify(cwd)},c=loadContext(source,cwd,null,{Buffer,SCAN_SKIP_DIRS:[]});
const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));vm.runInContext(cut('function globToRegex(','// P2-3: heavy directories')+'async function tool(name,args,cancelled=null){\\n'+cut("  if (name === 'glob_tool') {","  if (name === 'grep_tool') {")+'\\n}',c);
console.log('MATCHING_STARTED');(async()=>{const r={};const bad=await c.tool('glob_tool',{pattern:'*a'.repeat(24)+'*b'});r.bad=bad.status==='error'&&bad.text.includes('100ms matching budget exceeded')&&!bad.text.includes('No files matched');
const normalize=items=>Array.from(items,s=>s.split(path.sep).join('/')).sort();const options={skipHeavy:true,maxDepth:12,maxEntries:1000};
const glob=p=>normalize(c.recursiveReaddir('',p,options));r.next=glob('*.js').join(',')==='src/a.js,src/deep/b.js';r.star=glob('src/**/*.js').join(',')==='src/a.js,src/deep/b.js'&&glob('**/plain.txt').join(',')==='plain.txt';r.question=glob('src/?.js').join(',')==='src/a.js';r.windows=glob('src\\\\**\\\\*.js').join(',')==='src/a.js,src/deep/b.js';r.literal=glob('c++[1].txt').join(',')==='c++[1].txt';
let reads=0;const native=c.fs.opendirSync;c.fs.opendirSync=(...a)=>{reads++;return native(...a);};const expired=c.recursiveReaddir('','*',{maxEntries:1000,deadlineAt:Date.now()-1});r.expired=reads===0&&expired.length===1&&expired[0].includes('time budget exhausted');
let cancelled=false;try{c.recursiveReaddir('','*',{maxEntries:1000,cancelled:()=>true});}catch(e){cancelled=e.code==='EXECUTION_CANCELLED';}r.cancel=cancelled&&reads===0;
const over=await c.tool('glob_tool',{pattern:'*'.repeat(4097)});r.limit=over.status==='error'&&over.text.includes('4096 characters')&&reads===0;
let now=10000,stats=0;class Clock extends Date{static now(){return now;}}c.Date=Clock;const nativeStat=c.fs.statSync;c.fs.statSync=(...a)=>{stats++;const s=nativeStat(...a);now=16000;return s;};const partial=c.recursiveReaddir('','*',{maxEntries:1000});r.total=stats===1&&partial.length===1&&partial[0].includes('time budget exhausted');c.Date=Date;c.fs.statSync=nativeStat;c.fs.opendirSync=native;
r.internal=c.recursiveReaddir().length===5&&c.recursiveReaddir().every(s=>!s.startsWith('['));console.log('RESULT '+JSON.stringify(r));})().catch(e=>{console.error(e.stack);process.exitCode=1;});
`);
    const child = S.spawn(S.NODE_BIN, [script], { cwd }); let output = '', expired = false, matchTimer;
    const startupTimer = setTimeout(() => { expired = true; child.kill(); }, 5000);
    child.stdout.on('data', d => { output += d; if (output.includes('MATCHING_STARTED') && !matchTimer) { clearTimeout(startupTimer); matchTimer = setTimeout(() => { expired = true; child.kill(); }, 2000); } }); child.stderr.on('data', d => output += d);
    await new Promise(resolve => child.once('close', resolve)); clearTimeout(startupTimer); clearTimeout(matchTimer);
    assert.ok(child.exitCode === 0 && !expired, 'owned glob child: ' + output); const found = /^RESULT (.+)$/m.exec(output); assert.ok(found, output); const result = JSON.parse(found[1]);
    check('former exponential glob returns explicit error within supervisor deadline', result.bad);
    check('same child resumes plain basename matching across nested directories', result.next);
    check('globstar preserves arbitrary and zero-directory semantics', result.star);
    check('question wildcard remains inside one path segment', result.question);
    check('Windows pattern separators retain path-aware behavior', result.windows);
    check('glob regex metacharacters remain literal', result.literal);
    check('already expired scan performs zero directory open and reports incomplete', result.expired);
    check('cancelled scan performs zero directory open and throws cancellation', result.cancel);
    check('oversized glob pattern fails before directory open instead of substring fallback', result.limit);
    check('aggregate deadline is checked after IO and before matching', result.total);
    check('internal no-options traversal retains every owned file without markers', result.internal);
    server = http.createServer((req, res) => { let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
      const body = JSON.parse(raw), task = body.messages.filter(m => m.role === 'user').slice(-1)[0].content;
      const message = body.messages.some(m => m.role === 'tool') ? { content: 'GLOB_RECOVERED' } : { content: '', tool_calls: [{ index: 0, id: task, type: 'function', function: { name: 'glob_tool', arguments: JSON.stringify({ pattern: task === 'GLOB_BAD' ? '*a'.repeat(24) + '*b' : '**/*.js' }) } }] };
      res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n');
    }); }); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    H = require('./_endpoint').create({ suite: 'glob-deadline-agent', endpoint: 'http://127.0.0.1:' + server.address().port, key: 'fixture', model: 'fixture', permissionMode: 'bypass' }); await H.start(cwd);
    const start = Date.now(), response = await H.chat([{ role: 'user', content: 'GLOB_BAD' }], 5000), outcome = response.tools.find(t => t.type === 'result');
    check('actual Agent returns pathological glob error and final reply in bounded time', response.content === 'GLOB_RECOVERED' && Date.now() - start < 2000 && outcome.status === 'error' && outcome.result.includes('100ms matching budget exceeded'));
    check('actual audit marks glob matching failure with exact call identity', S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).some(r => r.type === 'tool' && r.callId === 'GLOB_BAD' && r.status === 'error'));
    const next = await H.chat([{ role: 'user', content: 'GLOB_NEXT' }], 5000), info = JSON.parse((await H.api('/api/info')).body);
    check('same Agent completes next normal glob with idle activity', next.content === 'GLOB_RECOVERED' && next.tools.some(t => t.type === 'result' && t.status === 'completed' && t.result.includes('a.js') && t.result.includes('b.js')) && info.runtime.activeTools === 0 && info.runtime.activeTasks === 0);
    console.log('GLOB/DEADLINE ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
