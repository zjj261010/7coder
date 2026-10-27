// Actual prebuilt CLR helper + native three-generation children. No desktop
// input, real .env, model service, package registry, or unowned PID kills.
const assert=require('assert'), fs=require('fs'), path=require('path'), cp=require('child_process'), http=require('http');
const S=require('./_shared').create({suite:'process-owner'}), root=path.dirname(S.IDX);
const manager=require(path.join(root,'lib','process-owner')).create(cp,root);
const children=[], controls=[], ports=[]; let checks=0;
const scope=process.env.PROCESS_OWNER_SCOPE || 'all';
function check(label,ok,detail) { assert.ok(ok,label+(detail?' '+detail:'')); checks++; console.log('PASS '+label); }
function pause(ms) { return new Promise(r=>setTimeout(r,ms)); }
async function until(fn,label,ms=8000) { const end=Date.now()+ms; while(Date.now()<end) { const value=await fn(); if(value)return value; await pause(20); } throw Error(label); }
function launch(file,args,opts) {
  const child=manager.spawn(file,args,Object.assign({cwd:S.runDir,windowsHide:true},opts)); children.push(child);
  child.output=''; child.errors=''; child.on('error',e=>{child.failure=e;});
  for(const key of ['stdout','stderr']) if(child[key]) child[key].on('data',b=>{const name=key==='stdout'?'output':'errors';child[name]=(child[name]+b.toString()).slice(-65536);});
  child.done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal}))); return child;
}
function call(file,args,opts) { return new Promise((resolve,reject)=>{
  try { const child=manager.execFile(file,args,Object.assign({cwd:S.runDir,windowsHide:true,timeout:12000,maxBuffer:1024*1024},opts),(error,stdout,stderr)=>resolve({error,stdout,stderr,child})); children.push(child); child.on('error',()=>{}); }
  catch(e) { reject(e); }
}); }
function request(port,route='/') { return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,path:route,timeout:300},res=>{res.resume();res.once('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());}); }
async function stopped(info) {
  await until(async()=>!(await request(info.port)),'owned leaf port not released');
  const size=fs.statSync(info.heart).size; await pause(180); return fs.statSync(info.heart).size===size;
}
const fixture=path.join(S.runDir,'三层 tree fixture.js');
fs.writeFileSync(fixture,`
const fs=require('fs'),cp=require('child_process'),http=require('http');
const mode=process.argv[2],heart=process.argv[3],nonce=process.argv[4];
setTimeout(()=>process.exit(0),40000);
if(mode==='leaf') {
 const server=http.createServer((q,s)=>{s.end(nonce);if(q.url==='/stop/'+nonce)setTimeout(()=>process.exit(0),10);});
 setInterval(()=>fs.appendFileSync(heart,'x'),25);
 server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port,pid:process.pid,heart,nonce}));
} else {
 const child=cp.spawn(process.execPath,[__filename,mode==='root'?'middle':'leaf',heart,nonce],{detached:mode==='middle',stdio:['ignore','ignore','ignore','ipc']});
 child.on('message',info=>{if(mode==='root'){console.log(JSON.stringify(info));if(process.argv[5]==='natural')setTimeout(()=>process.exit(7),150);}else{process.send(info,()=>process.exit(0));}});
 child.on('error',()=>process.exit(9));
 setInterval(()=>{},1000);
}
`);
async function tree(mode) {
  const heart=path.join(S.runDir,'heart-'+Math.random()+'.txt'), nonce=require('crypto').randomBytes(12).toString('hex');fs.writeFileSync(heart,'');
  const child=launch(S.NODE_BIN,[fixture,'root',heart,nonce,mode || '']);
  const info=await until(()=>{const line=child.output.split(/\r?\n/).find(s=>s.startsWith('{'));if(line)return JSON.parse(line);if(child.exitCode!==null)throw Error('tree launch: '+child.errors);},'tree ready');
  ports.push(info);return {child,info};
}
const deadline=setTimeout(()=>{console.error('PROCESS/OWNER deadline');for(const c of children)try{c.kill();}catch(e){}S.cleanup();process.exit(1);},100000);
(async()=>{try{
  if(process.platform!=='win32')throw Error('process-owner native acceptance requires Windows');
  if(scope==='all'||scope==='basic'||scope==='basic-tail') {
    if(scope!=='basic-tail') {
    const probe=cp.spawnSync(path.join(root,'native','process-owner.exe'),['--probe'],{encoding:'utf8',windowsHide:true,timeout:10000});
    check('prebuilt AnyCPU CLR2 helper loads without compiler or shell',probe.status===0&&probe.stdout.includes('7coder-process-owner-v1 CLR='),probe.stderr);
    }
    const cwd=S.freshCwd('cwd 中文 空格'), script=path.join(cwd,'argv 中文.js');
    fs.writeFileSync(script,`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.OWNED_FIXTURE,input}));process.stderr.write('ERR中文');});`);
    const args=['','plain','中文😀','space value','a"b','trailing\\','quote\\"end','&|<>%!^'];
    const child=launch(S.NODE_BIN,[script].concat(args),{cwd,env:Object.assign({},process.env,{OWNED_FIXTURE:'值😀'})});
    child.stdin.end('INPUT中文😀');const done=await child.done;
    if(!child.output)throw Error('argv fixture empty output: '+JSON.stringify({done,stderr:child.errors,state:child.ownedTree}));
    const value=JSON.parse(child.output);
    check('argv quoting preserves empty/Unicode/metacharacters/quotes/backslashes',done.code===0&&JSON.stringify(value.args)===JSON.stringify(args),child.errors);
    check('stdio/cwd/environment preserve native child behavior',value.cwd===cwd&&value.env==='值😀'&&value.input==='INPUT中文😀'&&child.errors==='ERR中文');
    check('normal callback is acknowledged only after whole job empties',child.ownedTree.bound&&child.ownedTree.closed&&!child.ownedTree.error&&child.ownedTree.exitCode===0);
    const env=Object.assign({},process.env,{PATH:''});
    const absolute=await call(S.NODE_BIN,['-e','process.stdout.write("ABSOLUTE")'],{env});
    check('absolute bundled runtime works with empty PATH',!absolute.error&&absolute.stdout==='ABSOLUTE'&&absolute.child.ownedTree.closed,absolute.stderr);
    const command=await new Promise(resolve=>{const c=manager.exec('echo CMD-OWNED',{cwd,windowsHide:true,timeout:10000},(error,stdout,stderr)=>resolve({error,stdout,stderr,c}));children.push(c);});
    check('exec shell path retains command semantics and containment',!command.error&&command.stdout.includes('CMD-OWNED')&&command.c.ownedTree.closed,command.stderr);
    const batch=path.join(cwd,'shim 中文.cmd');fs.writeFileSync(batch,'@echo off\r\necho BATCH-OWNED\r\n');
    const shim=await call('"'+batch+'"',[],{shell:true});
    check('shell batch shim under Unicode/space directory is owned',!shim.error&&shim.stdout.includes('BATCH-OWNED')&&shim.child.ownedTree.closed,shim.stderr);
    let rejected=0;const before=manager.processOwnerInfo().active;
    for(const spec of [[S.NODE_BIN,['bad\0arg'],{}],[S.NODE_BIN,['x'.repeat(20000)],{}],[S.NODE_BIN,[],{detached:true}],[S.NODE_BIN,[],{stdio:['ignore','ignore','ignore','ipc']}],['definitely-missing-owned-executable',[],{}]]) {
      try{manager.spawn(spec[0],spec[1],spec[2]);}catch(e){rejected++;}
    }
    check('invalid/oversized/detached/IPC/missing launches refuse before native spawn',rejected===5&&manager.processOwnerInfo().active===before);
    const fake=path.join(cwd,'not-a-program.exe');fs.writeFileSync(fake,'not executable');const bad=await call(fake,[]);
    check('native creation failure is explicit and never reports bound/success',!!bad.error&&bad.stderr.includes('create-suspended')&&bad.stderr.includes('not resumed')&&!bad.child.ownedTree.bound);
    await until(()=>manager.processOwnerInfo().active===0,'idle counters');
    check('completed/failed native launches release all admission and control records',manager.processOwnerInfo().active===0&&manager.processOwnerInfo().pending===0);
  }
  if(scope==='all'||scope==='trees'||scope==='basic-tail') {
    let t=await tree();
    check('three-generation leaf remains alive after middle parent exits',await request(t.info.port));
    t.child.kill();const code=await t.child.done;
    check('handle-bound stop observes empty job and closes broker',t.child.ownedTree.closed&&t.child.ownedTree.stopped&&code.code!==0);
    check('stop removes reparented leaf listener and heartbeat',await stopped(t.info));
    t=await tree('natural');const natural=await t.child.done;
    check('natural root exit preserves exit code seven and empties descendants',natural.code===7&&t.child.ownedTree.closed&&t.child.ownedTree.exitCode===7);
    check('natural completion also removes ignored-stdio orphan leaf',await stopped(t.info));
    t=await tree();
    // Use raw handle kill to simulate an uncatchable broker failure. Do not
    // use a PID scan or call the adapter's cooperative STOP implementation.
    cp.ChildProcess.prototype.kill.call(t.child,'SIGKILL');await t.child.done;
    check('uncatchable broker death closes sole job handle and removes leaf',await stopped(t.info));
    check('unexpected broker death does not falsely claim accounting confirmation',!t.child.ownedTree.closed);
    const parent=path.join(S.runDir,'owned-parent.js'), infoFile=path.join(S.runDir,'parent-info.json'), heart=path.join(S.runDir,'parent-heart.txt');fs.writeFileSync(heart,'');
    fs.writeFileSync(parent,`const cp=require('child_process'),fs=require('fs');const owner=require(${JSON.stringify(path.join(root,'lib','process-owner'))}).create(cp,${JSON.stringify(root)});const c=owner.spawn(process.execPath,[${JSON.stringify(fixture)},'root',${JSON.stringify(heart)},'force-parent'],{stdio:['ignore','pipe','pipe'],windowsHide:true});let text='';c.stdout.on('data',s=>{text+=s;let line=text.split('\\n').find(v=>v.startsWith('{'));if(line)fs.writeFileSync(${JSON.stringify(infoFile)},line);});c.stderr.pipe(process.stderr);setInterval(()=>{},1000);`);
    const agent=S.spawn(S.NODE_BIN,[parent],{stdio:'ignore',windowsHide:true});controls.push(agent);
    const info=await until(()=>{try{return JSON.parse(fs.readFileSync(infoFile,'utf8'));}catch(e){}},'parent leaf ready');ports.push(info);
    const parentDone=new Promise(r=>agent.once('close',r));agent.kill('SIGKILL');await parentDone;
    check('forced owner exit removes native descendants without JS cleanup',await stopped(info));
    const fresh=await tree();fresh.child.kill();await fresh.child.done;
    check('subsequent fresh owner can launch/stop without stale lock or PID state',fresh.child.ownedTree.closed&&await stopped(fresh.info));
  }
  console.log('PROCESS/OWNER '+checks+'/'+checks+'; scope='+scope+'; SKIP 0; modern Windows, not Win7 acceptance');
} finally {
  clearTimeout(deadline);
  for(const child of children)if(child.exitCode==null&&child.signalCode==null)try{child.kill();}catch(e){}
  for(const child of controls)if(child.exitCode==null&&child.signalCode==null)try{child.kill();}catch(e){}
  for(const info of ports)await request(info.port,'/stop/'+info.nonce);
  await Promise.all(children.filter(c=>c.done&&c.exitCode==null&&c.signalCode==null).map(c=>Promise.race([c.done,pause(8000)])));
  S.cleanup();
}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
