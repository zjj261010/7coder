// Adversarial pages run only in owned children with an independent supervisor.
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const S = require('./_shared').create({ suite: 'html-deadline' }), sockets = new Set();
let checks = 0, server, H;
const deadline = setTimeout(() => { console.error('HTML/DEADLINE deadline'); if (H) H.S.cleanup(); S.cleanup(); process.exit(1); }, 20000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
(async () => {
  try {
    const cwd = S.freshCwd('probe'), script = path.join(S.runDir, 'html-bounded-probe.js');
    fs.writeFileSync(script, `const fs=require('fs'),vm=require('vm'),assert=require('assert');
const {loadContext}=require(${JSON.stringify(path.join(__dirname, 'download-commit.js'))});
const source=fs.readFileSync(${JSON.stringify(S.IDX)},'utf8');
const c=loadContext(source,${JSON.stringify(cwd)},null,{Buffer,console:{log(){},warn(){}},SEARCH_PROVIDER:'',SEARCH_ENDPOINT:'',SEARCH_API_KEY:''});
const cut=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
vm.runInContext('async function tool(name,args,cancelled=null,modelContext=null){\\n'+cut("  if (name === 'web_search_tool') {","  if (name === 'notebook_edit_tool') {")+ '\\n}',c);
let data='';c.executionHttp=async()=>({data});console.log('PARSING_STARTED');
(async()=>{const results={};
data='<a '.repeat(200000);let r=await c.tool('web_browser_tool',{url:'http://local.invalid/bad'});results.anchor=r.status==='error'&&r.text.includes('HTML parsing exceeded 200ms budget');
data='<script '.repeat(90000);r=await c.tool('web_browser_tool',{url:'http://local.invalid/bad'});results.script=r.status==='error'&&r.text.includes('HTML parsing exceeded 200ms budget');
data='<a '.repeat(200000);r=await c.tool('web_search_tool',{query:'local-only'});results.search=r.status==='error'&&r.text.includes('HTML parsing exceeded 200ms budget');
const token=c.createExecutionControl(25);try{c.htmlPreviewBounded(data,false,true,token);results.deadline=false;}catch(e){results.deadline=e.code==='EXECUTION_CANCELLED';}finally{token.dispose();}
data='<style>HIDDEN_STYLE</style><script>HIDDEN_SCRIPT</script><p>中文😀 body</p><A href="local://one">  One </A>';r=await c.tool('web_browser_tool',{url:'http://local.invalid/good'});results.next=r.status==='ok'&&r.text.includes('One -> local://one')&&r.text.includes('中文😀 body')&&!r.text.includes('HIDDEN_STYLE')&&!r.text.includes('HIDDEN_SCRIPT');
const long=c.htmlPreviewBounded('a'.repeat(4000));results.text=long.text.length===3000;
data=Array.from({length:30},(_,i)=>'<a href="local://'+i+'"> L'+i+' </a>').join('');let p=c.htmlPreviewBounded(data);let q=c.htmlPreviewBounded(data,true,false);results.links=p.links.length===20&&p.links[0]==='L0 -> local://0'&&q.links.length===10&&q.links[0]===' L0  -> local://0'&&q.text==='';
let created=0;c.vm=Object.assign({},vm,{createContext(...a){created++;return vm.createContext(...a);}});let e1=false,e2=false;try{c.htmlPreviewBounded('x'.repeat(2*1024*1024+1));}catch(e){e1=e.code==='EFILETOOLARGE';}const expired=()=>false;expired.deadlineAt=Date.now()-1;try{c.htmlPreviewBounded('',false,true,expired);}catch(e){e2=e.code==='EXECUTION_CANCELLED';}results.admission=e1&&e2&&created===0;
let calls=0;try{c.htmlPreviewBounded('<p>normal</p>',false,true,()=>++calls>1);results.cancel=false;}catch(e){results.cancel=e.code==='EXECUTION_CANCELLED';}
console.log('RESULT '+JSON.stringify(results));})().catch(e=>{console.error(e.stack);process.exitCode=1;});
`);
    const child = S.spawn(S.NODE_BIN, [script], { cwd }); let output = '', expired = false, parseTimer;
    const startupTimer = setTimeout(() => { expired = true; child.kill(); }, 5000);
    child.stdout.on('data', d => { output += d; if (output.includes('PARSING_STARTED') && !parseTimer) { clearTimeout(startupTimer); parseTimer = setTimeout(() => { expired = true; child.kill(); }, 2000); } }); child.stderr.on('data', d => output += d);
    await new Promise(resolve => child.once('close', resolve)); clearTimeout(startupTimer); clearTimeout(parseTimer);
    assert.ok(child.exitCode === 0 && !expired, 'owned HTML child: ' + output);
    const found = /^RESULT (.+)$/m.exec(output); assert.ok(found, output); const results = JSON.parse(found[1]);
    check('malformed anchor page times out rather than wedging the owned child', results.anchor);
    check('malformed script stripping shares the same CPU budget', results.script);
    check('DuckDuckGo HTML path also has bounded parsing', results.search);
    check('earlier inherited caller deadline produces cancellation and disposes control', results.deadline);
    check('same child parses next normal page and removes script/style bodies', results.next);
    check('content preview still uses its 3000-character boundary', results.text);
    check('browser/search preserve twenty/ten links and title trimming semantics', results.links);
    check('oversized or already-expired page starts no parsing context', results.admission);
    check('late cancellation cannot return a successful preview', results.cancel);
    server = http.createServer((req, res) => {
      if (req.method === 'GET') { res.end(req.url === '/bad' ? '<a '.repeat(200000) : '<p>PAGE_NEXT中文😀</p><a href="local://safe">Safe</a>'); return; }
      let raw = ''; req.setEncoding('utf8'); req.on('data', d => raw += d); req.on('end', () => {
        const body = JSON.parse(raw), task = body.messages.filter(m => m.role === 'user').slice(-1)[0].content;
        const message = body.messages.some(m => m.role === 'tool') ? { content: 'HTML_RECOVERED' } : { content: '', tool_calls: [{ id: task, type: 'function', function: { name: 'web_browser_tool', arguments: JSON.stringify({ url: base + (task === 'PAGE_BAD' ? '/bad' : '/good') }) } }] };
        res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n');
      });
    }); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
    H = require('./_endpoint').create({ suite: 'html-deadline-agent', endpoint: base + '/model', key: 'fixture', model: 'fixture', permissionMode: 'bypass' }); await H.start(cwd);
    const start = Date.now(), response = await H.chat([{ role: 'user', content: 'PAGE_BAD' }], 5000), result = response.tools.find(t => t.type === 'result');
    check('actual Agent completes malformed-page request within supervisor deadline', response.content === 'HTML_RECOVERED' && Date.now() - start < 2000 && result.status === 'error' && result.result.includes('HTML parsing exceeded 200ms budget'));
    check('actual audit records parser timeout as error with exact call identity', S.readLog(path.join(cwd, '.7coder', 'audit.jsonl')).some(row => row.type === 'tool' && row.callId === 'PAGE_BAD' && row.tool === 'web_browser_tool' && row.status === 'error' && row.result.includes('HTML parsing exceeded')));
    const next = await H.chat([{ role: 'user', content: 'PAGE_NEXT' }], 5000), info = JSON.parse((await H.api('/api/info')).body);
    check('same Agent completes next normal page and restores idle activity', next.content === 'HTML_RECOVERED' && next.tools.some(t => t.type === 'result' && t.status === 'completed' && t.result.includes('PAGE_NEXT中文😀')) && info.runtime.activeTools === 0 && info.runtime.activeTasks === 0);
    console.log('HTML/DEADLINE ' + checks + '/' + checks + ' passed; SKIP 0');
  } finally { clearTimeout(deadline); if (H) { await H.stop(); H.S.cleanup(); } S.cleanup(); for (const socket of sockets) socket.destroy(); if (server) await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
