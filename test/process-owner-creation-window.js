// Opt-in diagnostic, not a green release gate: this intentionally demonstrates
// the pre-Assign gap using a private instrumented broker. An external Job owns
// every target from birth, and a duplicated handle verifies final termination.
const assert=require('assert'),fs=require('fs'),path=require('path'),cp=require('child_process'),net=require('net'),crypto=require('crypto');
if(!process.argv.includes('--run')){console.error('Opt-in diagnostic: add --run; requires Windows and the .NET 3.5 compiler.');process.exit(2);}
if(process.platform!=='win32'){console.error('creation-window diagnostic requires Windows');process.exit(2);}
const S=require('./_shared').create({suite:'creation-window-diagnostic'}),root=path.dirname(S.IDX);
const {quote,validateInstallation}=require(path.join(root,'lib','process-owner'));
const productionManifest=validateInstallation(path.resolve(__dirname,'..'));
const dir=path.join(S.runDir,'creation-window');fs.mkdirSync(dir);
const original=fs.readFileSync(path.join(root,'native','process-owner.cs'),'utf8');
const scope=process.env.CREATION_WINDOW_SCOPE||'all';assert.ok(['all','tail'].includes(scope),'known creation-window diagnostic scope');
let checks=0;const EXPECTED=scope==='tail'?12:14;
process.once('exit',()=>{if(checks!==EXPECTED){console.error('CREATION/WINDOW incomplete '+checks+'/'+EXPECTED);process.exitCode=1;}});
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const value=fn();if(value)return value;await pause(20);}throw Error(label);}
function replaceOnce(source,from,to){assert.ok(source.indexOf(from)>=0&&source.indexOf(from)===source.lastIndexOf(from),'one injection anchor');return source.replace(from,to);}
function compile(file,name){
 const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework','v3.5','csc.exe');
 assert.ok(fs.existsSync(compiler),'prepare .NET 3.5 compiler on diagnostic host; target app needs no compiler');
 const exe=path.join(dir,name+'.exe'),r=cp.spawnSync(compiler,['/nologo','/noconfig','/reference:'+path.join(process.env.SystemRoot,'Microsoft.NET','Framework','v2.0.50727','System.dll'),'/target:exe','/platform:anycpu','/win32manifest:'+path.join(root,'native','process-owner.manifest'),'/out:'+exe,file],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
 assert.ok(!r.error&&r.status===0,'private fixture compile: '+r.stdout+' '+r.stderr);fs.copyFileSync(path.join(root,'native','process-owner.exe.config'),exe+'.config');return exe;
}
const importAnchor='static IntPtr pipe =';
let instrumented=replaceOnce(original,importAnchor,'[DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);\n    '+importAnchor);
const assign='Require(AssignProcessToJobObject(job,target.process),"assign-job");';
instrumented=replaceOnce(instrumented,assign,'bool diagnosticMember; Require(IsProcessInJob(target.process,job,out diagnosticMember),"diagnostic-membership");\n            if(!Send("TEST_CREATED "+target.pid+" "+(diagnosticMember?"1":"0"))) stop.Set();\n            if(!go.WaitOne(30000,false)) stop.Set();\n            '+assign);
const privateSource=path.join(dir,'instrumented.cs');fs.writeFileSync(privateSource,instrumented);
const guardSource=path.join(dir,'guard.cs');fs.copyFileSync(path.join(__dirname,'fixtures','creation-guard.cs'),guardSource);
let brokerExe,guardExe;
function inspect(state,consume){
 if(consume)state.consumed=true; // never retry a numeric remote handle after close-source
 const r=cp.spawnSync(guardExe,['inspect',String(process.pid),state.parentBirth,state.remote,String(state.pid),state.birth,consume?'consume':'peek'],{encoding:'utf8',windowsHide:true,timeout:7000,maxBuffer:65536});
 assert.ok(!r.error&&r.status===0,'owned handle inspection: '+r.stdout+' '+r.stderr);return r.stdout.trim();
}
async function session(mode){
 const pipe='\\\\.\\pipe\\7coder-gap-'+crypto.randomBytes(24).toString('hex'),token=crypto.randomBytes(24).toString('hex');
 const marker=path.join(dir,'must-not-resume-'+mode+'.txt');
 const command=quote(S.NODE_BIN)+' -e '+quote('require("fs").writeFileSync('+JSON.stringify(marker)+',"WRONG");setTimeout(()=>{},20000)');
 const argv=[pipe,token,Buffer.from(S.NODE_BIN,'utf16le').toString('base64'),Buffer.from(command,'utf16le').toString('base64'),'hidden'];
 const brokerCommand=[brokerExe].concat(argv).map(quote).join(' ');
 const state={broker:null,guarded:null,hello:null,gap:null,target:null,after:null,empty:false,error:null,socket:null,pipeClosed:false,consumed:false};
 let guardian,closed,stdout='',stderr='',started=false;
 function start(){if(!started&&state.guarded&&state.hello){assert.strictEqual(state.guarded.pid,state.hello.pid,'guarded broker PID');state.socket.write('START\n');started=true;}}
 const server=net.createServer(socket=>{
   if(state.socket){socket.destroy();return;}state.socket=socket;socket.setEncoding('ascii');socket.on('error',e=>{state.error=e;});let text='';
   socket.on('data',chunk=>{try{if(text.length+chunk.length>1024)throw Error('diagnostic frame budget');text+=chunk;let at;while((at=text.indexOf('\n'))>=0){const line=text.slice(0,at);text=text.slice(at+1);const hello=/^HELLO ([a-f0-9]{48}) (\d+)$/.exec(line),gap=/^TEST_CREATED (\d+) ([01])$/.exec(line);if(hello){assert.strictEqual(hello[1],token);state.hello={pid:Number(hello[2])};start();}else if(gap)state.gap={pid:Number(gap[1]),ownMember:gap[2]==='1'};else throw Error('unexpected diagnostic protocol: '+line);}}catch(e){state.error=e;socket.destroy();}});
   socket.on('close',()=>{state.pipeClosed=true;});
 });
 const ready=fn=>until(()=>{if(state.error)throw state.error;if(guardian&&guardian.exitCode!==null&&!state.empty)throw Error('guardian early exit: '+stderr+' '+stdout);return fn();},'diagnostic phase deadline');
 try{
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
   guardian=cp.spawn(guardExe,['guard',brokerExe,Buffer.from(brokerCommand,'utf16le').toString('base64'),String(process.pid)],{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
   if(guardian.pid)fs.appendFileSync(S.manifest,guardian.pid+'\t'+dir+'\n');
   guardian.on('error',e=>{state.error=e;});guardian.stdin.on('error',()=>{});closed=new Promise(r=>guardian.once('close',(code,signal)=>r({code,signal})));
   guardian.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
   guardian.stdout.setEncoding('utf8');guardian.stdout.on('data',chunk=>{try{stdout+=chunk;let at;while((at=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,at).trim();stdout=stdout.slice(at+1);let m;if((m=/^GUARDED (\d+) (\d+)$/.exec(line))){state.guarded={pid:Number(m[1]),parentBirth:m[2]};start();}else if((m=/^BROKER (\d+) (\d+) (\d+)$/.exec(line))){state.broker={pid:Number(m[1]),remote:m[2],birth:m[3],parentBirth:state.guarded.parentBirth,consumed:false};}else if((m=/^TARGET (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(line))){state.target={pid:Number(m[1]),remote:m[2],birth:m[3],active:Number(m[4]),total:Number(m[5]),parentBirth:state.guarded.parentBirth,consumed:false};}else if(line.startsWith('MEMBERS '))state.members=line.slice(8);else if((m=/^AFTER (\d+) (\d+)$/.exec(line)))state.after={active:Number(m[1]),total:Number(m[2])};else if(line.startsWith('AFTERMEMBERS '))state.afterMembers=line.slice(13);else if(line==='EMPTY 0')state.empty=true;else throw Error('unexpected guardian output: '+line);}}catch(e){state.error=e;}});
   await ready(()=>state.gap&&state.broker);
   if(scope!=='tail'||mode!=='broker'){
   check(mode+': START released only after guardian owns the matching broker',started&&state.hello.pid===state.guarded.pid);
   check(mode+': target exists before Assign and is not a member of broker own Job',state.gap.pid>0&&!state.gap.ownMember);
   }
   guardian.stdin.write('TARGET '+state.gap.pid+'\n');await ready(()=>state.target&&state.members);
   check(mode+': external Job owns broker and target, and exports a stable target handle',state.target.pid===state.gap.pid&&state.target.active>=2&&state.target.total>=state.target.active&&Number(state.target.remote)>0&&state.members.split(',').some(m=>m.startsWith(state.guarded.pid+':'))&&state.members.split(',').some(m=>m.startsWith(state.gap.pid+':')),JSON.stringify({target:state.target,members:state.members}));
   check(mode+': target entry has never resumed',!fs.existsSync(marker));
   if(mode==='broker'){
     guardian.stdin.write('KILL\n');await ready(()=>state.after&&state.afterMembers);
     check('broker: killing broker by owned handle leaves the protected target alive',state.after.active>=1&&state.afterMembers.split(',').some(m=>m.startsWith(state.target.pid+':'))&&!state.afterMembers.split(',').some(m=>m.startsWith(state.guarded.pid+':'))&&inspect(state.broker,true).startsWith('EXIT '));
     check('broker: PID and birth-verified target handle confirms it remains alive',inspect(state.target,false)==='ALIVE');
     guardian.stdin.end('CLEANUP\n');const end=await closed;
     check('broker: explicit guardian cleanup proves zero members, target exit, and no execution',end.code===0&&state.empty&&inspect(state.target,true).startsWith('EXIT ')&&!fs.existsSync(marker));
   }else{
     guardian.kill('SIGKILL');await closed;
     check('guardian: uncatchable guardian death closes Job and terminates the target',inspect(state.target,true).startsWith('EXIT '));
     await until(()=>state.pipeClosed,'guarded broker control did not close');
     check('guardian: broker also exits and target never runs after guard death',state.pipeClosed&&inspect(state.broker,true).startsWith('EXIT ')&&!fs.existsSync(marker));
   }
   fs.writeFileSync(path.join(dir,mode+'-evidence.json'),JSON.stringify({mode,guarded:state.guarded,gap:state.gap,target:state.target,members:state.members,after:state.after,afterMembers:state.afterMembers,broker:state.broker,empty:state.empty,targetNeverResumed:!fs.existsSync(marker)},null,2));
 }finally{
   if(guardian&&guardian.exitCode===null&&guardian.signalCode===null){guardian.stdin.end('CLEANUP\n');let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('guardian cleanup deadline')),7000);})]);}catch(e){guardian.kill('SIGKILL');await closed;}finally{clearTimeout(timer);}}
   if(state.target&&!state.target.consumed)inspect(state.target,true);
   if(state.broker&&!state.broker.consumed)inspect(state.broker,true);
   if(state.socket)state.socket.destroy();await new Promise(r=>server.close(r));
 }
}
(async()=>{try{
 brokerExe=compile(privateSource,'instrumented');guardExe=compile(guardSource,'guard');
 await session('broker');await session('guardian');
 check('production native source/exe/config material remains unchanged',validateInstallation(path.resolve(__dirname,'..')).sha256===productionManifest.sha256);
 console.log('CREATION/WINDOW '+checks+'/'+EXPECTED+'; CONFIRMED guarded pre-Assign ownership gap; not a fix or Win7 certification');
 console.log('EVIDENCE '+dir);
}finally{S.cleanup();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
