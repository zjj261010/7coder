const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http'),vm=require('vm'),zlib=require('zlib'),{PassThrough}=require('stream');
const {create}=require('./_endpoint'),{loadContext}=require('./download-commit'),S=require('./_shared').create({suite:'model-response-budget'}),sockets=new Set();
const source=fs.readFileSync(S.IDX,'utf8'),policy=source.match(/^const MODEL_RESPONSE_MAX_BYTES = .*;$/m)[0];
const a=source.indexOf('function parseSSEStream('),b=source.indexOf('async function callOpenAI(',a);
const parse=vm.runInNewContext(policy+'\n('+source.slice(a,b)+')',{Buffer}),limit=8*1024*1024;
let H,fixture,checks=0;const counts=new Map(),closed=new Set();
const deadline=setTimeout(()=>{console.error('MODEL/RESPONSE deadline');if(H)H.S.cleanup();S.cleanup();process.exit(1);},30000);
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
const frame=delta=>'data: '+JSON.stringify({choices:[{delta}]})+'\n\n';
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('socket close deadline');await new Promise(r=>setTimeout(r,5));}}
async function badStream(parts){const stream=new PassThrough(),promise=parse(stream,()=>{},()=>{}).then(()=>null,e=>e);setImmediate(()=>{for(const part of parts){if(stream.destroyed)break;stream.write(part);}if(!stream.destroyed)stream.end();});const error=await promise;await new Promise(r=>setImmediate(r));return {stream,error};}
(async()=>{
  try{
    check('shared response policy remains 8MiB',vm.runInNewContext(policy+'\nMODEL_RESPONSE_MAX_BYTES;')===limit);
    for(const [label,parts]of [['unterminated ASCII',['x'.repeat(limit+1)]],['UTF8 byte budget',['中'.repeat(Math.floor(limit/3)+1)]],['cumulative reasoning',[frame({reasoning_content:'x'.repeat(limit/2)}),frame({reasoning_content:'y'.repeat(limit/2)})]]]){
      const r=await badStream(parts);check(label+' stops before unbounded buffering and clears listeners',r.error&&r.error.message.includes('8MiB budget')&&r.stream.destroyed&&['data','end','error','close','aborted'].every(name=>r.stream.listenerCount(name)===0));
    }
    const tail=frame({content:'OK'})+'data: [DONE]\n\n',padding=':'+ 'x'.repeat(limit-Buffer.byteLength(tail)-2)+'\n';
    const boundary=new PassThrough(),answer=parse(boundary,()=>{});setImmediate(()=>boundary.end(padding+tail));check('exactly 8MiB valid response remains accepted',(await answer).message.content==='OK');
    fixture=http.createServer((req,res)=>{let raw='';req.setEncoding('utf8');req.on('data',d=>raw+=d);req.on('end',()=>{
      const body=JSON.parse(raw),task=Array.isArray(body.messages[0].content)?'VISION_BIG':body.messages.filter(m=>m.role==='user').slice(-1)[0].content;
      counts.set(task,(counts.get(task)||0)+1);req.socket.once('close',()=>closed.add(task));
      if(task==='SMALL'){if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame({content:'RECOVERED_SMALL'})+'data: [DONE]\n\n');}else res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'RECOVERED_SMALL'}}]}));return;}
      if(task==='SSE_NO_NL'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+'x'.repeat(limit+1024));return;}
      if(task==='SSE_TOOLS'){
        res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frame({tool_calls:[{index:0,id:'budget-write',type:'function',function:{name:'write_file',arguments:'{"path":"must-not-write.txt","content":"'}}]}));
        for(let i=0;i<129;i++)res.write(frame({tool_calls:[{index:0,function:{arguments:'x'.repeat(65536)}}]}));res.end(frame({tool_calls:[{index:0,function:{arguments:'"}'}}]})+'data: [DONE]\n\n');return;
      }
      const payload=JSON.stringify({choices:[{message:{role:'assistant',content:'x'.repeat(limit+1024),tool_calls:[{id:'budget-write',type:'function',function:{name:'write_file',arguments:'{"path":"must-not-write.txt","content":"bad"}'}}]}}]});
      res.setHeader('Content-Type','application/json');if(task==='GZIP_BIG'){res.setHeader('Content-Encoding','gzip');res.end(zlib.gzipSync(payload));}else res.end(payload);
    });});fixture.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+fixture.address().port;H=create({suite:'model-response-agent',endpoint:base,key:'',model:'fixture',permissionMode:'bypass'});
    const cwd=S.freshCwd('owned');await H.start(cwd);
    for(const task of ['JSON_BIG','GZIP_BIG','SSE_NO_NL','SSE_TOOLS']){
      const body={messages:[{role:'user',content:task}]};
      if(task.startsWith('SSE'))await assert.rejects(H.chat(body.messages,5000),/model response exceeds 8MiB budget/);
      else await assert.rejects(H.api('/v1/chat/completions',body,5000),/model response exceeds 8MiB budget/);
      await until(()=>closed.has(task));const info=JSON.parse((await H.api('/api/info')).body);
      check('actual '+task+' fails once, closes upstream and executes no tools',counts.get(task)===1&&!fs.existsSync(path.join(cwd,'must-not-write.txt'))&&S.readLog(path.join(cwd,'.7coder','audit.jsonl')).every(row=>row.type!=='tool')&&info.runtime.activeTasks===0&&info.runtime.activeTools===0);
    }
    const c=loadContext(source,S.freshCwd('vision'),{},{Buffer,VISION_MODEL:'fixture',resolveModelConfig:()=>({endpoint:base,apiKey:''}),authHeadersFor:()=>({})});
    const v=source.indexOf('async function describeWithVision('),end=source.indexOf('// GAP-4: read a screenshot',v);vm.runInContext(source.slice(v,end),c);
    const vision=await c.describeWithVision('fixture-image',null,null);await until(()=>closed.has('VISION_BIG'));
    check('direct vision helper also bounds buffered model response',vision.status==='error'&&vision.text.includes('maxContentLength')&&counts.get('VISION_BIG')===1);
    const small=await H.chat([{role:'user',content:'SMALL'}],5000);check('same Agent recovers next model request after budget failures',small.content==='RECOVERED_SMALL'&&counts.get('SMALL')===1);
    console.log('MODEL/RESPONSE '+checks+'/'+checks);
  }finally{clearTimeout(deadline);if(H){await H.stop();H.S.cleanup();}S.cleanup();for(const socket of sockets)socket.destroy();if(fixture)await new Promise(r=>fixture.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
