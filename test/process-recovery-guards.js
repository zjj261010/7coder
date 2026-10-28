'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path'),{EventEmitter}=require('events');
const source=fs.readFileSync(path.resolve(__dirname,'../index.js'),'utf8');let checks=0;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
function cut(a,b){const from=source.indexOf(a),to=source.indexOf(b,from);assert.ok(from>=0&&to>from,a);return source.slice(from,to);}
const error=()=>Object.assign(Error('fixture owner unknown'),{code:'EOWNERUNKNOWN'});
const calls=[{id:'a',function:{name:'read_file',arguments:'{}'}},{id:'b',function:{name:'read_file',arguments:'{}'}}];
process.once('exit',()=>{if(checks!==8){console.error('RECOVERY/GUARDS incomplete '+checks+'/8');process.exitCode=1;}});
function context(extra){return vm.createContext(Object.assign({console:{log(){},warn(){}},setTimeout,clearTimeout,process,path,Buffer,launchDir:'private-fixture',recordRuntimeEvent(){},
  MAX_TOOL_STEPS:2,HEAVY_MODEL:'fixture',createModelContext:main=>({main}),compressConversationIfNeeded:async()=>{},capToolResult:String,
  child_process:{assertProcessOwnerReady(){}},watchExecution:()=>()=>{}},extra));}
const guard=cut('function checkExecution(','function watchExecution('),loop=cut('async function processWithTools(','// ====================== TASK CHANGE SUMMARY');
(async()=>{
  let model=0,c=context({MAX_TOOL_STEPS:0,child_process:{assertProcessOwnerReady(){throw error();}},callOpenAI:async()=>{model++;}});
  vm.runInContext(guard+loop,c);await assert.rejects(c.processWithTools([]),e=>e.code==='EOWNERUNKNOWN');
  check('even zero-step forced-final path sends no model request while quarantined',model===0);

  let dispatched=0;c=context({READ_ONLY_TOOLS:new Set(['read_file']),callOpenAI:async()=>{model++;return {message:{role:'assistant',tool_calls:calls}};},safeExecuteTool:async()=>{dispatched++;throw error();}});
  vm.runInContext(guard+loop,c);await assert.rejects(c.processWithTools([]),e=>e.code==='EOWNERUNKNOWN');
  check('parallel read batch cannot turn owner-unknown rejection into model-facing text and continue',dispatched===2&&model===1);

  let quarantined=false;dispatched=0;model=0;c=context({READ_ONLY_TOOLS:new Set(),child_process:{assertProcessOwnerReady(){if(quarantined)throw error();}},
    callOpenAI:async()=>{model++;return {message:{role:'assistant',tool_calls:calls}};},safeExecuteTool:async()=>{dispatched++;quarantined=true;return 'Tool error: cleanup unconfirmed';}});
  vm.runInContext(guard+loop,c);await assert.rejects(c.processWithTools([]),e=>e.code==='EOWNERUNKNOWN');
  check('global guard stops same-round second dispatch even if an inner tool catches the error',dispatched===1&&model===1);

  let detached=0;c=context({watchExecution:()=>()=>detached++});vm.runInContext(cut('async function awaitCommandCancellable(','// Git commands use argv'),c);
  await assert.rejects(c.awaitCommandCancellable({promise:Promise.resolve({error:error()}),kill(){}},()=>true),e=>e.code==='EOWNERUNKNOWN');
  check('unknown completion outranks ordinary cancellation and releases its token subscription',detached===1);

  c=context({child_process:{assertProcessOwnerReady(){throw error();}}});vm.runInContext(guard,c);assert.throws(()=>c.checkExecution(()=>true),e=>e.code==='EOWNERUNKNOWN');
  check('cancelled caller cannot mask an already quarantined process outcome',true);

  let writes=0;quarantined=false;c=context({DANGER_MODE:false,workflowStepDepth:0,effectivePermissionMode:()=> 'default',isProtectedTarget:()=>false,matchPermRule:()=>null,isSuperDangerous:()=>false,
    child_process:{assertProcessOwnerReady(){if(quarantined)throw error();}},getToolMetadata:()=>({risk:'HIGH',explain:()=> 'fixture'}),
    askApproval:async()=>{quarantined=true;return true;},executeToolRaw:async()=>{writes++;},makeToolResult:(status,text)=>({status,text})});
  vm.runInContext(guard+cut('async function safeExecuteToolInner(','// ====================== APPROVAL'),c);
  await assert.rejects(c.safeExecuteToolInner({function:{name:'write_file',arguments:'{}'}},[],null,()=>false),e=>e.code==='EOWNERUNKNOWN');
  check('approval received after quarantine cannot dispatch a file write',writes===0);

  let marked=0;const child=new EventEmitter();child.pid=123;child.exitCode=0;child.signalCode=null;child.ownedTree={closed:true};child.markOwnerUnknown=()=>{marked++;child.emit('ownerUnknown',error());};
  c=context();vm.runInContext(cut('const ownedChildStates =','async function stopBackgroundTask('),c);const stopped=await c.stopOwnedChild(child,1);
  check('stop deadline with target proof but no broker close remains unknown and requests recovery',marked===1&&!stopped.closed&&stopped.treeClosed&&!stopped.message.includes('broker closed'));

  let kills=0;const debugChild=new EventEmitter();debugChild.pid=124;debugChild.exitCode=null;debugChild.signalCode=null;debugChild.kill=()=>{kills++;return true;};
  c=context({child_process:{spawn(){process.nextTick(()=>debugChild.emit('error',error()));return debugChild;}}});
  vm.runInContext(guard+cut('async function runDebugCycle(','// AST-R2:'),c);const result=await c.runDebugCycle('fixture.js','fixture.js','cli',1);
  check('debug unknown event settles without fabricating spawn failure or broker close',result.cleanupFailed&&!result.spawnFailed&&kills===0&&debugChild.exitCode===null);
  console.log('RECOVERY/GUARDS 8/8; actual source boundaries, fake tools/handles; no OS process or filesystem writes');
})().catch(failure=>{console.error(failure.stack);process.exitCode=1;});
