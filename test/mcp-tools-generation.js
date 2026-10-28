'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),vm=require('vm'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const S=require('./_shared').create({suite:'mcp-tools-generation'}),root=path.dirname(S.IDX),source=fs.readFileSync(S.IDX,'utf8'),clients=[],children=[],queue=[];let actual=false,checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==15){console.error('MCP/TOOLS-GENERATION incomplete '+checks+'/15');process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('tool generation phase deadline');await pause(5);}}
const owner=require(path.join(root,'lib','process-owner')).create(cp,root);
const c=vm.createContext({Buffer,fs,path,process,console:{warn(){},log(){}},setTimeout,clearTimeout,setInterval,clearInterval,launchDir:S.runDir,APP_VERSION:'fixture',MCP_MAX_FRAME_BYTES:4*1024*1024,MCP_CALL_TIMEOUT:5000,EXECUTION_TIMEOUT_MS:5000,mcpClients:{},mcpServers:{},
  child_process:Object.assign({},owner,{spawn(file,args,opts){if(!actual)return queue.shift().child;const child=owner.spawn(file,args,opts);children.push(child);child.on('error',()=>{});if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');return child;}})});
vm.runInContext(cut('function executionCancelledError(','function parseSSEStream(')+cut('function mcpContentToText(','// A2-19:')+cut('function createMcpStdioClient(','// Redact secrets'),c);c.resolveCommandOnWindows=()=>false;
let seq=0;
function fixture(pages,initChange=false){const child=new EventEmitter(),f={child,pages,writes:[],held:null};child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  f.frame=message=>child.stdout.write(JSON.stringify(Object.assign({jsonrpc:'2.0'},message))+'\n');f.notify=()=>f.frame({method:'notifications/tools/list_changed'});
  child.stdin=new Writable({write(bytes,encoding,callback){const req=JSON.parse(bytes.toString());f.writes.push(req);callback();if(req.id===undefined||typeof req.method!=='string')return;setImmediate(()=>{
    if(req.method==='initialize'){f.frame({id:req.id,result:{protocolVersion:'2024-11-05'}});if(initChange)f.notify();return;}
    const page=f.pages.shift();if(page==='HOLD'){f.held=req.id;return;}f.frame({id:req.id,result:page});
  });}});queue.push(f);f.client=c.createMcpStdioClient('fake-'+(++seq),{command:'fixture'});f.client.initialized=!initChange;c.mcpClients[f.client.name]=f.client;clients.push(f.client);return f;}
const tools=name=>({tools:[{name,description:'中文'}]});
const deadline=setTimeout(()=>{console.error('MCP/TOOLS-GENERATION deadline');for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();process.exit(1);},20000);
(async()=>{try{
  const first=fixture([tools('one')]),other=fixture([tools('other')]);const old=await first.client.listTools(),stable=await other.client.listTools(),remaining=other.client.schemaBytes;
  check('initial complete caches record current generation and shared schema charges',first.client.toolsCacheGeneration===0&&other.client.toolsCacheGeneration===0&&c.mcpBudgetSnapshot().schemaBytes===first.client.schemaBytes+remaining);
  const writes=first.writes.length;first.notify();
  check('list-changed invalidates only its completed cache while preserving returned snapshots',first.client.toolsCache===null&&first.client.toolsCacheGeneration===null&&first.client.toolsGeneration===1&&c.mcpBudgetSnapshot().schemaBytes===remaining&&other.client.toolsCache===stable&&old[0].name==='one');
  check('notification sends no response or new request and borrows no pending slot',first.writes.length===writes&&c.mcpBudgetSnapshot().pending===0);
  first.pages.push(tools('two'));const fresh=await first.client.listTools();
  check('next list fetches and publishes the new generation rather than stale cache',fresh!==old&&fresh[0].name==='two'&&first.client.toolsCacheGeneration===1&&first.writes.length===writes+1);
  first.notify();first.notify();check('repeated invalidations do not underflow cache bytes or mutate another client',first.client.toolsGeneration===3&&first.client.schemaBytes===0&&c.mcpBudgetSnapshot().schemaBytes===remaining);
  first.pages.push(tools('three'));await first.client.listTools();const cache=first.client.toolsCache,generation=first.client.toolsGeneration;
  first.frame({method:'notifications/tools/list_changed',result:{}});first.frame({jsonrpc:'1.0',method:'notifications/tools/list_changed'});first.frame({id:99,method:'notifications/tools/list_changed'});
  check('malformed notification and peer request forms do not masquerade as list invalidation',first.client.toolsGeneration===generation&&first.client.toolsCache===cache&&first.writes[first.writes.length-1].error.code===-32601);

  first.pages.push(Object.assign(tools('old-page'),{nextCursor:'next'}),'HOLD');let settled=false;
  const listing=first.client.listTools(true).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});await until(()=>first.held!==null);const charged=first.client.schemaBytes;first.notify();
  check('in-flight invalidation retains accumulator reservation until its own continuation settles',charged>2&&!settled&&first.client.listingTools&&first.client.toolsCache===null&&first.client.schemaBytes===charged&&c.mcpBudgetSnapshot().schemaBytes===remaining+charged);
  first.frame({id:first.held,result:{tools:[]}});const failed=await listing;
  check('mixed-generation pagination fails without publishing partial cache or freeing peer storage',failed.error&&/changed during discovery/.test(failed.error.message)&&!first.client.listingTools&&first.client.toolsCache===null&&first.client.schemaBytes===0&&c.mcpBudgetSnapshot().schemaBytes===remaining);
  first.pages.push(tools('four'));const last=await first.client.listTools();check('explicit fresh discovery after change completes coherently',last[0].name==='four'&&first.client.toolsCacheGeneration===first.client.toolsGeneration);
  const init=fixture([tools('post-init')],true);await assert.rejects(init.client.listTools(),/changed during discovery/);
  check('change before initialization continuation sends no stale first-page request',init.client.initialized&&init.writes.filter(req=>req.method==='tools/list').length===0&&init.client.schemaBytes===0&&init.client.toolsCache===null);
  const postInit=await init.client.listTools();check('initialized client can explicitly rediscover from new generation',postInit[0].name==='post-init'&&init.client.toolsCacheGeneration===1);
  for(const client of clients)client.dispose();const retiredGeneration=first.client.toolsGeneration;first.notify();await new Promise(r=>setImmediate(r));const stats=c.mcpBudgetSnapshot();
  check('retired notifications cannot revive schema or leak shared reservations',first.client.toolsGeneration===retiredGeneration&&stats.schemaBytes===0&&stats.pending===0&&stats.incomingBytes===0&&stats.queuedBytes===0);

  if(process.platform!=='win32')throw Error('actual generation peer requires Windows owner');actual=true;
  const cwd=S.freshCwd('tool generation'),script=path.join(cwd,'peer.js');
  fs.writeFileSync(script,`let buf='',version=1,paginate=false;function send(x){process.stdout.write(JSON.stringify(Object.assign({jsonrpc:'2.0'},x))+'\\n');}process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;if(q.method==='initialize')send({id:q.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}}});else if(q.method==='tools/call'){if(q.params.name==='change'){version++;send({method:'notifications/tools/list_changed'});}else paginate=true;send({id:q.id,result:{content:[{type:'text',text:'CHANGED'}]}});}else if(q.method==='tools/list'){if(paginate&&!q.params.cursor)send({id:q.id,result:{tools:[{name:'old-page'}],nextCursor:'next'}});else if(paginate){paginate=false;version++;send({method:'notifications/tools/list_changed'});send({id:q.id,result:{tools:[]}});}else send({id:q.id,result:{tools:[{name:'v'+version}]}});}}});`);
  const native=c.createMcpStdioClient('native',{command:S.NODE_BIN,args:[script]});clients.push(native);c.mcpClients.native=native;
  const v1=await native.listTools();await native.callTool('change',{});const v2=await native.listTools();
  check('actual peer notification refreshes previously cached tool names and generation',v1[0].name==='v1'&&v2[0].name==='v2'&&native.toolsGeneration===1&&native.toolsCacheGeneration===1);
  await native.callTool('change-pages',{});await assert.rejects(native.listTools(true),/changed during discovery/);const emptyAfterChange=native.toolsCache===null&&native.schemaBytes===0;const v3=await native.listTools();
  check('actual mid-page change discards old pages and next explicit list recovers',emptyAfterChange&&v3[0].name==='v3'&&native.toolsGeneration===2&&native.toolsCacheGeneration===2);
  const closed=new Promise(r=>native.child.once('close',r));native.dispose();await closed;
  check('actual generation changes/shutdown restore Job and MCP schema/input/pending counts',native.child.ownedTree.closed&&owner.processOwnerInfo().active===0&&c.mcpBudgetSnapshot().schemaBytes===0&&c.mcpBudgetSnapshot().pending===0&&c.mcpBudgetSnapshot().incomingBytes===0);
  console.log('MCP/TOOLS-GENERATION 15/15; real parser/owned peer, coherent discovery; returned snapshots are not current-state guarantees');
}finally{clearTimeout(deadline);for(const client of clients)client.dispose();for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();for(const child of children)if(child.exitCode==null&&child.signalCode==null)await new Promise(r=>child.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
