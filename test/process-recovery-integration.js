'use strict';
// Inject one fake broker into a PRIVATE install. The real Agent, owner adapter,
// control worker, request gate, tool loop and durable recovery code are used.
const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http');
const {create}=require('./_endpoint');let H,model,checks=0,modelCalls=0;const sockets=new Set();
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
const deadline=setTimeout(()=>{console.error('RECOVERY/HTTP deadline');process.exit(1);},30000);
process.once('exit',()=>{if(checks!==9){console.error('RECOVERY/HTTP incomplete '+checks+'/9');process.exitCode=1;}});
function request(port,body){return new Promise((resolve,reject)=>{
  const data=JSON.stringify(body);let timer;const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>{clearTimeout(timer);resolve({status:res.statusCode,text});});res.on('error',reject);
  });req.on('error',error=>{clearTimeout(timer);reject(error);});timer=setTimeout(()=>req.destroy(Error('fixture HTTP deadline')),8000);req.end(data);
});}
async function until(fn){const end=Date.now()+8000;while(true){const value=await fn();if(value)return value;if(Date.now()>end)throw Error('HTTP state deadline');await new Promise(r=>setTimeout(r,20));}}
(async()=>{try{
  if(process.platform!=='win32')throw Error('recovery integration requires Windows');
  model=http.createServer((req,res)=>{let text='';req.on('data',bytes=>text+=bytes);req.on('end',()=>{
    JSON.parse(text);modelCalls++;
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[
      {id:'unknown-command',type:'function',function:{name:'run_command',arguments:JSON.stringify({command:'echo UNKNOWN-PIPE-FIXTURE'})}},
      {id:'must-not-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'must-not-write.txt',content:'UNSAFE-REPLAY'})}}
    ]}}]}));
  });});model.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
  H=create({suite:'process-recovery-http',endpoint:'http://127.0.0.1:'+model.address().port,key:'',model:'fixture',permissionMode:'bypass'});
  const root=path.dirname(H.S.IDX),source=fs.readFileSync(H.S.IDX,'utf8'),anchor="require('./lib/process-owner').create(raw_child_process, __dirname)";
  assert.ok(source.indexOf(anchor)>=0&&source.indexOf(anchor)===source.lastIndexOf(anchor));
  fs.writeFileSync(H.S.IDX,source.replace(anchor,"require('./lib/process-owner').create(Object.assign({},raw_child_process,{spawn:require('./lib/fixture-unknown-spawn').spawn}), __dirname)"));
  fs.writeFileSync(path.join(root,'lib','fixture-unknown-spawn.js'),`'use strict';
const cp=require('child_process'),{EventEmitter}=require('events'),{PassThrough}=require('stream');
exports.spawn=function(file,args,options){
 if(!args[3]||!Buffer.from(args[3],'base64').toString('utf16le').includes('UNKNOWN-PIPE-FIXTURE'))return cp.spawn(file,args,options);
 const child=new EventEmitter();child.pid=987654;child.exitCode=null;child.signalCode=null;child.kill=()=>true;
 for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();
 setTimeout(()=>{child.stdout.write('fixture partial output');child.exitCode=0;child.emit('exit',0,null);},150);
 return child;
};\n`);
  const cwd=H.S.freshCwd('quarantine 中文');await H.start(cwd);
  const task={stream:false,messages:[{role:'user',content:'UNKNOWN-PIPE-TEST'}]};
  const first=request(H.port,task);
  await until(async()=>{const info=JSON.parse((await H.api('/api/info',null,800)).body);return info.runtime.activeTools===1&&info.processOwner.active===1;});
  const queued=request(H.port,task);
  const alive=JSON.parse((await H.api('/api/info',null,800)).body);
  check('HTTP remains responsive while one tool holds an unclosed fake broker',alive.load.chatActive&&!alive.processOwner.recoveryRequired);
  const [failed,rejected]=await Promise.all([first,queued]);
  check('unknown command releases current response with an explicit error',failed.status>=400&&/unknown|recovery/i.test(failed.text));
  check('queued request is rejected before another model call',rejected.status>=400&&modelCalls===1);
  const info=await until(async()=>{const i=JSON.parse((await H.api('/api/info',null,800)).body);return i.load.chatRequests===0&&i.load.chatQueued===0&&!i.load.chatActive&&i.runtime.activeTools===0&&!i.processRecovery.pending?i:null;});
  check('diagnostics expose sticky recovery and honest unresolved handle count',info.processOwner.recoveryRequired&&info.processOwner.active===1&&info.processOwner.unresolved===1&&info.processRecovery.required&&info.runtime.activeTasks===0);
  check('following tool in the same model round is never dispatched',!fs.existsSync(path.join(cwd,'must-not-write.txt')));
  const again=await request(H.port,task);check('subsequent chat fails with 503 without contacting the model',again.status===503&&JSON.parse(again.text).error.code==='EOWNERUNKNOWN'&&modelCalls===1);
  const marker=path.join(cwd,'.7coder-process-recovery-required.json'),bytes=fs.readFileSync(marker);
  const audit=fs.readFileSync(path.join(cwd,'.7coder','audit.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  check('unknown call is audited once with recovery evidence and no false successful write',audit.filter(e=>e.type==='tool'&&e.callId==='unknown-command'&&e.status==='error').length===1&&!audit.some(e=>e.callId==='must-not-write')&&JSON.parse(bytes.toString()).code==='EOWNERUNKNOWN');
  await H.stop();
  await assert.rejects(H.start(cwd),/process recovery required|recovery-required/i);
  check('restart fails before model/config recovery and retains exact marker bytes',modelCalls===1&&fs.readFileSync(marker).equals(bytes));
  check('native runtime material was not changed by the injected failure',require('../lib/process-owner').validateInstallation(root).sha256===require('../lib/process-owner').validateInstallation(path.resolve(__dirname,'..')).sha256);
  console.log('RECOVERY/HTTP 9/9; private fake held broker, real Agent/control/gate; no target launched for injected command');
}finally{
  clearTimeout(deadline);if(H){await H.stop();H.S.cleanup();}for(const socket of sockets)socket.destroy();if(model)await new Promise(r=>model.close(r));
}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
