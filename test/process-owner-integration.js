const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http'),vm=require('vm');
const {create}=require('./_endpoint');
let H,model,checks=0;const sockets=new Set(),leaves=[],nativeChildren=[],trace=[];
const scope=process.env.PROCESS_OWNER_INTEGRATION_SCOPE||'all';
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
function pause(ms){return new Promise(r=>setTimeout(r,ms));}
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(20);}throw Error(label);}
function ping(port,route='/'){return new Promise(resolve=>{const q=http.get({host:'127.0.0.1',port,path:route,timeout:300},s=>{s.resume();s.on('end',()=>resolve(true));});q.on('error',()=>resolve(false));q.on('timeout',()=>q.destroy());});}
async function empty(info){await until(async()=>!(await ping(info.port)),'leaf listener retained');const size=fs.statSync(info.heart).size;await pause(150);return size===fs.statSync(info.heart).size;}
async function info(file){return until(()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){}},'tree info not published');}
function cut(source,a,b){const at=source.indexOf(a),end=source.indexOf(b,at);assert.ok(at>=0&&end>at,a);return source.slice(at,end);}
const timeout=setTimeout(()=>{console.error('PROCESS/INTEGRATION deadline');if(H){H.stop().catch(()=>{});H.S.cleanup();}process.exit(1);},90000);
(async()=>{try{
  if(!['all','http','http-tail','internal'].includes(scope))throw Error('Unknown process-owner integration test scope: '+scope);
  if(process.platform!=='win32')throw Error('native integration requires Windows');
  let taskId,cronId,command,jobCommand;
  model=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    const body=JSON.parse(b),messages=body.messages||[],last=messages[messages.length-1]||{};
    const user=messages.filter(v=>v.role==='user').slice(-1)[0];const prompt=String(user&&user.content||'').split(/\r?\n/)[0];
    trace.push({prompt:String(prompt).slice(0,300),lastRole:last.role,tools:!!body.tools});if(trace.length>12)trace.shift();
    let tool=null,args={},content='fixture-summary';
    if(last.role==='tool')content=String(last.content);
    else if(prompt==='command'){tool='run_command';args={command:'echo OWNED_AGENT_COMMAND'};}
    else if(prompt==='powershell'){tool='powershell_tool';args={command:"[Console]::WriteLine('OWNED_PS中文')"};}
    else if(prompt==='task-create'){tool='task_create_tool';args={command};}
    else if(prompt==='task-stop'){tool='task_stop_tool';args={task_id:taskId};}
    else if(prompt==='cron-create'){tool='cron_create_tool';args={schedule:'1s',command:jobCommand};}
    else if(prompt==='cron-delete'){tool='cron_delete_tool';args={job_id:cronId};}
    else if(prompt==='mcp'){tool='mcp_tool';args={server:'owned',tool_name:'echo',args:{text:'MCP_OWNED_中文'}};}
    const message=tool?{role:'assistant',content:null,tool_calls:[{id:'owned-'+prompt,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:'assistant',content};
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:message}]})+'\n\ndata: [DONE]\n\n');}
    else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}]}));}
  });});model.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
  H=create({suite:'process-owner-integration',endpoint:'http://127.0.0.1:'+model.address().port,key:'',model:'fixture',permissionMode:'bypass'});
  const S=H.S,cwd=S.freshCwd('native routes 中文'),fixture=path.join(cwd,'tree.js');
  fs.writeFileSync(fixture,`
const cp=require('child_process'),fs=require('fs'),http=require('http');const mode=process.argv[2],file=process.argv[3],heart=file+'.heart';setTimeout(()=>process.exit(0),45000);
if(mode==='leaf'){setInterval(()=>fs.appendFileSync(heart,'x'),25);const s=http.createServer((q,r)=>{r.end('fixture');if(q.url==='/stop')setTimeout(()=>process.exit(0),10);});s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port,heart}));}
else if(mode==='middle'){const c=cp.spawn(process.execPath,[__filename,'leaf',file],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',j=>process.send(j,()=>process.exit(0)));}
else{fs.writeFileSync(heart,'');const c=cp.spawn(process.execPath,[__filename,'middle',file],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',j=>fs.writeFileSync(file,JSON.stringify(j)));if(mode==='mcp'){let b='';process.stdin.on('data',s=>{b+=s;let p;while((p=b.indexOf('\\n'))>=0){const q=JSON.parse(b.slice(0,p));b=b.slice(p+1);if(q.id==null)continue;let result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:q.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});}setInterval(()=>{},1000);}
`);
  const taskFile=path.join(cwd,'task-info.json'),cronFile=path.join(cwd,'cron-info.json'),mcpFile=path.join(cwd,'mcp-info.json');
  command='"'+S.NODE_BIN+'" "'+fixture+'" root "'+taskFile+'"';jobCommand='"'+S.NODE_BIN+'" "'+fixture+'" root "'+cronFile+'"';
  fs.mkdirSync(path.join(cwd,'.7coder'));fs.writeFileSync(path.join(cwd,'.7coder','mcp.json'),JSON.stringify({servers:{owned:{command:S.NODE_BIN,args:[fixture,'mcp',mcpFile]}}}));
  async function chat(prompt){return H.chat([{role:'user',content:prompt}],20000);}
  if(scope==='all'||scope==='http'||scope==='http-tail'){
    await H.start(cwd);let r;
    if(scope!=='http-tail') { r=await chat('command');
    check('actual Agent command route uses helper and preserves completed output',r.content.includes('OWNED_AGENT_COMMAND')&&r.tools.some(v=>v.type==='result'&&v.name==='run_command'&&v.status==='completed'));
    r=await chat('powershell');check('actual Agent PowerShell encoding survives owned launch',r.content.includes('OWNED_PS中文')&&r.tools.some(v=>v.type==='result'&&v.name==='powershell_tool'&&v.status==='completed'));
    }
    r=await chat('task-create');taskId=(r.content.match(/task-\d+-\d+/)||[])[0];assert.ok(taskId,r.content);const taskInfo=await info(taskFile);leaves.push(taskInfo);
    if(scope!=='http-tail')check('actual task starts three generations before stop',await ping(taskInfo.port));
    r=await chat('task-stop');check('actual task_stop reports confirmed owned job and removes all leaf resources',r.content.includes('no remaining members')&&await empty(taskInfo),JSON.stringify({r,trace}));
    r=await chat('cron-create');cronId=(r.content.match(/cron-\d+-\d+/)||[])[0];assert.ok(cronId,r.content);const cronInfo=await info(cronFile);leaves.push(cronInfo);
    check('actual scheduled cron fires owned command once while busy',await ping(cronInfo.port));
    r=await chat('cron-delete');check('actual cron delete waits for owned tree cleanup',r.content.includes('no remaining members')&&await empty(cronInfo),r.content);
    r=await chat('mcp');const mcpInfo=await info(mcpFile);leaves.push(mcpInfo);
    check('actual MCP JSON-RPC initializes/lists/calls through owned bidirectional pipes',r.content.includes('MCP_OWNED_中文')&&await ping(mcpInfo.port));
    const status=JSON.parse((await H.api('/api/info')).body);
    check('Agent diagnostics show only one persistent MCP owner after other routes close',status.processOwner.mode==='windows-job-v1'&&status.processOwner.active===1&&status.processOwner.pending===0);
    await H.stop();check('forced Agent stop removes MCP grandchildren without dispose callbacks',await empty(mcpInfo));
    await H.start(cwd);const restarted=JSON.parse((await H.api('/api/info')).body);
    check('same workspace restarts without stale native owner or lease',restarted.processOwner.active===0&&restarted.runtime.activeTasks===0);
    await H.stop();
  }
  if(scope==='all'||scope==='internal'||scope==='http-tail'){
    const source=fs.readFileSync(S.IDX,'utf8'),owner=require(path.join(path.dirname(S.IDX),'lib','process-owner')).create(cp,path.dirname(S.IDX));
    const adapter=Object.assign({},owner,{spawn(file,args,opts){const c=owner.spawn(file,args,opts);nativeChildren.push(c);return c;}});
    const c=vm.createContext({Buffer,console,process,fs,path,setTimeout,clearTimeout,setInterval,clearInterval,child_process:adapter,launchDir:cwd,
      agentDepth:0,workflowStepDepth:0,EXECUTION_TIMEOUT_MS:10000});
    vm.runInContext(cut(source,'function executionCancelledError(','function parseSSEStream(')+cut(source,'let bashPathCache;','function isSuperDangerous(')+
      cut(source,'const persistentShells =','function globToRegex(')+cut(source,'async function runDebugCycle(','// AST-R2:'),c);
    const debugFile=path.join(cwd,'debug-info.json'),debugScript=path.join(cwd,'debug-launch.js');
    fs.writeFileSync(debugScript,'process.argv[2]="root";process.argv[3]='+JSON.stringify(debugFile)+';require('+JSON.stringify(fixture)+');');
    const cancelled=c.createExecutionControl(10000),debug=c.runDebugCycle(debugScript,debugScript,'cli',1,cancelled);
    const debugInfo=await info(debugFile);leaves.push(debugInfo);cancelled.cancel('fixture cancellation');const result=await debug;cancelled.dispose();
    check('production debug observer cancellation waits for managed native close',result.stoppedByAgent&&!result.cleanupFailed&&!result.spawnFailed&&await empty(debugInfo),JSON.stringify(result));
    const bash=c.findBash();assert.ok(bash,'Git Bash required for this native shell fixture; cannot silently skip');
    const shell=c.createPersistentShell('owned-integration');
    const first=await shell.run('export OWNED_PERSIST=中文; echo "FIRST:$OWNED_PERSIST"',5000);
    const second=await shell.run('echo "SECOND:$OWNED_PERSIST"',5000);
    check('production persistent Bash retains environment through managed stdin and framing',first.code===0&&second.code===0&&first.out.includes('FIRST:中文')&&second.out.includes('SECOND:中文'));
    const shellFile=path.join(cwd,'shell-info.json'),shellCmd='"'+S.NODE_BIN.replace(/\\/g,'/')+'" "'+fixture.replace(/\\/g,'/')+'" root "'+shellFile.replace(/\\/g,'/')+'" &';
    await shell.run(shellCmd,5000);const shellInfo=await info(shellFile);leaves.push(shellInfo);
    const shellClosed=new Promise(r=>shell.child.once('close',r));shell.dispose();await shellClosed;
    check('disposing persistent Bash empties background grandchildren as well as interpreter',shell.child.ownedTree.closed&&await empty(shellInfo));
    check('debug and shell manager admission returns to zero',owner.processOwnerInfo().active===0&&owner.processOwnerInfo().pending===0);
  }
  console.log('PROCESS/INTEGRATION '+checks+'/'+checks+'; scope='+scope+'; SKIP 0; private HTTP/VM native routes, not Win7/GUI');
}finally{clearTimeout(timeout);for(const child of nativeChildren)if(child.exitCode==null&&child.signalCode==null)try{child.kill();}catch(e){}for(const leaf of leaves)await ping(leaf.port,'/stop');if(H){await H.stop();H.S.cleanup();}for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
