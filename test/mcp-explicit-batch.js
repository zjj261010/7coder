'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),cp=require('child_process');
const S=require('./_shared').create({suite:'mcp-explicit-batch'}),root=path.dirname(S.IDX),source=fs.readFileSync(S.IDX,'utf8'),clients=[],children=[];let checks=0;
const expected=7;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==expected){console.error('MCP/EXPLICIT-BATCH incomplete '+checks+'/'+expected);process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const deadline=setTimeout(()=>{console.error('MCP/EXPLICIT-BATCH deadline');for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();process.exit(1);},20000);
(async()=>{try{
  if(process.platform!=='win32')throw Error('explicit managed batch fixture requires Windows');
  const cwd=S.freshCwd('explicit batch 中文'),batch=path.join(cwd,'entry & 中文.cmd'),marker=path.join(cwd,'ran.txt'),owner=require(path.join(root,'lib','process-owner')).create(cp,root);
  const script=path.join(cwd,'server.js');
  fs.writeFileSync(script,`const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)},'x');let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;const result=q.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})}]}:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`);
  fs.copyFileSync(S.NODE_BIN,path.join(cwd,'fixture-node.exe'));
  fs.writeFileSync(batch,'@echo off\r\n"%~dp0fixture-node.exe" "%~dp0server.js" %*\r\n');
  const seen=[],c=vm.createContext({Buffer,fs,path,process,launchDir:cwd,APP_VERSION:'fixture',MCP_MAX_FRAME_BYTES:4*1024*1024,MCP_CALL_TIMEOUT:5000,mcpClients:{},setTimeout,clearTimeout,console:{warn(){}},
    checkExecution(){},watchExecution:()=>()=>{},executionCancelledError:()=>Error('cancelled'),child_process:{spawn(file,args,opts){seen.push({file,args,opts});const child=owner.spawn(file,args,opts);children.push(child);child.on('error',()=>{});if(child.pid)fs.appendFileSync(S.manifest,child.pid+'\t'+S.runDir+'\n');return child;}}});
  vm.runInContext(cut('function mcpContentToText(','// A2-19:')+cut('function resolveCommandOnWindows(','// Redact secrets'),c);
  const args=['space 中文','value & FIXTURE_NOT_A_COMMAND','literal!^()|<>'];
  const client=c.createMcpStdioClient('explicit',{command:batch,args,cwd});clients.push(client);
  const actual=JSON.parse(await client.callTool('echo',{}));
  check('explicit Unicode/space/metacharacter batch path uses owned cmd with delayed expansion disabled',/cmd\.exe$/i.test(seen[0].file)&&seen[0].opts.shell===false&&seen[0].opts.windowsVerbatimArguments===true&&seen[0].args.includes('/v:off'));
  check('supported explicit-batch data arrives literally instead of becoming cmd operators',JSON.stringify(actual.argv)===JSON.stringify(args)&&actual.cwd===cwd&&fs.readFileSync(marker,'utf8')==='x');
  const closed=new Promise(r=>client.child.once('close',r));client.dispose();await closed;
  check('explicit batch wrapper and target close under the same strict owned Job',client.child.ownedTree.closed&&owner.processOwnerInfo().active===0&&c.mcpBudgetSnapshot().pending===0);
  const starts=seen.length;
  for(const cfg of [{command:batch,args:['bad%PATH%']},{command:batch,args:['bad"quote']},{command:batch,args:['bad\nline']},{command:batch.replace('entry & 中文','entry%PATH%')}]){
    assert.throws(()=>c.createMcpStdioClient('refused',Object.assign({cwd},cfg)),/batch.*unsupported|unsupported.*batch/i);
  }
  check('unrepresentable percent/quote/newline data is refused before any new process',seen.length===starts&&fs.readFileSync(marker,'utf8')==='x');
  const relative=path.basename(batch),next=c.createMcpStdioClient('relative',{command:'.\\'+relative,cwd});clients.push(next);const relativeResult=JSON.parse(await next.callTool('echo',{}));
  check('explicit relative batch resolves against actual child cwd',relativeResult.argv.length===0&&relativeResult.cwd===cwd&&fs.readFileSync(marker,'utf8')==='xx');
  const nextClose=new Promise(r=>next.child.once('close',r));next.dispose();await nextClose;const counters=c.mcpBudgetSnapshot();
  check('all explicit/relative/refused paths restore request and owner counts',owner.processOwnerInfo().active===0&&owner.processOwnerInfo().pending===0&&counters.pending===0&&counters.queuedBytes===0&&counters.incomingBytes===0);
  const material=require('../lib/process-owner');check('production native ownership material is unchanged',material.validateInstallation(root).sha256===material.validateInstallation(path.resolve(__dirname,'..')).sha256);
  console.log('MCP/EXPLICIT-BATCH 7/7; actual offline shim and stable Job ownership; no arbitrary external command or download');
}finally{clearTimeout(deadline);for(const client of clients)client.dispose();for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();for(const child of children)if(child.exitCode==null&&child.signalCode==null)await new Promise(r=>child.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
