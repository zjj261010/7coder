'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const S=require('./_shared').create({suite:'recovery-exit'}),source=fs.readFileSync(S.IDX,'utf8');let checks=0,child;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==4){console.error('RECOVERY/EXIT incomplete '+checks+'/4');process.exitCode=1;}});
const a=source.indexOf('function flushExit('),b=source.indexOf('// ====================== SETUP',a);assert.ok(a>=0&&b>a);
function fixture(){let pending=true,now=0;const timers=[],exits=[];const c=vm.createContext({Date:{now:()=>now},setTimeout:fn=>timers.push(fn),process:{stdout:{},stderr:{},exitCode:1,exit:code=>exits.push(code)},processRecovery:{info:()=>({pending,persistenceError:null})}});vm.runInContext(source.slice(a,b),c);return {c,timers,exits,settle(){pending=false;},advance(){now=6001;}};}
function run(cwd){return new Promise((resolve,reject)=>{
  const current=S.spawn(S.NODE_BIN,[S.IDX,'--prompt','fixture must fail at checkpoint'],{cwd,env:Object.assign({},process.env,{OPENAI_API_KEY:'',OPENAI_ENDPOINT:'http://127.0.0.1:1',DREAM_ALLOW:'false',ENABLE_RALPH_MODE:'false',PERMISSION_MODE:'bypass'})});child=current;
  let output='';for(const stream of [current.stdout,current.stderr])stream.on('data',part=>output=(output+part).slice(-8192));
  const timer=setTimeout(()=>{current.kill();reject(Error('owned CLI exit deadline: '+output));},10000);current.on('error',reject);current.once('close',code=>{clearTimeout(timer);child=null;resolve({code,output});});
});}
(async()=>{try{
  let f=fixture();f.c.flushExit(0);assert.ok(f.exits.length===0&&f.timers.length===1);f.settle();f.timers.shift()();
  check('orderly exit waits for journal completion and retains existing nonzero exit code',f.exits.length===1&&f.exits[0]===1);
  f=fixture();f.c.flushExit(1);f.advance();f.timers.shift()();check('stuck journal cannot turn orderly exit into an unlimited wait',f.exits.length===1&&f.exits[0]===1);
  if(process.platform!=='win32')throw Error('CLI recovery fixture requires Windows owner adapter');
  const root=path.dirname(S.IDX),anchor="require('./lib/process-owner').create(raw_child_process, __dirname)";assert.ok(source.indexOf(anchor)===source.lastIndexOf(anchor)&&source.includes(anchor));
  fs.writeFileSync(S.IDX,source.replace(anchor,"require('./lib/process-owner').create(Object.assign({},raw_child_process,{spawn:require('./lib/fixture-exit-spawn').spawn}), __dirname)"));
  fs.writeFileSync(path.join(root,'lib','fixture-exit-spawn.js'),`const cp=require('child_process'),{EventEmitter}=require('events'),{PassThrough}=require('stream');exports.spawn=(file,args,opts)=>{if(!args[3]||!Buffer.from(args[3],'base64').toString('utf16le').includes('rev-parse'))return cp.spawn(file,args,opts);const child=new EventEmitter();child.pid=987654;child.exitCode=null;child.signalCode=null;child.kill=()=>true;for(const key of ['stdin','stdout','stderr'])child[key]=new PassThrough();setTimeout(()=>{child.exitCode=0;child.emit('exit',0,null);},20);return child;};`);
  const journal=path.join(root,'lib','process-recovery.js');let text=fs.readFileSync(journal,'utf8');const sync='fs.fsync(fd,syncError=>close(syncError));',finish='const finish=failure=>{pending=false;';assert.ok(text.includes(sync)&&text.includes(finish));
  text=text.replace(sync,'fs.fsync(fd,syncError=>setTimeout(()=>close(syncError),250));').replace(finish,"const finish=failure=>{fs.writeFileSync(path.join(directory,'journal-closed.fixture'),'completed');pending=false;");fs.writeFileSync(journal,text);
  const cwd=S.freshCwd('exit 中文'),first=await run(cwd),marker=path.join(cwd,'.7coder-process-recovery-required.json'),bytes=fs.readFileSync(marker);
  check('actual one-shot failure waits through delayed fsync/close before process.exit',first.code===1&&/unknown|recovery/i.test(first.output)&&fs.readFileSync(path.join(cwd,'journal-closed.fixture'),'utf8')==='completed'&&JSON.parse(bytes.toString()).code==='EOWNERUNKNOWN');
  const second=await run(cwd);check('next CLI refuses before checkpoint and preserves completed recovery evidence',second.code===1&&/process recovery required/i.test(second.output)&&fs.readFileSync(marker).equals(bytes));
  console.log('RECOVERY/EXIT 4/4; private fake checkpoint handle and delayed journal, no native target/model call');
}finally{if(child&&child.exitCode==null&&child.signalCode==null)child.kill();S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
