'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),cp=require('child_process'),http=require('http');
const S=require('./_shared').create({suite:'mcp-launch-integration'}),root=path.dirname(S.IDX),source=fs.readFileSync(S.IDX,'utf8'),clients=[],children=[];let checks=0;
const scope=process.env.MCP_LAUNCH_SCOPE||'all';assert.ok(['all','batch-tail'].includes(scope),'known MCP launch integration scope');const expected=scope==='all'?8:5;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==expected){console.error('MCP/LAUNCH-NATIVE incomplete '+checks+'/'+expected);process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+7000;while(Date.now()<end){const value=await fn();if(value)return value;await pause(15);}throw Error('owned launcher phase deadline');}
function ping(port){return new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port,timeout:200},res=>{res.resume();res.on('end',()=>resolve(true));});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
async function stop(client,file,heart){const closed=new Promise(r=>client.child.once('close',r));client.dispose();await closed;const info=JSON.parse(fs.readFileSync(file));await until(async()=>!await ping(info.port));const bytes=fs.statSync(heart).size;await pause(100);return bytes===fs.statSync(heart).size;}
const deadline=setTimeout(()=>{console.error('MCP/LAUNCH-NATIVE deadline');for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();process.exit(1);},25000);
(async()=>{try{
  if(process.platform!=='win32')throw Error('MCP launch integration requires Windows');
  const cwd=S.freshCwd('MCP launcher 中文'),exeCwd=path.join(cwd,'exe child cwd'),batchCwd=path.join(cwd,'batch child cwd');
  fs.mkdirSync(exeCwd);fs.mkdirSync(batchCwd);fs.mkdirSync(path.join(exeCwd,'bin'));fs.mkdirSync(path.join(batchCwd,'shims'));
  fs.copyFileSync(S.NODE_BIN,path.join(exeCwd,'bin','fixture-interpreter.exe'));
  const script=path.join(cwd,'server & 中文.js');
  fs.writeFileSync(script,`const fs=require('fs'),http=require('http');http.createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',function(){fs.writeFileSync(process.env.MCP_INFO,JSON.stringify({port:this.address().port}));});setInterval(()=>fs.appendFileSync(process.env.MCP_HEART,'x'),20);let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;const result=q.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),case:process.env.MCP_CASE})}]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`);
  const owner=require(path.join(root,'lib','process-owner')).create(cp,root),environment=Object.assign({},process.env),originalPath=process.env.PATH;
  for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];environment.Path=path.join(exeCwd,'bin')+';'+originalPath;environment.MCP_CASE='PARENT';
  const seen=[],context=vm.createContext({Buffer,fs,path,setTimeout,clearTimeout,console:{warn(){}},process:{platform:'win32',execPath:S.NODE_BIN,env:environment,cwd:()=>cwd,stderr:{writableLength:0}},
    APP_VERSION:'fixture',launchDir:cwd,MCP_MAX_FRAME_BYTES:4*1024*1024,MCP_CALL_TIMEOUT:5000,mcpClients:{},checkExecution(){},watchExecution:()=>()=>{},executionCancelledError:()=>Error('cancelled'),
    child_process:{spawn(command,args,options){
      // A regression must fail BEFORE shell interpretation of literal data.
      if(command==='fixture-interpreter')assert.strictEqual(options.shell,false,'native fixture must never enter cmd');
      seen.push({command,options});const child=owner.spawn(command,args,options);children.push(child);child.on('error',()=>{});if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');return child;
    }}});
  vm.runInContext(cut('function serializeModelRequest(','function checkExecution(')+cut('function mcpContentToText(','// A2-19:')+cut('function resolveCommandOnWindows(','// Redact secrets'),context);
  if(scope==='all'){
  const firstFile=path.join(cwd,'exe-info.json'),firstHeart=path.join(cwd,'exe-heart.txt');fs.writeFileSync(firstHeart,'');
  const literal=['value & FIXTURE_NOT_A_COMMAND','100%7CODER_TEST_UNSET% ! ^ | < >','空格 a b "quote" \\'];
  const first=context.createMcpStdioClient('native',{command:'fixture-interpreter',args:[script].concat(literal),cwd:exeCwd,env:{pAtH:'bin',mcp_case:'CHILD',MCP_INFO:firstFile,MCP_HEART:firstHeart}});clients.push(first);
  const actual=JSON.parse(await first.callTool('echo',{})),spawn=seen[0];
  check('bare native executable uses effective relative PATH without shell and replaces environment case aliases',spawn.options.shell===false&&spawn.options.env.pAtH==='bin'&&!('Path'in spawn.options.env)&&!('MCP_CASE'in spawn.options.env));
  check('actual Unicode/space/script/metacharacter arguments arrive literally at the child',JSON.stringify(actual.argv)===JSON.stringify(literal)&&actual.cwd===exeCwd&&actual.case==='CHILD');
  check('native MCP close removes its actual listener and heartbeat',await stop(first,firstFile,firstHeart)&&first.child.ownedTree.closed&&owner.processOwnerInfo().active===0);
  }

  // Like npm-generated shims, keep the batch body ASCII. Unicode belongs in
  // %~dp0's expansion, not an unmarked UTF8 file consumed under cmd's codepage.
  const shim=path.join(batchCwd,'shims','fixture-shim.cmd');fs.copyFileSync(script,path.join(batchCwd,'shims','server.js'));
  fs.writeFileSync(shim,'@echo off\r\n"%~dp0..\\..\\exe child cwd\\bin\\fixture-interpreter.exe" "%~dp0server.js"\r\n');
  const batchFile=path.join(cwd,'batch-info.json'),batchHeart=path.join(cwd,'batch-heart.txt');fs.writeFileSync(batchHeart,'');
  const batch=context.createMcpStdioClient('batch',{command:'fixture-shim',cwd:batchCwd,env:{PATH:'shims',MCP_CASE:'BATCH',MCP_INFO:batchFile,MCP_HEART:batchHeart}});clients.push(batch);
  let batchText;try{batchText=await batch.callTool('echo',{});}catch(error){throw Error(error.message+'; peer stderr: '+batch.stderrTail);}
  const batchActual=JSON.parse(batchText),batchSpawn=seen.find(entry=>entry.command==='fixture-shim');
  check('batch shim found only in configured child PATH retains explicit cmd fallback',batchSpawn.options.shell===true&&batchSpawn.options.env.PATH==='shims'&&!('Path'in batchSpawn.options.env));
  check('actual offline shim starts successfully with child cwd and environment',batchActual.argv.length===0&&batchActual.cwd===batchCwd&&batchActual.case==='BATCH');
  const closed=await stop(batch,batchFile,batchHeart),stats=context.mcpBudgetSnapshot();
  check('batch process tree and all MCP reservations settle before next launch',closed&&batch.child.ownedTree.closed&&owner.processOwnerInfo().active===0&&stats.pending===0&&stats.incomingBytes===0&&stats.queuedBytes===0);
  let missing;try{context.createMcpStdioClient('missing',{command:'fixture-never-installed-71',cwd:batchCwd,env:{PATH:'missing'}});}catch(error){missing=error;}
  check('missing command remains explicit ENOENT with zero native target records',missing&&missing.code==='ENOENT'&&owner.processOwnerInfo().active===0&&owner.processOwnerInfo().pending===0);
  const api=require('../lib/process-owner');check('production native material and actual parent PATH remain unchanged',api.validateInstallation(root).sha256===api.validateInstallation(path.resolve(__dirname,'..')).sha256&&process.env.PATH===originalPath);
  console.log('MCP/LAUNCH-NATIVE '+checks+'/'+expected+'; scope='+scope+'; actual owned interpreter copy and offline batch shim; no Python/npx/download/user config changes');
}finally{clearTimeout(deadline);for(const client of clients)client.dispose();for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();for(const child of children)if(child.exitCode==null&&child.signalCode==null)await new Promise(r=>child.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
