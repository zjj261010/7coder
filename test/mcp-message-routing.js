'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const S=require('./_shared').create({suite:'mcp-message-routing'}),source=fs.readFileSync(S.IDX,'utf8');let checks=0;const clients=[];
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
const observed=promise=>promise.then(value=>({value}),error=>({error}));
process.once('exit',()=>{if(checks!==23){console.error('MCP/ROUTING incomplete '+checks+'/23');process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const child=new EventEmitter(),writes=[];child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
child.stdin=new Writable({write(chunk,encoding,callback){writes.push(JSON.parse(chunk.toString()));callback();}});
const c=vm.createContext({Buffer,process,launchDir:S.runDir,APP_VERSION:'fixture',MCP_MAX_FRAME_BYTES:4*1024*1024,MCP_CALL_TIMEOUT:5000,
  mcpClients:{},child_process:{spawn:()=>child},resolveCommandOnWindows:()=>false,console:{warn(){}},setTimeout,clearTimeout,
  checkExecution(){},watchExecution:()=>()=>{},executionCancelledError:()=>Error('cancelled'),mcpContentToText:()=>''});
vm.runInContext(cut('function serializeModelRequest(','function checkExecution(')+cut('function createMcpStdioClient(','function getMcpClient('),c);const client=c.createMcpStdioClient('peer',{});clients.push(client);
function start(){const id=client.nextId;return {id,result:observed(client.request('tools/call',{},5000))};}
function frame(message){child.stdout.write(JSON.stringify(Object.assign({jsonrpc:'2.0'},message))+'\n');}
(async()=>{try{
  let f=start();frame({id:f.id,method:'ping'});
  check('server ping sharing client request ID is answered without releasing its pending slot',client.pending.has(f.id)&&c.mcpBudgetSnapshot().pending===1&&writes[writes.length-1].result&&Object.keys(writes[writes.length-1].result).length===0);
  frame({id:f.id,result:{actual:'RESULT'}});check('only actual response completes the original call with the same ID',(await f.result).value.actual==='RESULT'&&client.pending.size===0);
  f=start();frame({id:f.id,method:'roots/list'});const roots=writes[writes.length-1];
  check('roots/list collision has its own response and keeps outbound call pending',roots.id===f.id&&roots.result.roots.length===0&&client.pending.has(f.id));frame({id:f.id,result:true});await f.result;
  f=start();frame({id:f.id,method:'peer/unsupported'});
  check('unknown server request with colliding ID gets -32601 without becoming our response',writes[writes.length-1].error.code===-32601&&client.pending.has(f.id));frame({id:f.id,result:true});await f.result;
  for(const message of [{method:null},{method:'ping',result:'ambiguous'}]){
    f=start();frame(Object.assign({id:f.id},message));
    check('malformed request '+JSON.stringify(message)+' cannot settle an outbound call',client.pending.has(f.id)&&writes[writes.length-1].error.code===-32600);
    frame({id:f.id,result:false});assert.strictEqual((await f.result).value,false);
  }
  f=start();const before=writes.length;frame({method:'notifications/progress',params:{id:f.id}});
  check('notification sends no response and cannot complete an outbound request',writes.length===before&&client.pending.has(f.id));
  frame({id:{bad:f.id},method:'ping'});check('invalid peer ID is ignored without coercing it into our pending map',writes.length===before&&client.pending.has(f.id));frame({id:f.id,result:true});await f.result;
  for(const value of [null,false,0,'']){
    f=start();frame({id:f.id,result:value});check('legitimate falsey result '+JSON.stringify(value)+' is not confused with missing result',(await f.result).value===value&&!client.dead);
  }
  for(const malformed of [{},{result:'x',error:{code:-1,message:'both'}},{error:null},{error:false},{error:{code:-1,message:{bad:true}}},{error:{code:1.5,message:'bad code'}},{jsonrpc:'1.0',result:'wrong protocol'}]){
    f=start();frame(Object.assign({id:f.id},malformed));const result=await f.result;
    check('invalid response '+JSON.stringify(malformed)+' fails one call as unknown, without empty success',result.error&&result.error.code==='MCP_PROTOCOL_ERROR'&&/result unknown/.test(result.error.message)&&!client.dead&&client.pending.size===0);
  }
  f=start();const nested='{"id":'+f.id+',"error":{"code":-1,"message":'+'['.repeat(20000)+'0'+']'.repeat(20000)+'}}\n';
  assert.throws(()=>JSON.stringify(JSON.parse(nested).error),/call stack/i);child.stdout.write(nested);
  check('deep malformed error body is rejected without recursive stringify in stdout listener',(await f.result).error.code==='MCP_PROTOCOL_ERROR'&&!client.dead);
  const bad=start(),good=start();frame({id:bad.id});const failed=await bad.result;frame({id:good.id,result:{stable:true}});
  check('invalid response affects only its own call; another pending request still completes',failed.error.code==='MCP_PROTOCOL_ERROR'&&(await good.result).value.stable&&client.pending.size===0);
  f=start();frame({id:f.id,error:{code:-32602,message:'expected remote failure',data:{detail:'not retained'}}});
  check('well-formed remote error retains its useful message without reporting success',(await f.result).error.message==='expected remote failure'&&!client.dead);
  client.dispose();await new Promise(r=>setImmediate(r));const stats=c.mcpBudgetSnapshot();
  check('all response directions and malformed paths release owned pending/write/input counters once',stats.pending===0&&stats.queuedBytes===0&&stats.incomingBytes===0&&stats.schemaBytes===0);
  console.log('MCP/ROUTING 23/23; actual parser, fake byte pipes; no OS child or signal');
}finally{for(const client of clients)client.dispose();S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
