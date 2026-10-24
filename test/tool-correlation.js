const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto'),vm=require('vm');
const {create}=require('./_endpoint'),{harness,settle}=require('./webui-ui-sim');
const S=require('./_shared').create({suite:'tool-correlation'}),sockets=new Set();
let H,fixture,checks=0;
const deadline=setTimeout(()=>{console.error('TOOL/CORRELATION deadline');if(H)H.S.cleanup();S.cleanup();process.exit(1);},15000);
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('UI save deadline');await new Promise(r=>setTimeout(r,5));}}
const ids=['read-a','read-error','read-b','same-prefix-'.repeat(30)+'A','same-prefix-'.repeat(30)+'B'];
const key=id=>id.length<=256?id:'sha256:'+crypto.createHash('sha256').update(id).digest('hex');
(async()=>{
  try{
    const source=fs.readFileSync(S.IDX,'utf8'),a=source.indexOf('function toolCallIdentity('),b=source.indexOf('function makeToolResult(',a);
    assert.ok(a>=0&&b>a);const identity=vm.runInNewContext(source.slice(a,b)+'\ntoolCallIdentity;',{crypto});
    check('missing ID remains explicitly uncorrelated',[null,undefined,1,''].every(id=>identity(id)===null));
    check('ordinary model ID is preserved exactly',identity('call-test')==='call-test');
    check('long IDs have stable distinct bounded digests',identity(ids[3])===key(ids[3])&&identity(ids[4])!==identity(ids[3])&&identity(ids[3]).length===71);
    const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
    fixture=http.createServer((req,res)=>{let raw='';req.setEncoding('utf8');req.on('data',d=>raw+=d);req.on('end',()=>{
      const body=JSON.parse(raw),done=body.messages.some(m=>m.role==='tool'),workflow=body.messages.some(m=>m.content==='WORKFLOW_ID');
      const calls=workflow?[call('workflow-parent','workflow_tool',{steps:[{tool:'read_file',args:{path:'same.txt'}}]})]:ids.map((id,i)=>call(id,'read_file',{path:i===1||i===4?'missing.txt':'same.txt'}));
      const message=done?{role:'assistant',content:'CORRELATED_DONE'}:{role:'assistant',content:null,tool_calls:calls};
      if(body.stream){const delta=Object.assign({},message);if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((tc,index)=>Object.assign({index},tc));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n');}
      else res.end(JSON.stringify({choices:[{message}]}));
    });});
    fixture.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
    H=create({suite:'tool-correlation-agent',endpoint:'http://127.0.0.1:'+fixture.address().port,key:'',model:'fixture',permissionMode:'bypass'});
    const cwd=S.freshCwd('owned');fs.writeFileSync(path.join(cwd,'same.txt'),'identical tool data');await H.start(cwd);
    const read=await H.chat([{role:'user',content:'READ_IDS'}],5000),calls=read.tools.filter(t=>t.type==='call'),results=read.tools.filter(t=>t.type==='result');
    const audit=()=>S.readLog(path.join(cwd,'.7coder','audit.jsonl')).filter(row=>row.type==='tool');
    check('parallel same-name calls and results retain every exact identity',calls.length===5&&results.length===5&&ids.every(id=>calls.filter(c=>c.callId===key(id)).length===1&&results.filter(c=>c.callId===key(id)).length===1));
    check('identical output bodies cannot substitute for another call',results[0].result===results[2].result&&results[0].callId!==results[2].callId);
    check('each SSE identity has exactly one matching authoritative audit row',results.every(result=>{const rows=audit().filter(row=>row.callId===result.callId);return rows.length===1&&rows[0].tool===result.name&&rows[0].status===(result.status==='completed'?'ok':result.status);})&&audit().length===5);
    check('same tool keeps independent success/error status',results.map(r=>r.status).join(',')==='completed,error,completed,completed,error');
    const workflow=await H.chat([{role:'user',content:'WORKFLOW_ID'}],5000);
    check('serial workflow retains parent ID while internal steps are uncorrelated',workflow.tools.length===2&&workflow.tools.every(t=>t.callId==='workflow-parent')&&audit().filter(r=>r.callId==='workflow-parent').length===1&&audit().filter(r=>r.callId===null).length===1);

    function connected(){const ui=harness();for(const route of ['/api/sessions/save','/api/sessions/load'])ui.route(route,async opts=>{const r=await H.api(route,JSON.parse(opts.body));return ui.response(JSON.parse(r.body),r.status);});return ui;}
    const ui=connected();await settle();ui.route('/v1/chat/completions',()=>({ok:true,body:{getReader(){let sent=false;return {read(){if(sent)return Promise.resolve({done:true});sent=true;return Promise.resolve({done:false,value:Buffer.from(read.raw)});}};}}}));
    ui.ids.ta.value='replay correlation events';ui.hook.send();
    await until(()=>ui.hook.history()[1]&&ui.hook.history()[1].status==='ok'&&!ui.hook.saveState().dirty);
    let saved=JSON.parse((await H.api('/api/sessions/load',{file:ui.hook.session()})).body),activities=saved.activities.filter(a=>/^tool_/.test(a.type));
    check('original UI and actual session save/load retain all normalized IDs',activities.length===10&&ids.every(id=>activities.filter(a=>a.callId===key(id)).length===2));
    const loaded=connected();await settle();loaded.hook.load(ui.hook.session());await until(()=>loaded.hook.history()[1]&&loaded.hook.history()[1].status==='ok');loaded.hook.autoSave();await until(()=>!loaded.hook.saveState().dirty);
    saved=JSON.parse((await H.api('/api/sessions/load',{file:loaded.hook.session()})).body);
    check('restoring and re-saving history preserves call identities',saved.activities.filter(a=>/^tool_/.test(a.type)).map(a=>a.callId).join(',')===activities.map(a=>a.callId).join(','));
    console.log('TOOL/CORRELATION '+checks+'/'+checks);
  }finally{clearTimeout(deadline);if(H){await H.stop();H.S.cleanup();}S.cleanup();for(const socket of sockets)socket.destroy();if(fixture)await new Promise(r=>fixture.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
