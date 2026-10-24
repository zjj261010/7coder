// Compiler/interpreter shims are deliberate fixtures, not a Python/.NET eval.
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),cp=require('child_process');
const {loadContext}=require('./download-commit'),S=require('./_shared').create({suite:'debug-prerequisites'}),source=fs.readFileSync(S.IDX,'utf8'),children=[];
let checks=0,skips=0;
const deadline=setTimeout(()=>{console.error('DEBUG/PREREQUISITES deadline');for(const child of children)if(!child.closed)child.kill();S.cleanup();process.exit(1);},20000);
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
function cut(from,to){const a=source.indexOf(from),b=source.indexOf(to,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('owned child deadline');await new Promise(r=>setTimeout(r,10));}}
function own(child,command,args){children.push(child);child.closed=false;child.output='';child.command=command;child.arguments=args;
  if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');
  if(child.stdout)child.stdout.on('data',d=>child.output+=d.toString());
  const timer=setTimeout(()=>{if(!child.closed)child.kill();},6000);child.once('close',()=>{child.closed=true;clearTimeout(timer);});return child;
}
(async()=>{
  try{
    const cwd=S.freshCwd('debug 中文 空格'),root=path.join(cwd,'Windows fixture'),bin=path.join(cwd,'bin');fs.mkdirSync(bin);let spawns=0,compiles=0;
    const contextProcess={platform:process.platform,execPath:S.NODE_BIN,env:{PATH:bin,SystemRoot:root}};
    const c=loadContext(source,cwd,{},{Buffer,process:contextProcess,ENABLE_AUTO_DEBUG:true,ENABLE_HTTP_SERVER:false,DANGER_MODE:false,DEBUG_TEST_MINUTES:3,autoDebugActive:false,systemPrompt:'fixture',
      console:{log(){},warn(){}},effectivePermissionMode:()=> 'bypass',
      child_process:{spawn(){spawns++;throw Error('unexpected spawn');}},runCommandAsync(){compiles++;throw Error('unexpected compile');}});
    vm.runInContext(cut('let bashPathCache;','function isSuperDangerous(')+cut('function findOptionalExecutable(','function powerShellExecutable(')+
      cut('function runCommandAsync(','// ====================== PERSISTENT SHELL')+
      cut('async function runDebugCycle(','// AST-R2: reason of the most recent auto-approval')+
      'async function debug(args,cancelled=null,modelContext=null){const name="auto_debug_tool";\n'+cut("  if (name === 'auto_debug_tool') {",'  return `Unknown tool:')+'\n}'+
      'async function bashTool(args,cancelled){const name="bash_tool";\n'+cut("  if (name === 'bash_tool') {","  if (name === 'powershell_tool') {")+'\n}',c);
    const discovered=c.findBash;c.findBash=()=>null;
    for(const [file,word]of [['app.py','Python prerequisite'],['app.sh','Bash prerequisite'],['app.cs','C# compiler csc']]){
      fs.writeFileSync(path.join(cwd,file),'fixture');const r=await c.debug({path:file});check(file+' missing dependency is explicit with no process/compile and restored guard',r.status==='error'&&r.text.includes(word)&&spawns===0&&compiles===0&&!c.autoDebugActive);
    }
    const framework=path.join(root,'Microsoft.NET','Framework','v2.0.50727','csc.exe');fs.mkdirSync(path.dirname(framework),{recursive:true});fs.writeFileSync(framework,'fixture compiler');
    check('default Windows framework compiler can be discovered without PATH',process.platform!=='win32'||c.findCSharpCompiler()===framework);
    const pathCompiler=path.join(bin,process.platform==='win32'?'csc.exe':'csc');fs.writeFileSync(pathCompiler,'fixture');if(process.platform!=='win32')fs.chmodSync(pathCompiler,0o755);
    check('explicit PATH compiler takes precedence',c.findCSharpCompiler()===pathCompiler);
    let compileSpec;
    c.runCommandAsync=spec=>{compileSpec=spec;return {promise:Promise.resolve({error:null,stdout:'',stderr:''}),kill(){}};};
    const cycle=c.runDebugCycle;c.runDebugCycle=async()=>({log:'',stdout:'',stderr:'',exitCode:0,signal:null,spawnFailed:false,cleanupFailed:false,outputExceeded:false,ioError:false});
    const cs=await c.debug({path:'源 & 空格.cs'});
    check('compiler receives checked absolute executable and exact argv without shell',cs.status==='ok'&&compileSpec.file===pathCompiler&&!compileSpec.cmd&&compileSpec.args[1]===path.join(cwd,'源 & 空格.cs')&&compileSpec.args[2]==='/out:'+path.join(cwd,'源 & 空格.exe'));
    c.runDebugCycle=cycle;
    const python=path.join(bin,process.platform==='win32'?'python.exe':'python3');fs.copyFileSync(S.NODE_BIN,python);if(process.platform!=='win32')fs.chmodSync(python,0o755);
    c.child_process={spawn(file,args,opts){return own(cp.spawn(file,args.concat(['--7coder-test-owner='+S.runDir]),Object.assign({},opts,{windowsHide:true,env:opts.env||Object.assign({},process.env,{PATH:''})})),file,args);},
      execFile(file,args,opts,callback){return own(cp.execFile(file,args.concat(['--7coder-test-owner='+S.runDir]),Object.assign({},opts,{windowsHide:true}),callback),file,args);}};
    const py=path.join(cwd,'脚本 & 空格.py');fs.writeFileSync(py,'console.log("OWNED_INTERPRETER_SHIM");process.exit(7);');
    const observed=await c.runDebugCycle(py,py,'cli',0.05);
    check('owned interpreter shim uses absolute PATH selection and Unicode/space argv',observed.exitCode===7&&observed.stdout.includes('OWNED_INTERPRETER_SHIM')&&children[0].command===python&&children[0].closed);

    c.process=process;c.findBash=discovered;const bash=c.findBash();
    if(!bash){skips++;console.log('SKIP real Git Bash debug/stateless ownership (Bash unavailable)');}
    else{
      const direct=c.persistentBashExecutable(bash),script=path.join(cwd,'命令 空格.sh');fs.writeFileSync(script,'printf "OWNED_BASH_DEBUG_READY\\n"\nend=$((SECONDS+6)); while ((SECONDS<end)); do :; done\n');
      const token=c.createExecutionControl(10000),wait=c.runDebugCycle(script,script,'cli',1,token);await until(()=>children[children.length-1].output.includes('OWNED_BASH_DEBUG_READY'));const target=children[children.length-1];token.cancel('fixture stop');const result=await wait;token.dispose();
      check('debug owns selected actual Bash interpreter and observes close on cancel',target.command===direct&&target.closed&&result.stoppedByAgent&&!result.cleanupFailed);
      check('Git layout resolves to usr interpreter with matching environment',process.platform!=='win32'||!/[\\/]Git[\\/]bin[\\/]bash.exe$/i.test(bash)||/[\\/]usr[\\/]bin[\\/]bash.exe$/i.test(target.command));
      vm.runInContext(cut('function runCommandAsync(','// ====================== PERSISTENT SHELL'),c);
      const second=c.createExecutionControl(10000),running=c.bashTool({command:'printf "OWNED_STATELESS_READY\\n"; end=$((SECONDS+6)); while ((SECONDS<end)); do :; done'},second);
      await until(()=>children[children.length-1].output.includes('OWNED_STATELESS_READY'));const command=children[children.length-1];second.cancel('fixture stop');const stopped=await running;second.dispose();
      check('stateless Bash cancellation closes actual interpreter before returning',stopped.status==='cancelled'&&command.command===direct&&command.closed);
    }
    console.log('DEBUG/PREREQUISITES '+checks+'/'+checks+'; '+skips+' SKIP');
  }finally{clearTimeout(deadline);for(const child of children)if(!child.closed)child.kill();S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
