// Original desktop branch, real private files, captured process dispatch.
// Does not invoke SendKeys, user32, screen capture, or any desktop app.
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const {loadContext}=require('./download-commit'),S=require('./_shared').create({suite:'desktop-lifecycle'});
const source=fs.readFileSync(S.IDX,'utf8');let checks=0;
const scope=process.env.DESKTOP_LIFECYCLE_SCOPE||'all';
function check(label,ok,detail){assert.ok(ok,label+(detail?' '+detail:''));checks++;console.log('PASS '+label);}
function cut(a,b){const p=source.indexOf(a),q=source.indexOf(b,p);assert.ok(p>=0&&q>p,a);return source.slice(p,q);}
function decoded(spec){const match=/FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(spec.args[spec.args.indexOf('-Command')+1]||'');return match?Buffer.from(match[1],'base64').toString('utf16le'):'';}
function fixture(overrides,extra){const cwd=S.freshCwd('desktop 中文 空格'),f={cwd,calls:[],events:[],outcome:{r:{error:null,stdout:'done',stderr:'',exitCode:0},aborted:false}};
 const c=loadContext(source,cwd,overrides||{},{process,console:{log(){},warn(){}},VISION_MODEL:'',
  makeToolResult:(status,text,data)=>({status,text,data}),recordRuntimeEvent:(...event)=>f.events.push(event),
  child_process:{execSync(){throw Error('real desktop forbidden');},execFileSync(){throw Error('real desktop forbidden');}},...extra});f.c=c;
 c.runCommandAsync=(spec,opts)=>{const file=spec.args[spec.args.indexOf('-File')+1];const call={spec,opts};if(spec.args.includes('-File')){call.script=file;call.bytes=fs.readFileSync(file);f.lastScript=file;}else{call.code=decoded(spec);const match=/\$bmp\.Save\('((?:[^']|'')*)'/.exec(call.code);if(match&&f.image){call.image=match[1].replace(/''/g,"'");fs.writeFileSync(call.image,Buffer.from([137,80,78,71,13,10,26,10]));}}f.calls.push(call);return {promise:Promise.resolve(f.outcome.r)};};
 c.awaitCommandCancellable=async()=>f.outcome;
 vm.runInContext(cut('function powerShellExecutable()','// AST-09: async child-process runner')+'async function tool(args,cancelled=null,modelContext={}) {const name="computer_use";\n'+cut("  if (name === 'computer_use') {","  if (name === 'workflow_tool') {")+'\n}',c);
 f.invoke=async(args,token)=>{try{return await c.tool(args,token);}catch(error){return {status:error.code==='EXECUTION_CANCELLED'?'cancelled':'error',text:error.message};}};return f;
}
(async()=>{try{
 if(process.platform!=='win32')throw Error('desktop-lifecycle filesystem fixtures require Windows');
 if(scope!=='roots'){
 let f=fixture(),state=path.join(f.cwd,'.7coder');fs.mkdirSync(state);const target=path.join(f.cwd,'data.txt');fs.writeFileSync(target,'PRESERVE');fs.linkSync(target,path.join(state,'input.ps1'));
 let r=await f.invoke({action:'type_text',text:"中文'a{b}\r\n"}),call=f.calls[0];
 check('legacy input.ps1 hardlink cannot modify its data target',r.status==='ok'&&fs.readFileSync(target,'utf8')==='PRESERVE'&&fs.readFileSync(path.join(state,'input.ps1'),'utf8')==='PRESERVE');
 check('owned input script preserves UTF8 BOM/Unicode/SendKeys escapes and stops on PowerShell errors',call.bytes.slice(0,3).equals(Buffer.from([239,187,191]))&&call.bytes.toString('utf8').includes("$ErrorActionPreference = 'Stop'")&&call.bytes.toString('utf8').includes("中文''a{{}b{}}{ENTER}"));
 check('input uses asynchronous argv runner with bounded output/deadline and cleans exact owned script',call.opts.timeout===30000&&call.opts.maxBuffer===65536&&call.opts.windowsHide&&call.spec.args.includes('-File')&&!fs.existsSync(call.script));
 for(const args of [{action:'click',x:12,y:34},{action:'mouse_move',x:56,y:78},{action:'press_key',key:'ctrl+s'}]){r=await f.invoke(args);const recent=f.calls[f.calls.length-1];check(args.action+' awaits captured native completion and removes only its unique script',r.status==='ok'&&!fs.existsSync(recent.script)&&recent.script!==call.script);}
 f=fixture();f.outcome.r={error:Error('captured exit 7'),stderr:'中文错误',exitCode:7};r=await f.invoke({action:'type_text',text:'x'});
 check('native input failure is explicit error with useful stderr and no success claim',r.status==='error'&&r.text.includes('中文错误')&&!r.text.includes('[OK]')&&!fs.existsSync(f.lastScript));
 f=fixture();const token=f.c.createExecutionControl(5000);token.cancel('pre-cancel');r=await f.invoke({action:'click'},token);token.dispose();
 check('pre-cancelled desktop operation creates no file or native request',r.status==='cancelled'&&f.calls.length===0&&!fs.existsSync(path.join(f.cwd,'.7coder')));
 let cancelled=false;
 f=fixture({writeSync(fd,bytes,offset,len,position){const count=fs.writeSync(fd,bytes,offset,len,position);cancelled=true;return count;}});r=await f.invoke({action:'type_text',text:'x'},()=>cancelled);
 check('cancellation during script writing prevents dispatch and removes the owned file',r.status==='cancelled'&&f.calls.length===0&&fs.readdirSync(path.join(f.cwd,'.7coder')).length===0);
 f=fixture();cancelled=false;f.c.awaitCommandCancellable=async()=>{cancelled=true;return f.outcome;};r=await f.invoke({action:'click'},()=>cancelled);
 check('late completion after cancellation cannot claim successful input and cleans script',r.status==='cancelled'&&r.text.includes('side effects')&&!fs.existsSync(f.lastScript));
 f=fixture({writeSync(){return 0;}});r=await f.invoke({action:'press_key',key:'enter'});
 check('zero-progress script write fails once without spawning or residue',r.status==='error'&&r.text.includes('no progress')&&f.calls.length===0&&fs.readdirSync(path.join(f.cwd,'.7coder')).length===0);
 f=fixture({writeSync(fd,bytes,offset,len,position){return fs.writeSync(fd,bytes,offset,Math.min(7,len),position);}});r=await f.invoke({action:'type_text',text:'短写中文'});
 check('short writes preserve a complete BOM script before dispatch',r.status==='ok'&&f.calls[0].bytes.toString('utf8').includes('短写中文')&&f.calls[0].bytes.toString('utf8').endsWith('Write-Output done\n')&&!fs.existsSync(f.lastScript));
 for(const args of [{action:'type_text',text:'x'.repeat(16385)},{action:'type_text',text:'\n'.repeat(10000)},{action:'press_key',key:'x'.repeat(129)}]){f=fixture();r=await f.invoke(args);check('desktop '+args.action+' budget '+String(args.text||args.key).length+' rejects before script creation',r.status==='error'&&f.calls.length===0&&!fs.existsSync(path.join(f.cwd,'.7coder')));}
 f=fixture();f.c.awaitCommandCancellable=async()=>{const other=path.join(f.cwd,'replacement.tmp');fs.writeFileSync(other,'FOREIGN');fs.renameSync(other,f.lastScript);return f.outcome;};r=await f.invoke({action:'type_text',text:'x'});
 check('cleanup preserves a replaced script and reports a warning plus diagnostic',r.status==='ok'&&r.data.cleanupWarning&&fs.readFileSync(f.lastScript,'utf8')==='FOREIGN'&&f.events.some(e=>e[0]==='desktop-script-cleanup'&&e[2].code==='ETEMPOWNERSHIP'));
 const files=new Map();f=fixture({openSync(file,...args){const fd=fs.openSync(file,...args);files.set(fd,file);return fd;},fstatSync(fd){if(files.has(fd)&&/input-/.test(files.get(fd)))throw Object.assign(Error('fstat denied'),{code:'EACCES'});return fs.fstatSync(fd);},closeSync(fd){files.delete(fd);return fs.closeSync(fd);}});r=await f.invoke({action:'click'});
 check('uncaptured creation identity closes descriptor but preserves unknown residue',r.status==='error'&&files.size===0&&f.calls.length===0&&fs.readdirSync(path.join(f.cwd,'.7coder')).length===1&&f.events.length===1);
 f=fixture({openSync(file,...args){if(/input-/.test(file))throw Object.assign(Error('open denied'),{code:'EACCES'});return fs.openSync(file,...args);}});r=await f.invoke({action:'click'});
 check('script open failure does not spawn or delete an unrelated file',r.status==='error'&&f.calls.length===0&&fs.readdirSync(path.join(f.cwd,'.7coder')).length===0);
 f=fixture();f.image=true;r=await f.invoke({action:'screenshot'});call=f.calls[0];
 check('screenshot dispatch is awaited with finite byte/time budgets and returns captured image',r.status==='ok'&&call.opts.timeout===30000&&call.opts.maxBuffer===65536&&fs.existsSync(call.image));
 check('screenshot PowerShell uses strict errors and disposes both GDI objects in finally',call.code.includes("$ErrorActionPreference = 'Stop'")&&call.code.includes('finally')&&call.code.includes('$gfx.Dispose()')&&call.code.includes('$bmp.Dispose()'));
 f=fixture();f.image=true;cancelled=false;let vision=0;f.c.VISION_MODEL='fixture';f.c.describeWithVision=async()=>{vision++;return {status:'ok',text:'x'};};f.c.awaitCommandCancellable=async()=>{cancelled=true;return f.outcome;};r=await f.invoke({action:'screenshot'},()=>cancelled);
 check('cancelled screenshot preserves useful path but cannot start vision or report ok',r.status==='cancelled'&&vision===0&&r.data.screenshotPath&&fs.existsSync(r.data.screenshotPath));
 f=fixture();f.outcome.r={error:Error('captured screenshot failure'),stderr:'DISPLAY_MISSING'};r=await f.invoke({action:'screenshot'});
 check('screenshot child failure is explicit with stderr and no fake saved result',r.status==='error'&&r.text.includes('DISPLAY_MISSING')&&!r.text.includes('saved'));
 f=fixture();r=await f.invoke({action:'screenshot'});check('zero exit without output file remains screenshot failure',r.status==='error'&&r.text.includes('file was not created'));
 }
 let f=fixture(),oldScript;
 f.c.awaitCommandCancellable=async()=>{const state=path.join(f.cwd,'.7coder'),archive=state+'-original',foreign=path.join(S.runDir,'foreign-'+Math.random());fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'KEEP'),'FOREIGN');fs.renameSync(state,archive);fs.symlinkSync(foreign,state,'junction');oldScript=path.join(archive,path.basename(f.lastScript));return f.outcome;};let r=await f.invoke({action:'click'});
 check('input cleanup revalidates parent after await and preserves moved script/foreign junction target',r.status==='ok'&&r.data.cleanupWarning&&fs.existsSync(oldScript)&&fs.readFileSync(path.join(f.cwd,'.7coder','KEEP'),'utf8')==='FOREIGN');
 f=fixture();f.image=true;let vision=0;f.c.VISION_MODEL='fixture';f.c.describeWithVision=async()=>{vision++;return {status:'ok',text:'x'};};
 f.c.awaitCommandCancellable=async()=>{const shots=path.join(f.cwd,'.7coder','screenshots'),archive=shots+'-original',foreign=path.join(S.runDir,'foreign-'+Math.random());fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'KEEP'),'FOREIGN');fs.renameSync(shots,archive);fs.symlinkSync(foreign,shots,'junction');return f.outcome;};r=await f.invoke({action:'screenshot'});
 check('screenshot cannot consume or send vision from a parent replaced across native await',r.status==='error'&&vision===0&&r.text.includes('parent')&&fs.readFileSync(path.join(f.cwd,'.7coder','screenshots','KEEP'),'utf8')==='FOREIGN');
 console.log('DESKTOP/LIFECYCLE '+checks+'/'+checks+'; captured desktop dispatch only; no real input or screen access');
}finally{S.cleanup();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
