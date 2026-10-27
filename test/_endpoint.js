// Shared transport/lifecycle for explicitly opted-in real-endpoint runners.
// Offline tests may point it at a private local fixture; that is not a model eval.
const http = require('http');
function parseSSE(body) {
  let content = '', reasoning = '', done = false; const tools = [], models = new Set();
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const text = line.slice(5).trim();
    if (text === '[DONE]') { done = true; continue; }
    if (!text) continue;
    const event = JSON.parse(text);
    if (event.error) throw Error(event.error.message || String(event.error));
    const delta = event.choices && event.choices[0] && event.choices[0].delta;
    if (!delta || typeof delta !== 'object') throw Error('Malformed Agent SSE delta');
    if (event.model) models.add(event.model);
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    if (delta.tool_call) tools.push({ type:'call', ...delta.tool_call });
    if (delta.tool_result) tools.push({ type:'result', ...delta.tool_result });
  }
  if (!done) throw Error('Agent SSE ended without DONE');
  return {content,reasoning,tools,models:Array.from(models),raw:body};
}
function request(port, route, body, timeout = 180000) {
  return new Promise((resolve,reject)=>{
    let settled=false, response, timer;
    const data=body===null?null:JSON.stringify(body);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){if(response)response.destroy();req.destroy();reject(error);}else resolve(value);};
    const req=http.request({host:'127.0.0.1',port,path:route,method:data===null?'GET':'POST',headers:data===null?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
      response=res;res.setEncoding('utf8');let text='',bytes=0;
      res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>16*1024*1024){finish(Error('Agent response exceeds 16MiB test budget'));return;}text+=chunk;});
      res.on('error',finish);res.on('aborted',()=>finish(Error('Agent response aborted')));
      res.on('end',()=>{if(res.statusCode!==200)finish(Error('Agent HTTP '+res.statusCode+': '+text.slice(0,300)));else finish(null,{status:res.statusCode,body:text});});
      res.on('close',()=>{if(!res.complete)finish(Error('Agent response closed early'));});
    });
    req.on('error',finish);timer=setTimeout(()=>finish(Error('Agent request deadline exceeded')),timeout);req.end(data);
  });
}
function create(options) {
  const S=require('./_shared').create({suite:options.suite});
  let child=null,port=null,output='';const closed=new WeakSet();
  async function stop() {
    if(!child)return;const owned=child;child=null;
    if(closed.has(owned))return;
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned Agent close unconfirmed')),5000);owned.once('close',()=>{clearTimeout(timer);resolve();});if(owned.exitCode===null&&owned.signalCode===null)owned.kill();});
  }
  async function start(cwd) {
    await stop();output='';
    const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));port=probe.address().port;await new Promise(r=>probe.close(r));
    child=S.spawn(S.NODE_BIN,[S.IDX,'--server'],{cwd,env:Object.assign({},process.env,{
      OPENAI_API_KEY:options.key,OPENAI_ENDPOINT:options.endpoint,HEAVY_MODEL:options.model,LIGHT_MODEL:options.model,SUMMARY_MODEL:options.model,
      MAX_RETRIES:'2',MAX_TOKENS:'4000',PERMISSION_MODE:options.permissionMode||process.env.REAL_PERM||'auto',HTTP_PORT:String(port),HTTP_BIND:'127.0.0.1',HTTP_API_KEY:'',
      DREAM_ALLOW:'false',ENABLE_RALPH_MODE:'false',AUDIT_LOG:'true'
    })});
    const current=child;current.once('close',()=>closed.add(current));
    for(const stream of [child.stdout,child.stderr]){stream.setEncoding('utf8');stream.on('data',text=>output=(output+text).slice(-8192));}
    const end=Date.now()+15000;
    while(Date.now()<end){
      if(child.exitCode!==null||child.signalCode!==null)throw Error('Agent exited before ready: '+output);
      try{const r=await request(port,'/api/info',null,500);JSON.parse(r.body);return;}catch(e){if(e.code!=='ECONNREFUSED'&&!/deadline exceeded/.test(e.message))throw e;}
      await new Promise(r=>setTimeout(r,20));
    }
    throw Error('Agent readiness deadline: '+output);
  }
  return {S,start,stop,get port(){return port;},api:(route,body=null,timeout)=>request(port,route,body,timeout),request:(body,timeout)=>request(port,'/v1/chat/completions',body,timeout),
    chat:async(messages,timeout,model)=>parseSSE((await request(port,'/v1/chat/completions',Object.assign({stream:true,messages},model?{model}:{}),timeout)).body)};
}
function workflowObserved(parsed) {
  const calls=parsed.tools.filter(t=>t.type==='call'&&t.name==='workflow_tool'), results=parsed.tools.filter(t=>t.type==='result'&&t.name==='workflow_tool');
  // SSE audit previews stringify arrays as [object Object]. Verify the
  // actual workflow step transcript instead of inventing structured args.
  const text=results.length===1?String(results[0].result):'';
  return calls.length===1&&results.length===1&&results[0].status==='completed'&&text.startsWith('[OK] Workflow complete\n')&&
    /^step 1 \(write_file\): Written: wf\.txt\r?$/m.test(text)&&/^step 2 \(read_file\):[^\r\n]*\bWF-RAN\s*$/m.test(text);
}
module.exports={create,request,parseSSE,workflowObserved};
