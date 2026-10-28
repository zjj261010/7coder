'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),vm=require('vm'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const S=require('./_shared').create({suite:'mcp-initialize'}),root=path.dirname(S.IDX),source=fs.readFileSync(S.IDX,'utf8'),clients=[],children=[],queue=[];let actual=false,checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==20){console.error('MCP/INITIALIZE incomplete '+checks+'/20');process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const owner=require(path.join(root,'lib','process-owner')).create(cp,root);
const c=vm.createContext({Buffer,fs,path,process,console:{warn(){},log(){}},setTimeout,clearTimeout,setInterval,clearInterval,launchDir:S.runDir,APP_VERSION:'fixture',MCP_MAX_FRAME_BYTES:4*1024*1024,MCP_CALL_TIMEOUT:5000,EXECUTION_TIMEOUT_MS:5000,mcpClients:{},mcpServers:{},
  child_process:Object.assign({},owner,{spawn(file,args,opts){if(!actual)return queue.shift().child;const child=owner.spawn(file,args,opts);children.push(child);child.on('error',()=>{});if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');return child;}})});
vm.runInContext(cut('function executionCancelledError(','function parseSSEStream(')+cut('function mcpContentToText(','// A2-19:')+cut('function resolveCommandOnWindows(','// Redact secrets'),c);
c.resolveCommandOnWindows=()=>false; // These fixtures exercise initialization, not host PATH discovery.
let seq=0;
function fixture(result,options={}){
  const child=new EventEmitter(),f={child,writes:[],kills:0};child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{f.kills++;return true;};
  child.stdin=new Writable({write(bytes,encoding,callback){const request=JSON.parse(bytes.toString());f.writes.push(request);callback();if(request.id===undefined)return;
    setImmediate(()=>{
      const response=options.error?{error:{code:-32602,message:'initialize rejected'}}:{result:request.method==='initialize'?result:request.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'ECHO'}]}};
      child.stdout.write(JSON.stringify(Object.assign({jsonrpc:'2.0',id:request.id},response))+'\n');if(request.method==='initialize'&&options.exit)child.emit('exit',1);
    });}});
  queue.push(f);f.name=options.name||'fixture-'+(++seq);c.mcpServers[f.name]={command:'fixture'};f.client=c.getMcpClient(f.name);clients.push(f.client);return f;
}
const deadline=setTimeout(()=>{console.error('MCP/INITIALIZE deadline');for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();process.exit(1);},20000);
(async()=>{try{
  for(const result of [null,[],42,{capabilities:null},{capabilities:[]},{serverInfo:null},{serverInfo:{name:7}},{serverInfo:{version:7}},{protocolVersion:null},{protocolVersion:'2025-03-26'},{protocolVersion:{toString:null}}]){
    const f=fixture(result);await assert.rejects(f.client.callTool('echo',{}),e=>e.code==='MCP_PROTOCOL_ERROR');
    check('invalid initialize '+JSON.stringify(result)+' retires before notification/tool dispatch',f.client.dead&&!f.client.initialized&&f.client.protocolVersion===null&&f.client.initPromise===null&&f.kills===1&&f.writes.length===1&&!c.mcpClients[f.name]);
  }
  let f=fixture({}, {error:true});await assert.rejects(f.client.callTool('echo',{}),/initialize rejected/);
  check('explicit remote initialize rejection also retires the half-session',f.client.dead&&f.kills===1&&f.writes.length===1&&!c.mcpClients[f.name]);
  f=fixture({});await f.client.ensureInit();check('legacy object metadata remains compatible without pretending a negotiated version',f.client.initialized&&f.client.protocolVersion===null&&f.writes.filter(r=>r.method==='notifications/initialized').length===1);
  f=fixture({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
  const values=await Promise.all([f.client.callTool('echo',{}),f.client.listTools()]);
  check('concurrent first operations share one valid initialization and one initialized notification',values[0]==='ECHO'&&values[1].length===0&&f.client.protocolVersion==='2024-11-05'&&f.writes.filter(r=>r.method==='initialize').length===1&&f.writes.filter(r=>r.method==='notifications/initialized').length===1);
  f=fixture({});await assert.rejects(f.client.callTool('echo',{},()=>true),e=>e.code==='EXECUTION_CANCELLED');
  check('pre-cancelled caller starts no initialization and leaves unused client intact',f.writes.length===0&&!f.client.dead&&f.kills===0);
  f=fixture({protocolVersion:'2024-11-05'},{exit:true});await assert.rejects(f.client.callTool('echo',{}));
  check('exit between initialize reply and continuation cannot revive initialized state',f.client.dead&&!f.client.initialized&&f.writes.length===1);
  const old=fixture(null);await assert.rejects(old.client.ensureInit());
  const nextChild=fixture({protocolVersion:'2024-11-05'},{name:old.name});
  await nextChild.client.ensureInit();old.child.emit('exit',1);old.child.stdout.write(JSON.stringify({id:1,result:{protocolVersion:'2024-11-05'}})+'\n');
  check('late retired initialize reply/exit cannot evict or mutate a replacement client',c.mcpClients[old.name]===nextChild.client&&nextChild.client.initialized&&nextChild.client.protocolVersion==='2024-11-05');
  for(const client of clients)client.dispose();await new Promise(r=>setImmediate(r));const stats=c.mcpBudgetSnapshot();
  check('all successful/failed/cancelled initialization owners restore MCP reservations',stats.pending===0&&stats.queuedBytes===0&&stats.incomingBytes===0&&stats.schemaBytes===0);

  if(process.platform!=='win32')throw Error('real initialization peer requires Windows owner');actual=true;
  const cwd=S.freshCwd('initialize peer'),script=path.join(cwd,'peer.js'),marker=path.join(cwd,'tools-called.txt');
  fs.writeFileSync(script,`const fs=require('fs');let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;let result;if(q.method==='initialize')result={protocolVersion:process.env.MCP_INIT_VARIANT==='bad'?'2025-03-26':'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else{fs.appendFileSync(${JSON.stringify(marker)},'x');result={content:[{type:'text',text:'REAL-INIT-RECOVERED'}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`);
  c.mcpServers.actual={command:S.NODE_BIN,args:[script],env:{MCP_INIT_VARIANT:'bad'}};const bad=c.getMcpClient('actual');clients.push(bad);const badClose=new Promise(r=>bad.child.once('close',r));
  await assert.rejects(bad.callTool('echo',{}),e=>e.code==='MCP_PROTOCOL_ERROR');await badClose;
  check('actual unsupported server version closes owned tree without one tools/call side effect',bad.dead&&!bad.initialized&&!fs.existsSync(marker)&&bad.child.ownedTree.closed&&owner.processOwnerInfo().active===0&&!c.mcpClients.actual);
  c.mcpServers.actual.env.MCP_INIT_VARIANT='valid';const good=c.getMcpClient('actual');clients.push(good);const text=await good.callTool('echo',{});
  const diag=c.mcpDiagnosticsSnapshot().find(entry=>entry.name==='actual'),goodClose=new Promise(r=>good.child.once('close',r));good.dispose();await goodClose;
  check('fresh actual session negotiates supported version, completes once and cleans up',good!==bad&&text==='REAL-INIT-RECOVERED'&&fs.readFileSync(marker,'utf8')==='x'&&diag.protocolVersion==='2024-11-05'&&good.child.ownedTree.closed&&owner.processOwnerInfo().active===0&&c.mcpBudgetSnapshot().pending===0);
  console.log('MCP/INITIALIZE 20/20; real source/owned peers; legacy omissions remain explicitly unverified metadata');
}finally{clearTimeout(deadline);for(const client of clients)client.dispose();for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();for(const child of children)if(child.exitCode==null&&child.signalCode==null)await new Promise(r=>child.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
