const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http'),vm=require('vm');
const {create}=require('./_endpoint'),S=require('./_shared').create({suite:'tool-batch'}),sockets=new Set();
let H,fixture,checks=0;
const deadline=setTimeout(()=>{console.error('TOOL/BATCH deadline');if(H)H.S.cleanup();S.cleanup();process.exit(1);},15000);
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
const call=(id,name='write_file',args={path:'must-not-write.txt',content:'unexpected'})=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
(async()=>{
  try{
    const src=fs.readFileSync(S.IDX,'utf8'),a=src.indexOf('async function processWithTools('),b=src.indexOf('// ====================== TASK CHANGE SUMMARY',a);
    assert.ok(a>=0&&b>a);const loop=src.slice(src.indexOf('function checkExecution('),src.indexOf('function watchExecution('))+src.slice(a,b);
    for(const [label,message]of [
      ['missing message',null],['non-array tool_calls',{role:'assistant',tool_calls:'bad'}],
      ['65-call round',{role:'assistant',tool_calls:Array.from({length:65},(_,i)=>call('c'+i))}],
      ['late null call',{role:'assistant',tool_calls:[call('first'),null]}],
      ['duplicate IDs',{role:'assistant',tool_calls:[call('same'),call('same')]}],
      ['missing ID',{role:'assistant',tool_calls:[call('first'),{function:{name:'write_file',arguments:'{}'}}]}],
      ['bad function name',{role:'assistant',tool_calls:[call('first'),{id:'bad',function:{name:1,arguments:'{}'}}]}],
      ['non-string arguments',{role:'assistant',tool_calls:[call('first'),{id:'bad',function:{name:'write_file',arguments:{}}}]}]
    ]){
      let dispatched=0,notified=0;
      const c=vm.createContext({MAX_TOOL_STEPS:2,HEAVY_MODEL:'fixture',createModelContext:main=>({main}),compressConversationIfNeeded:async()=>{},callOpenAI:async()=>({message}),safeExecuteTool:async()=>{dispatched++;},READ_ONLY_TOOLS:new Set(),capToolResult:String});
      vm.runInContext(loop,c);const messages=[{role:'user',content:'owned task'}];
      await assert.rejects(c.processWithTools(messages,{onToolCall:()=>notified++}),/Invalid assistant response|Tool batch rejected/);
      check(label+' is rejected before every dispatch/notification/history append',dispatched===0&&notified===0&&messages.length===1);
    }
    let round=0,executed=0;
    const c=vm.createContext({MAX_TOOL_STEPS:2,HEAVY_MODEL:'fixture',createModelContext:main=>({main}),compressConversationIfNeeded:async()=>{},callOpenAI:async()=>({message:round++?{role:'assistant',content:'done'}:{role:'assistant',tool_calls:Array.from({length:64},(_,i)=>call('r'+i,'read_file',{path:'same.txt'}))}}),safeExecuteTool:async()=>{executed++;return 'result';},READ_ONLY_TOOLS:new Set(['read_file']),capToolResult:String});
    vm.runInContext(loop,c);const history=[{role:'user',content:'boundary'}];await c.processWithTools(history);
    check('64-call boundary preserves all parallel results and IDs',executed===64&&history.filter(m=>m.role==='tool').map(m=>m.tool_call_id).join(',')===Array.from({length:64},(_,i)=>'r'+i).join(','));

    fixture=http.createServer((req,res)=>{let raw='';req.setEncoding('utf8');req.on('data',d=>raw+=d);req.on('end',()=>{
      const body=JSON.parse(raw),task=body.messages.find(m=>m.role==='user').content,done=body.messages.some(m=>m.role==='tool');
      let calls;
      if(task==='OVERSIZED')calls=Array.from({length:65},(_,i)=>call('w'+i));
      else if(task==='LATE_BAD')calls=[call('first'),{id:'bad',function:{name:1,arguments:'{}'}}];
      else if(task==='DUPLICATE')calls=[call('same'),call('same')];
      else if(task==='BAD_JSON'){const bad=call('parse','read_file');bad.function.arguments='{';calls=[bad];}
      else calls=Array.from({length:64},(_,i)=>call('r'+i,'read_file',{path:'same.txt'}));
      res.end(JSON.stringify({choices:[{message:done?{role:'assistant',content:'BATCH_RECOVERED'}:{role:'assistant',content:null,tool_calls:calls}}]}));
    });});fixture.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
    H=create({suite:'tool-batch-agent',endpoint:'http://127.0.0.1:'+fixture.address().port,key:'',model:'fixture',permissionMode:'bypass'});
    const cwd=S.freshCwd('owned');fs.writeFileSync(path.join(cwd,'same.txt'),'owned');await H.start(cwd);
    const chat=task=>H.api('/v1/chat/completions',{messages:[{role:'user',content:task}]},5000);
    for(const task of ['OVERSIZED','LATE_BAD','DUPLICATE']){
      await assert.rejects(chat(task),/Tool batch rejected/);
      const info=JSON.parse((await H.api('/api/info')).body);
      check('real '+task+' leaves no tool writes/audit and recovers task state',!fs.existsSync(path.join(cwd,'must-not-write.txt'))&&S.readLog(path.join(cwd,'.7coder','audit.jsonl')).every(row=>row.type!=='tool')&&info.runtime.activeTasks===0&&info.runtime.activeTools===0);
    }
    const success=await chat('BOUNDARY'),audit=S.readLog(path.join(cwd,'.7coder','audit.jsonl')).filter(row=>row.type==='tool');
    check('same real Agent completes 64 calls after all rejected rounds',success.body.includes('BATCH_RECOVERED')&&audit.length===64&&new Set(audit.map(row=>row.callId)).size===64&&audit.every(row=>row.status==='ok'));
    await chat('BAD_JSON');const parse=S.readLog(path.join(cwd,'.7coder','audit.jsonl')).find(row=>row.callId==='parse');
    check('malformed JSON strings retain per-tool error compatibility',parse&&parse.status==='error'&&parse.result.startsWith('Parse error:'));
    console.log('TOOL/BATCH '+checks+'/'+checks);
  }finally{clearTimeout(deadline);if(H){await H.stop();H.S.cleanup();}S.cleanup();for(const socket of sockets)socket.destroy();if(fixture)await new Promise(r=>fixture.close(r));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
