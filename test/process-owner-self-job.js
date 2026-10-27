// Opt-in feasibility experiment. Creator and target share one strict owned Job.
// A modern host may already enclose the test in another Job: record that fact.
// Not production material and not a Windows 7 release certification.
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process');
if(process.platform!=='win32'||!process.argv.includes('--run')){console.error('Windows diagnostic only: add --run; requires .NET 3.5 compiler.');process.exit(2);}
const S=require('./_shared').create({suite:'self-job-mechanism'}),root=path.dirname(S.IDX),dir=path.join(S.runDir,'self-job');fs.mkdirSync(dir);
const {quote,validateInstallation}=require(path.join(root,'lib','process-owner'));
const before=validateInstallation(path.resolve(__dirname,'..'));
let checks=0;const EXPECTED=21;
process.once('exit',()=>{if(checks!==EXPECTED){console.error('SELF/JOB incomplete '+checks+'/'+EXPECTED);process.exitCode=1;}});
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+10000;while(Date.now()<end){if(fn())return;await pause(20);}throw Error(label);}
const exe=path.join(dir,'self-guard.exe'),source=path.join(dir,'self-guard.cs');
fs.copyFileSync(path.join(__dirname,'fixtures','creation-guard.cs'),source);
function compile(){
 const fw=path.join(process.env.SystemRoot,'Microsoft.NET','Framework');
 const r=cp.spawnSync(path.join(fw,'v3.5','csc.exe'),['/nologo','/noconfig','/reference:'+path.join(fw,'v2.0.50727','System.dll'),'/target:exe','/platform:anycpu','/win32manifest:'+path.join(root,'native','process-owner.manifest'),'/out:'+exe,source],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
 assert.ok(!r.error&&r.status===0,'private fixture compile: '+r.stdout+' '+r.stderr);fs.copyFileSync(path.join(root,'native','process-owner.exe.config'),exe+'.config');
}
function inspect(handle,consume){
 if(consume)handle.consumed=true;
 const r=cp.spawnSync(exe,['inspect',String(process.pid),handle.parentBirth,handle.remote,String(handle.pid),handle.birth,consume?'consume':'peek'],{encoding:'utf8',windowsHide:true,timeout:7000,maxBuffer:65536});
 assert.ok(!r.error&&r.status===0,'stable handle inspection: '+r.stdout+' '+r.stderr);return r.stdout.trim();
}
function treeCode(base){
 const leaf='require("fs").writeFileSync('+JSON.stringify(base+'-leaf.json')+',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);';
 const middle='require("child_process").spawn(process.execPath,["-e",'+JSON.stringify(leaf)+'],{stdio:"ignore",detached:true});require("fs").writeFileSync('+JSON.stringify(base+'-middle.json')+',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);';
 return 'require("child_process").spawn(process.execPath,["-e",'+JSON.stringify(middle)+'],{stdio:"ignore"});require("fs").writeFileSync('+JSON.stringify(base+'-root.json')+',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);';
}
async function scenario(mode){
 const base=path.join(dir,mode),command=quote(S.NODE_BIN)+' -e '+quote(treeCode(base));
 const args=['self',String(process.pid),Buffer.from(S.NODE_BIN,'utf16le').toString('base64'),Buffer.from(command,'utf16le').toString('base64')];
 const child=cp.spawn(exe,args,{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe'],env:Object.assign({},process.env,{SELF_JOB_GATE:'',SELF_JOB_REQUIRE_EMPTY_HOST:'0'})});
 if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+dir+'\n');
 let ready=null,error=null,stderr='',partial='',running=false,only=false,outerJob=null;const handles=[];
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 child.on('error',e=>{error=e;});child.stdin.on('error',()=>{});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{try{
  partial+=chunk;let at;while((at=partial.indexOf('\n'))>=0){const line=partial.slice(0,at).trim();partial=partial.slice(at+1);let m;
   if((m=/^SELF_READY (\d+) ([01])$/.exec(line))){ready=m[1];outerJob=m[2]==='1';console.log('HOST '+mode+' preexistingJob='+outerJob);}
   else if((m=/^SELF_(TARGET|CAPTURE) (\d+) (\d+) (\d+)$/.exec(line)))handles.push({kind:m[1],pid:Number(m[2]),remote:m[3],birth:m[4],parentBirth:ready,consumed:false});
   else if(line==='SELF_RUNNING')running=true;
   else if(line==='ONLY_SELF 1')only=true;else throw Error('unexpected self fixture output: '+line);
  }
 }catch(e){error=e;}});
 const wait=fn=>until(()=>{if(error)throw error;if(child.exitCode!==null)throw Error('creator exited early: '+stderr);return fn();},'self fixture phase '+mode);
 try{
  await wait(()=>ready);check(mode+': creator joined its strict Job before any target',!fs.existsSync(base+'-root.json'));
  if(mode==='before'){
   child.kill('SIGKILL');await closed;check('before: owned creator termination leaves no target execution',!fs.existsSync(base+'-root.json'));return;
  }
  child.stdin.write('CREATE\n');await wait(()=>handles.length===1);
  check(mode+': suspended target inherited Job without a later target Assign',handles[0].pid>0&&inspect(handles[0],false)==='ALIVE');
  if(mode==='suspended'){
   check('suspended: target entry has not run',!fs.existsSync(base+'-root.json'));
   child.kill('SIGKILL');await closed;
   check('suspended: creator death terminates the already-owned target',inspect(handles[0],true).startsWith('EXIT ')&&!fs.existsSync(base+'-root.json'));return;
  }
  if(mode==='eof'){
   child.stdin.end();const end=await closed;
   check('eof: control loss exits creator and cleans its unresumed target',end.code===125&&inspect(handles[0],true).startsWith('EXIT ')&&!fs.existsSync(base+'-root.json'));return;
  }
  child.stdin.write('RESUME\n');await wait(()=>running);
  await wait(()=>['root','middle','leaf'].every(name=>fs.existsSync(base+'-'+name+'.json')));
  const pids=['middle','leaf'].map(name=>JSON.parse(fs.readFileSync(base+'-'+name+'.json','utf8')).pid);
  for(const pid of pids)child.stdin.write('CAPTURE '+pid+'\n');await wait(()=>handles.length===3);
  check(mode+': detached leaf and intermediate are verified Job members',pids.every(pid=>handles.some(h=>h.pid===pid))&&handles.every(h=>inspect(h,false)==='ALIVE'));
  if(mode==='running'){
   child.kill('SIGKILL');await closed;check('running: creator death terminates all three stable process handles',handles.every(h=>inspect(h,true).startsWith('EXIT ')));return;
  }
  child.stdin.write('CLEANUP\n');await wait(()=>only);
  check('normal: bounded current-Job cleanup proves only creator remains',only&&child.exitCode===null);
  check('normal: all three captured members have exited before completion proof',handles.every(h=>inspect(h,true).startsWith('EXIT ')));
  child.stdin.end('EXIT\n');const end=await closed;
  check('normal: OS teardown closes sole Job while preserving selected exit code',end.code===37);
  fs.writeFileSync(path.join(dir,'normal-evidence.json'),JSON.stringify({mode,outerJob,handles,only,creatorExit:end},null,2));
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}
  for(const handle of handles)if(!handle.consumed)inspect(handle,true);
 }
}
async function rejectOuterJob(){
 const base=path.join(dir,'outer'),command=[exe,'self',String(process.pid),Buffer.from(S.NODE_BIN,'utf16le').toString('base64'),Buffer.from(quote(S.NODE_BIN)+' -e '+quote(treeCode(base)),'utf16le').toString('base64')].map(quote).join(' ');
 const gate=path.join(dir,'outer-start.gate');
 const child=cp.spawn(exe,['guard',exe,Buffer.from(command,'utf16le').toString('base64'),String(process.pid)],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe'],env:Object.assign({},process.env,{SELF_JOB_GATE:gate,SELF_JOB_REQUIRE_EMPTY_HOST:'1'})});
 if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+dir+'\n');
 let output='',stderr='',error=null;child.on('error',e=>{error=e;});child.stdin.on('error',()=>{});child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{stderr+=b;});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 try{
  await until(()=>{if(error)throw error;return /GUARDED \d+ \d+/.test(output)&&/BROKER \d+ \d+ \d+/.test(output);},'outer guardian assignment');
  fs.writeFileSync(gate,'START');
  await until(()=>{if(error)throw error;return stderr.includes('SELF_ERROR self-existing-job');},'strict outer Job must reject self enrollment');
  child.stdin.end('CLEANUP\n');const end=await closed;
  const guarded=/GUARDED (\d+) (\d+)/.exec(output),broker=/BROKER (\d+) (\d+) (\d+)/.exec(output);
  assert.ok(guarded&&broker,'outer fixture exported owned creator handle');
  const handle={pid:Number(broker[1]),remote:broker[2],birth:broker[3],parentBirth:guarded[2],consumed:false};
  check('host: strict outer Job rejected before target creation, without nesting fallback',end.code===0&&output.includes('EMPTY 0')&&!output.includes('SELF_READY')&&!fs.existsSync(base+'-root.json')&&inspect(handle,true).startsWith('EXIT '));
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
}
(async()=>{try{
 compile();for(const mode of ['before','suspended','running','normal','eof'])await scenario(mode);await rejectOuterJob();
 check('production native material is unchanged',validateInstallation(path.resolve(__dirname,'..')).sha256===before.sha256);
 console.log('SELF/JOB '+checks+'/'+EXPECTED+'; creator/target sharing mechanism; preexisting host Job recorded; product and Win7 gate remain open');console.log('EVIDENCE '+dir);
}finally{S.cleanup();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
