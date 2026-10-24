// Negative controls execute the original runner/reporting code with explicit
// fixture outcomes. They do not replace the real D/I regression scenarios.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const S = require('./_shared').create({ suite: 'review-oracles' });
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
(async () => {
  try {
    const script = path.join(S.runDir, 'report-owned.js');
    fs.writeFileSync(script, `const S=require(${JSON.stringify(path.resolve(__dirname,'_shared.js'))}).create({suite:'report'});
const mode=process.argv[2];
if(mode==='mixed'){S.record('real assertion',true);S.info('context');S.skip('unavailable branch','fixture reason');S.finish(Date.now());}
if(mode==='failed'){S.record('real assertion',false,'fixture failure');S.info('context');S.skip('unavailable branch');S.finish(Date.now());}
if(mode==='info'){S.info('context only');S.finish(Date.now());}
if(mode==='disabled'){S.runAll([{name:'disabled',enabled:()=>false,fn:()=>{throw Error('must not run')}}]);}
if(mode==='nomatch'){S.runAll([{name:'actual',fn:()=>S.record('must not run',true)}]);}
`);
    for (const [mode, exit, expected] of [
      ['mixed',0,['1/1 passed','1 checks skipped','1 information items']],
      ['failed',1,['0/1 passed','1 checks skipped','1 information items']],
      ['info',1,['no assertions executed']],
      ['disabled',0,['0/0 passed','1 scenarios skipped','not counted as PASS']],
      ['nomatch',1,['no assertions executed','RUN_ONLY']]
    ]) {
      const r = S.spawnSync(S.NODE_BIN, [script,mode], { encoding:'utf8', env:Object.assign({},process.env,{RUN_ONLY:mode==='nomatch'?'unmatched':''}) });
      check('report ' + mode + ' has truthful exit/counts', r.status === exit && !r.error && expected.every(text=>r.stdout.includes(text)) && !/^PASS  (context|unavailable)/m.test(r.stdout));
    }
    const source = fs.readFileSync(path.join(__dirname,'runner-d.js'),'utf8');
    for (const mode of ['complete','empty','missing','duplicate','duplicate-call','leak','no-final']) {
      let captured, sequence=0; const logs=new Map(), results=[];
      const fake = Object.assign({}, S, {
        runAll: scenarios => captured=scenarios,
        record: (name,pass,detail) => results.push({name,pass:!!pass,detail}),
        freshCwd: name => S.freshCwd(mode+'-'+name),
        startProcessAt: (port,file,script) => {
          const id=sequence++, messages=[];
          for(const step of script) if(step.tool_calls){
            messages.push(step);
            for(const tc of step.tool_calls) messages.push({role:'tool',tool_call_id:tc.id,content:'Tool error: Security: Path traversal blocked'});
          }
          if(id===0){
            const pos=messages.findIndex(m=>m.role==='tool'&&m.tool_call_id==='x3');
            if(mode==='empty') messages.splice(0,messages.length);
            if(mode==='missing') messages.splice(pos,1);
            if(mode==='duplicate') messages.splice(pos,0,Object.assign({},messages[pos]));
            if(mode==='duplicate-call') messages.push(messages.find(m=>m.role==='assistant'&&m.tool_calls[0].id==='x3'));
            if(mode==='leak') messages[pos].content='Tool error: OUTSIDE-BAIT';
          }
          logs.set(id,[{messages}]); return {port,log:id};
        },
        readLog: id=>logs.get(id)||[],
        tr: (log,id)=>{const matches=log.flatMap(r=>r.messages).filter(m=>m.role==='tool'&&m.tool_call_id===id);return matches.length?{id,c:String(matches[0].content)}:null;},
        stopMock:()=>{},
        runCli: async()=>({code:0,out:mode==='no-final'?'RESERVED-DONE':'TORTURE-DONE RESERVED-DONE'})
      });
      const context=vm.createContext({require:name=>name==='./_shared'?{create:()=>fake}:require(name),console:{log(){}},setTimeout:fn=>fn()});
      vm.runInContext(source,context);
      await captured.find(sc=>sc.name==='torture').fn();
      const completion=results.find(r=>r.name.includes('completed every call ID'));
      check('original D oracle rejects ' + mode + ' faults correctly', mode==='complete' ? results.length===9&&results.every(r=>r.pass) :
        mode==='leak' ? results.some(r=>r.name.includes('dotdot inside')&&!r.pass) : completion&&!completion.pass);
    }
    console.log('REVIEW/ORACLES '+checks+'/'+checks);
  } finally { S.cleanup(); }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
