'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),cp=require('child_process'),{EventEmitter}=require('events'),{PassThrough,Writable}=require('stream');
const S=require('./_shared').create({suite:'mcp-call-result'}),root=path.dirname(S.IDX),source=fs.readFileSync(S.IDX,'utf8'),clients=[],children=[];let checks=0,serializations=0,actual=false,active;
const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
process.once('exit',()=>{if(checks!==30){console.error('MCP/CALL-RESULT incomplete '+checks+'/30');process.exitCode=1;}});
function cut(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const limit=4*1024*1024,child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;let reply;
child.stdin=new Writable({write(bytes,encoding,callback){const request=JSON.parse(bytes.toString());callback();if(request.id!==undefined)setImmediate(()=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:reply})+'\n'));}});
const owner=require(path.join(root,'lib','process-owner')).create(cp,root);
const c=vm.createContext({Buffer,process,path,console:{warn(){},log(){}},launchDir:S.runDir,APP_VERSION:'fixture',MCP_MAX_FRAME_BYTES:limit,MCP_CALL_TIMEOUT:5000,mcpClients:{},mcpServers:{peer:{}},setTimeout,clearTimeout,setInterval,clearInterval,
  EXECUTION_TIMEOUT_MS:5000,resolveCommandOnWindows:()=>false,JSON:{parse:JSON.parse,stringify(value){serializations++;return JSON.stringify(value);}},
  child_process:Object.assign({},owner,{spawn(file,args,opts){if(!actual)return child;const native=owner.spawn(file,args,opts);children.push(native);native.on('error',()=>{});if(native.pid)fs.appendFileSync(S.manifest,native.pid+'\t'+S.runDir+'\n');return native;}})});
vm.runInContext(cut('function executionCancelledError(','function parseSSEStream(')+cut('function mcpContentToText(','// A2-19:')+cut('function createMcpStdioClient(','function getMcpClient(')+
  cut('// OPT-13: pilot tools carry authoritative status','// Central choke point')+
  'async function tool(args){const name="mcp_tool",cancelled=null;\n'+cut("  if (name === 'mcp_tool') {","  if (name === 'mcp_list_tools_tool') {")+'\n}',c);
c.getMcpClient=()=>active;
const deadline=setTimeout(()=>{console.error('MCP/CALL-RESULT deadline');for(const native of children)if(native.exitCode==null&&native.signalCode==null)native.kill();process.exit(1);},20000);
(async()=>{try{
  for(const invalid of [null,[],'',{}, {content:null},{content:'text'},{content:{}},{content:[],isError:'false'}]){
    assert.throws(()=>c.mcpContentToText(invalid),e=>e.code==='MCP_PROTOCOL_ERROR'&&/result unknown/.test(e.message));check('invalid method result '+JSON.stringify(invalid)+' cannot become empty success',true);
  }
  for(const invalid of [null,'text',[],{}, {type:''},{type:'text',text:7}]){
    assert.throws(()=>c.mcpContentToText({content:[invalid]}),e=>e.code==='MCP_PROTOCOL_ERROR');check('invalid content block '+JSON.stringify(invalid)+' cannot be formatted as successful data',true);
  }
  check('legitimate empty content remains a successful empty result',c.mcpContentToText({content:[],isError:false})==='');
  check('valid UTF8 text and separators preserve the actual tool output',c.mcpContentToText({content:[{type:'text',text:'中文😀'},{type:'text',text:''},{type:'text',text:'end'}]})==='中文😀\n\nend');
  const block={type:'resource',resource:{uri:'file:///owned',text:'resource'}};
  check('non-text extension/resource blocks retain their bounded compact JSON representation',c.mcpContentToText({content:[block]})===JSON.stringify(block));
  let before=serializations;assert.throws(()=>c.mcpContentToText({content:Array(4097).fill({type:'text',text:''})}),e=>e.code==='MCP_RESULT_BUDGET');
  check('content count limit is checked before large parts arrays or stringify',serializations===before);
  assert.throws(()=>c.mcpContentToText({content:[{type:'text',text:'x'.repeat(limit)},{type:'text',text:''}]}),e=>e.code==='MCP_RESULT_BUDGET');check('separator bytes also count toward total formatted output budget',true);
  check('exact formatted text byte boundary remains accepted',c.mcpContentToText({content:[{type:'text',text:'x'.repeat(limit)}]}).length===limit);
  let deep={};for(let i=0;i<65;i++)deep={next:deep};before=serializations;
  assert.throws(()=>c.mcpContentToText({content:[{type:'custom',data:deep}]}),e=>e.code==='MCP_RESULT_BUDGET');check('deep non-text content fails preflight before recursive native stringify',serializations===before);
  const wire='{"type":"custom","data":['+'1e20,'.repeat(89999)+'1e20],"description":"'+'x'.repeat(2300000)+'"}',expanded=JSON.parse(wire);before=serializations;
  assert.throws(()=>c.mcpContentToText({content:[expanded]}),e=>e.code==='MCP_RESULT_BUDGET');check('parsed numeric expansion cannot allocate formatted JSON beyond 4MiB',Buffer.byteLength(wire)<limit&&serializations===before);

  active=c.createMcpStdioClient('peer',{});clients.push(active);active.initialized=true;
  reply={};let result=await c.tool({server:'peer',tool_name:'echo'});check('actual tool branch marks a valid envelope with missing content as error/unknown',result.status==='error'&&/result unknown/.test(result.text));
  reply={content:[]};result=await c.tool({server:'peer',tool_name:'echo'});check('actual tool branch preserves valid empty success',result.status==='ok'&&result.text==='');
  reply={content:[{type:'text',text:'plain failure'}],isError:true};result=await c.tool({server:'peer',tool_name:'echo'});check('well-formed isError result stays a normal failed tool response',result.status==='error'&&result.text.includes('plain failure'));
  reply={content:[{type:'text',text:'恢复'}]};result=await c.tool({server:'peer',tool_name:'echo'});check('same session remains usable after malformed result and remote error',result.status==='ok'&&result.text==='恢复'&&!active.dead);
  active.dispose();await new Promise(r=>setImmediate(r));check('method-result failures leave no fake pending/frame/write reservations',c.mcpBudgetSnapshot().pending===0&&c.mcpBudgetSnapshot().incomingBytes===0&&c.mcpBudgetSnapshot().queuedBytes===0);

  if(process.platform!=='win32')throw Error('actual method-result peer requires Windows owner');actual=true;
  const script=path.join(S.freshCwd('method result'),'peer.js');fs.writeFileSync(script,`let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let at;while((at=buf.indexOf('\\n'))>=0){const q=JSON.parse(buf.slice(0,at));buf=buf.slice(at+1);if(q.id===undefined)continue;const result=q.params.name==='invalid'?null:{content:[{type:'text',text:'REAL-RECOVERY中文'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}});`);
  active=c.createMcpStdioClient('native',{command:S.NODE_BIN,args:[script]});clients.push(active);active.initialized=true;
  result=await c.tool({server:'peer',tool_name:'invalid'});check('real owned peer null result produces a failed tool result rather than empty success',result.status==='error'&&/result unknown/.test(result.text)&&!active.dead);
  result=await c.tool({server:'peer',tool_name:'echo'});check('same actual peer returns correct complete content after the malformed response',result.status==='ok'&&result.text==='REAL-RECOVERY中文');
  const closed=new Promise(r=>active.child.once('close',r));active.dispose();await closed;
  check('actual malformed/recovered calls and shutdown restore native and MCP counters',active.child.ownedTree.closed&&owner.processOwnerInfo().active===0&&c.mcpBudgetSnapshot().pending===0&&c.mcpBudgetSnapshot().queuedBytes===0);
  console.log('MCP/CALL-RESULT 30/30; parsed/fake/actual owned results; no model/desktop/download activity');
}finally{clearTimeout(deadline);for(const client of clients)client.dispose();for(const native of children)if(native.exitCode==null&&native.signalCode==null)native.kill();for(const native of children)if(native.exitCode==null&&native.signalCode==null)await new Promise(r=>native.once('close',r));S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
