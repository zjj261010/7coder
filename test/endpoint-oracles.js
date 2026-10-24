// Exercise K/R against owned local fixtures only. Expected runner failures
// below are negative controls, not external model evaluations.
const assert=require('assert'),path=require('path'),http=require('http');
const {parseSSE,workflowObserved,request}=require('./_endpoint');
const S=require('./_shared').create({suite:'endpoint-oracles'}),sockets=new Set(),servers=[];
let checks=0,mode='workflow',mainRequests=[],secondRequests=[];
const deadline=setTimeout(()=>{console.error('ENDPOINT/ORACLES deadline');S.cleanup();process.exit(1);},30000);
function check(label,ok,detail){assert.ok(ok,label+(detail?'\n'+detail:''));checks++;console.log('PASS '+label);}
const event=delta=>'data: '+JSON.stringify({model:'fixture-main',choices:[{delta}]})+'\n\n';
async function server(handler){const s=http.createServer(handler);servers.push(s);s.on('connection',c=>{sockets.add(c);c.on('close',()=>sockets.delete(c));});await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port;}
async function runner(file,only,extra){
  const child=S.spawn(S.NODE_BIN,[path.join(__dirname,file)],{cwd:S.runDir,env:Object.assign({},process.env,{REAL_TEST:'1',RUN_ONLY:only,NODE_BIN:S.NODE_BIN,OPENAI_ENDPOINT:mainEndpoint,OPENAI_API_KEY:'fixture-key',REAL_MODEL:'fixture-main',REAL_PERM:'bypass',REAL_SECOND_MODEL:'',REAL_SECOND_ENDPOINT:'',REAL_SECOND_API_KEY:''},extra||{})});
  let out='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',t=>out=(out+t).slice(-16000));child.stderr.on('data',t=>out=(out+t).slice(-16000));
  await new Promise(r=>child.once('close',r));return {code:child.exitCode,out};
}
let mainEndpoint;
(async()=>{
  try{
    if(process.env.ENDPOINT_ORACLE_PHASE!=='integration'){
    if(process.env.ENDPOINT_ORACLE_PHASE!=='workflow'){
    check('SSE captures content/reasoning and requires DONE',parseSSE(event({content:'你好',reasoning:'think'})+'data: [DONE]\n\n').content==='你好');
    for(const [label,body]of [['arbitrary error text','data: {"error":{"message":"rate limit reached"}}\n\ndata: [DONE]\n\n'],['missing DONE',event({content:'partial'})],['malformed JSON','data: {broken}\n\ndata: [DONE]\n\n'],['missing delta','data: {"choices":[]}\n\ndata: [DONE]\n\n']]){
      assert.throws(()=>parseSSE(body));check('SSE rejects '+label,true);
    }
    }
    const evidenceArgs={steps:'[object Object],[object Object]'},tools=[{type:'call',name:'workflow_tool',args:evidenceArgs},{type:'result',name:'workflow_tool',status:'completed',result:'[OK] Workflow complete\nstep 1 (write_file): Written: wf.txt\nstep 2 (read_file):      1\tWF-RAN'}];
    check('workflow evidence accepts exact call and completed data',workflowObserved({tools}));
    for(const [label,wrong]of [['file without call',[]],['failed workflow',[tools[0],Object.assign({},tools[1],{status:'error'})]],['unrelated workflow',[tools[0],Object.assign({},tools[1],{result:'[OK] Workflow complete\nstep 1 (write_file): Written: other.txt\nstep 2 (read_file): WF-RAN'})]],['ambiguous workflows',[...tools,...tools]]])check('workflow evidence rejects '+label,!workflowObserved({tools:wrong}));
    if(process.env.ENDPOINT_ORACLE_PHASE==='workflow'){console.log('ENDPOINT/ORACLES '+checks+'/'+checks);return;}
    const transport=await server((q,res)=>{if(q.url==='/bad'){res.writeHead(401);res.end('denied');}else if(q.url==='/hung'){}else{res.writeHead(200);res.write('partial');res.destroy();}});
    for(const route of ['/bad','/hung','/abort']){await assert.rejects(request(transport,route,null,100));check('HTTP transport rejects '+route,true);}
    }
    const args={steps:[{tool:'write_file',args:{path:'wf.txt',content:'WF-RAN'}},{tool:'read_file',args:{path:'wf.txt'}}]};
    const modelHandler=list=>(req,res)=>{let raw='';req.setEncoding('utf8');req.on('data',d=>raw+=d);req.on('end',()=>{
      const body=JSON.parse(raw);list.push(body);let message={role:'assistant',content:'5'};
      if(mode!=='routing'){
        const done=body.messages.some(m=>m.role==='tool');
        if(done)message={role:'assistant',content:mode.includes('fix')?'FIXED-MARK-OK':'WF complete'};
        else{
          const tool=mode==='workflow'?'workflow_tool':'write_file';
          const a=mode==='workflow'?args:mode.includes('fix')?{path:'broken.js',content:'console.log("'+(mode==='fix'?'FIXED-MARK-OK':'BROKEN-MARK')+'")'}:{path:'wf.txt',content:'WF-RAN'};
          message={role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:tool,arguments:JSON.stringify(a)}}]};
        }
      }
      if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});const delta=Object.assign({},message);if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((t,index)=>Object.assign({index},t));res.end(event(delta)+'data: [DONE]\n\n');}
      else res.end(JSON.stringify({choices:[{message}]}));
    });};
    mainEndpoint='http://127.0.0.1:'+await server(modelHandler(mainRequests));
    const secondEndpoint='http://127.0.0.1:'+await server(modelHandler(secondRequests));
    let r=await runner('runner-k.js','real-workflow');check('actual K accepts real workflow events/effects',r.code===0&&r.out.includes('1/1 passed'),r.out);
    mode='direct';r=await runner('runner-k.js','real-workflow');check('actual K fails direct-write impostor despite same file',r.code===1&&r.out.includes('0/1 passed'),r.out);
    mode='fix';r=await runner('runner-k.js','real-fix');check('actual K verifies requested repaired output',r.code===0&&r.out.includes('2/2 passed'),r.out);
    mode='bad-fix';r=await runner('runner-k.js','real-fix');check('actual K rejects merely fixing syntax with old output',r.code===1&&r.out.includes('repaired program'));
    mode='routing';mainRequests.length=0;secondRequests.length=0;
    r=await runner('runner-r.js','r5',{REAL_SECOND_MODEL:'fixture-second',REAL_SECOND_ENDPOINT:secondEndpoint});
    check('actual R5 selects profile endpoint and outbound second model',r.code===0&&r.out.includes('1/1 passed')&&mainRequests.length===0&&secondRequests.length===1&&secondRequests[0].model==='fixture-second',r.out);
    secondRequests.length=0;r=await runner('runner-r.js','r5');check('R5 without second model is skip with no model calls',r.code===0&&r.out.includes('0/0 passed')&&r.out.includes('1 checks skipped')&&mainRequests.length===0&&secondRequests.length===0);
    for(const file of ['runner-k.js','runner-r.js']){r=await runner(file,'',{REAL_TEST:'0'});check(file+' only opts in for exact REAL_TEST=1',r.code===0&&r.out.includes('SKIPPED')&&!r.out.includes('isolated run'));}
    console.log('ENDPOINT/ORACLES '+checks+'/'+checks);
  }finally{clearTimeout(deadline);S.cleanup();for(const c of sockets)c.destroy();for(const s of servers)await new Promise(r=>s.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
