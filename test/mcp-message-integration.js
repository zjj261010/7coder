'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http');
const {create}=require('./_endpoint');let H,model,checks=0;const sockets=new Set();
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==8){console.error('MCP/MESSAGES incomplete '+checks+'/8');process.exitCode=1;}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+8000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(15);}throw Error('MCP fixture phase deadline');}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.on('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
const deadline=setTimeout(()=>{console.error('MCP/MESSAGES deadline');process.exit(1);},30000);
(async()=>{try{
  model=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
    const body=JSON.parse(raw),last=body.messages[body.messages.length-1];let message;
    if(!body.tools)message={role:'assistant',content:'fixture summary'};
    else if(last.role==='tool')message={role:'assistant',content:'FIXTURE-FINISHED'};
    else{const prompt=body.messages.filter(m=>m.role==='user').pop().content,invalid=prompt.includes('INVALID');message={role:'assistant',content:null,tool_calls:[{id:invalid?'invalid-call':prompt.includes('RECOVER')?'recover-call':'echo-call',type:'function',function:{name:'mcp_tool',arguments:JSON.stringify({server:'peer',tool_name:invalid?'invalid':'echo',args:{text:'中文😀'}})}}]};}
    if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:message}]})+'\n\ndata: [DONE]\n\n');}
    else res.end(JSON.stringify({choices:[{message}]}));
  });});model.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
  H=create({suite:'mcp-message-http',endpoint:'http://127.0.0.1:'+model.address().port,key:'',model:'fixture',permissionMode:'bypass'});
  const cwd=H.S.freshCwd('bidirectional 中文'),script=path.join(cwd,'peer.js'),events=path.join(cwd,'peer.jsonl'),heart=path.join(cwd,'peer.heart'),info=path.join(cwd,'peer.json');
  fs.writeFileSync(heart,'');fs.mkdirSync(path.join(cwd,'.7coder'));
  fs.writeFileSync(path.join(cwd,'.7coder','mcp.json'),JSON.stringify({servers:{peer:{command:H.S.NODE_BIN,args:[script]}}}));
  fs.writeFileSync(script,`const fs=require('fs'),http=require('http');const waiting=new Map();function log(x){fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(x)+'\\n');}function send(x){process.stdout.write(JSON.stringify(Object.assign({jsonrpc:'2.0'},x))+'\\n');}http.createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({port:this.address().port}));});setInterval(()=>fs.appendFileSync(${JSON.stringify(heart)},'x'),20);let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;if(typeof q.method==='string'){log({kind:'call',id:q.id,method:q.method,tool:q.params&&q.params.name});waiting.set(q.id,q);send({id:q.id,method:q.params&&q.params.name==='invalid'?'fixture/unsupported':'ping'});}else if(waiting.has(q.id)){const original=waiting.get(q.id);waiting.delete(q.id);const invalid=original.params&&original.params.name==='invalid';if(invalid?!(q.error&&q.error.code===-32601):!(q.result&&Object.keys(q.result).length===0)){log({kind:'wrong-peer-reply',id:q.id});continue;}log({kind:'peer-reply',id:q.id,code:q.error&&q.error.code});if(original.method==='initialize')send({id:q.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}});else if(invalid)send({id:q.id});else send({id:q.id,result:{content:[{type:'text',text:'BIDIR:'+original.params.arguments.text}]}});}}});`);
  await H.start(cwd);let response=await H.chat([{role:'user',content:'MCP-ECHO'}],10000);
  const result=response.tools.find(e=>e.type==='result'&&e.callId==='echo-call'),rows=()=>fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse);
  check('actual initialize and tools/call survive colliding server ping IDs before real responses',result&&result.status==='completed'&&String(result.result).includes('BIDIR:中文😀')&&rows().filter(e=>e.kind==='peer-reply').length===2);
  const audit=()=>fs.readFileSync(path.join(cwd,'.7coder','audit.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  check('echo side effect and tool audit correlate exactly once',rows().filter(e=>e.kind==='call'&&e.method==='tools/call').length===1&&audit().filter(e=>e.callId==='echo-call'&&e.status==='ok').length===1);
  response=await H.chat([{role:'user',content:'MCP-INVALID'}],10000);const invalid=response.tools.find(e=>e.type==='result'&&e.callId==='invalid-call');
  check('missing actual response result/error becomes explicit unknown error instead of empty success',invalid&&invalid.status==='error'&&/result unknown/.test(invalid.result));
  check('unsupported peer request is answered without completing our call or replaying work',rows().filter(e=>e.kind==='peer-reply'&&e.code===-32601).length===1&&rows().filter(e=>e.kind==='call'&&e.method==='tools/call').length===2&&audit().filter(e=>e.callId==='invalid-call'&&e.status==='error').length===1);
  response=await H.chat([{role:'user',content:'MCP-RECOVER'}],10000);const recovered=response.tools.find(e=>e.type==='result'&&e.callId==='recover-call');
  check('same real MCP session remains usable after one malformed response',recovered&&recovered.status==='completed'&&String(recovered.result).includes('BIDIR:中文😀')&&rows().filter(e=>e.kind==='call'&&e.method==='initialize').length===1);
  const status=JSON.parse((await H.api('/api/info',null,800)).body);
  check('actual Agent restores pending/frame/write counts and keeps its single owned MCP server',status.mcpBudget.pending===0&&status.mcpBudget.incomingBytes===0&&status.mcpBudget.queuedBytes===0&&status.processOwner.active===1&&!status.processOwner.recoveryRequired&&!rows().some(e=>e.kind==='wrong-peer-reply'));
  const port=JSON.parse(fs.readFileSync(info)).port;await H.stop();await until(async()=>!await ping(port));const bytes=fs.statSync(heart).size;await pause(120);
  check('owned Agent stop removes actual MCP heartbeat and listener',fs.statSync(heart).size===bytes);
  const material=require('../lib/process-owner');check('production native ownership material remains unchanged',material.validateInstallation(path.dirname(H.S.IDX)).sha256===material.validateInstallation(path.resolve(__dirname,'..')).sha256);
  console.log('MCP/MESSAGES 8/8; actual private Agent, local model, real owned stdio peer; no external model/desktop operations');
}finally{clearTimeout(deadline);if(H){await H.stop();H.S.cleanup();}for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
