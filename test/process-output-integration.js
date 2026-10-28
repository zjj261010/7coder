'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),http=require('http');
const S=require('./_shared').create({suite:'process-output-integration'}),root=path.dirname(S.IDX),children=[];let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==9){console.error('OUTPUT/INTEGRATION incomplete '+checks+'/9');process.exitCode=1;}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+8000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(15);}throw Error('owned output phase deadline');}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.on('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
let manager;
function launch(bytes,label,gate){
  const file=path.join(cwd,label+'.json'),heart=path.join(cwd,label+'.heart');fs.writeFileSync(heart,'');let child,close;
  const result=new Promise(resolve=>{
    child=manager.execFile(S.NODE_BIN,[script,String(bytes),file,heart,gate||''],{encoding:'buffer',maxBuffer:64*1024*1024,timeout:15000,windowsHide:true},(error,stdout,stderr)=>resolve({error,stdout,stderr}));
    children.push(child);child.on('error',()=>{});close=new Promise(r=>child.once('close',r));if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');
  });
  return {child,result,close,file,heart};
}
let cwd,script;
const deadline=setTimeout(()=>{console.error('OUTPUT/INTEGRATION deadline');for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();process.exit(1);},25000);
(async()=>{try{
  if(process.platform!=='win32')throw Error('managed output integration requires Windows');
  manager=require(path.join(root,'lib','process-owner')).create(cp,root);cwd=S.freshCwd('capture 中文');script=path.join(cwd,'producer.js');
  fs.writeFileSync(script,`const fs=require('fs'),http=require('http');const bytes=Number(process.argv[2]),file=process.argv[3],heart=process.argv[4],gate=process.argv[5];setTimeout(()=>process.exit(0),18000);http.createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){const port=this.address().port;process.stdout.write(Buffer.alloc(bytes,120),()=>fs.writeFileSync(file,JSON.stringify({port})));});let fired=false;setInterval(()=>{fs.appendFileSync(heart,'x');if(gate&&!fired&&fs.existsSync(gate)){fired=true;process.stdout.write(Buffer.alloc(1024*1024,121));}},20);`);
  const gate=path.join(cwd,'overflow.gate'),overflow=launch(0,'overflow',gate);const info=await until(()=>{try{return JSON.parse(fs.readFileSync(overflow.file));}catch(error){return null;}});
  const first=launch(16*1024*1024,'first');await until(()=>manager.processOwnerInfo().outputCapture.retainedBytes===16*1024*1024);
  const second=launch(16*1024*1024,'second');await until(()=>manager.processOwnerInfo().outputCapture.retainedBytes===32*1024*1024);
  let state=manager.processOwnerInfo();
  check('three actual owned producers share one exact 32MiB capture reservation',state.active===3&&state.outputCapture.active===3&&state.outputCapture.allocatedBytes===32*1024*1024&&state.outputCapture.blocks===2048);
  fs.writeFileSync(gate,'go');const failed=await overflow.result;await overflow.close;
  check('aggregate overflow waits for native proof/close and reports sent command failure',failed.error&&failed.error.code==='ERR_PROCESS_OUTPUT_BUDGET'&&failed.stdout.length===0&&overflow.child.ownedTree.closed&&overflow.child.ownedTree.stopped);
  await until(async()=>!await ping(info.port));const size=fs.statSync(overflow.heart).size;await pause(120);
  check('offending producer loses its actual listener and heartbeat',fs.statSync(overflow.heart).size===size);
  state=manager.processOwnerInfo();check('healthy peers stay live and charged without global unknown quarantine',state.active===2&&state.outputCapture.allocatedBytes===32*1024*1024&&!state.recoveryRequired&&first.child.exitCode===null&&second.child.exitCode===null);
  const forbidden=path.join(cwd,'must-not-start.txt');let refused;
  try{manager.execFile(S.NODE_BIN,['-e','require("fs").writeFileSync('+JSON.stringify(forbidden)+',"WRONG")'],{},()=>{});}catch(error){refused=error;}
  check('new process at full capacity is refused before any target side effect',refused&&refused.code==='ERR_PROCESS_OUTPUT_BUDGET'&&!fs.existsSync(forbidden)&&manager.processOwnerInfo().active===2);
  first.child.kill();const firstResult=await first.result;await first.close;state=manager.processOwnerInfo();
  check('confirmed first stop frees only its own 16MiB while preserving returned prefix',first.child.ownedTree.closed&&firstResult.stdout.length===16*1024*1024&&state.outputCapture.allocatedBytes===16*1024*1024&&state.outputCapture.active===1);
  const recovered=await new Promise(resolve=>{const child=manager.execFile(S.NODE_BIN,['-e','process.stdout.write("OUTPUT-RECOVERED中文")'],{encoding:'utf8',timeout:5000,windowsHide:true},(error,stdout)=>resolve({error,stdout,child}));children.push(child);child.on('error',()=>{});});
  check('freed capacity admits the next real command with exact Unicode output',!recovered.error&&recovered.stdout==='OUTPUT-RECOVERED中文'&&recovered.child.ownedTree.closed&&manager.processOwnerInfo().outputCapture.allocatedBytes===16*1024*1024);
  second.child.kill();await second.result;await second.close;state=manager.processOwnerInfo();
  check('final native close restores all parent counters without false unknown',state.active===0&&state.pending===0&&!state.recoveryRequired&&state.outputCapture.active===0&&state.outputCapture.allocatedBytes===0&&state.outputCapture.retainedBytes===0&&state.outputCapture.blocks===0);
  const material=require('../lib/process-owner');check('production native source/executable binding remains unchanged',material.validateInstallation(root).sha256===material.validateInstallation(path.resolve(__dirname,'..')).sha256);
  console.log('OUTPUT/INTEGRATION 9/9; actual Node13 producers, strict native Jobs; no desktop/model/external PID operations');
}finally{clearTimeout(deadline);for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();for(const child of children)if(child.exitCode==null&&child.signalCode==null)await new Promise(r=>child.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
