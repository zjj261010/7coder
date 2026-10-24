// Opt-in endpoint evaluation. RUN_ONLY selects r1..r5; absent REAL_TEST=1
// performs no setup or network IO. Offline fixture checks are not model evals.
const fs=require('fs'),path=require('path');
if(process.env.REAL_TEST!=='1'){console.log('SUITE R SKIPPED: set REAL_TEST=1 to opt in to real endpoints.');process.exit(0);}
const {create}=require('./_endpoint');
const EP=process.env.OPENAI_ENDPOINT||'https://maas.qianwenaiapi.com/compatible-mode/v1',KEY=process.env.OPENAI_API_KEY||'',MODEL=process.env.REAL_MODEL||'qwen3.7-plus';
const H=create({suite:'R (REAL)',endpoint:EP,key:KEY,model:MODEL}),{S}=H;
const {record,freshCwd,spawnSync,NODE_BIN}=S;
const scenarios=[];
function scenario(name,fn){scenarios.push({name,fn:async()=>{try{await fn();}finally{await H.stop();}}});}
scenario('r1',async()=>{
  const cwd=freshCwd('r1');await H.start(cwd);
  await H.chat([{role:'user',content:'Create fib.js exporting fib(n) computing Fibonacci (fib(0)=0, fib(1)=1) iteratively. Create test-fib.js that prints fib(0) through fib(10) as "fib(N) = result". Run the test and report the output.'}],300000);
  const impl=path.join(cwd,'fib.js'),test=path.join(cwd,'test-fib.js');
  record('R1: both files created',fs.existsSync(impl)&&fs.existsSync(test));
  record('R1: iterative implementation present',fs.existsSync(impl)&&/for|while/.test(fs.readFileSync(impl,'utf8')));
  if(fs.existsSync(test)){
    const run=spawnSync(NODE_BIN,[test],{cwd,encoding:'utf8',timeout:15000});
    record('R1: generated test exits zero with expected example',run.status===0&&run.stdout.includes('fib(10) = 55'),String(run.stdout).slice(0,100));
    const independent=spawnSync(NODE_BIN,['-e','const assert=require("assert"),m=require("./fib.js");const f=m.fib||m;[0,1,1,2,3,5,8,13,21,34,55].forEach((n,i)=>assert.strictEqual(f(i),n));'],{cwd,encoding:'utf8',timeout:15000});
    record('R1: independent fixed assertions verify every value',independent.status===0,independent.stderr);
  }else record('R1: generated test passes independently',false,'test-fib.js missing');
});
scenario('r2',async()=>{
  await H.start(freshCwd('r2'));
  const hist=[{role:'user',content:'My favorite color is crimson, my lucky number is 42, and my cat is named Pixel. Just acknowledge briefly.'}];
  const a1=await H.chat(hist,180000);hist.push({role:'assistant',content:a1.content},{role:'user',content:'What are all three things I told you? Answer in one line.'});
  const a2=await H.chat(hist,180000);hist.push({role:'assistant',content:a2.content},{role:'user',content:'Now write a haiku that mentions all three things.'});
  const a3=await H.chat(hist,180000);
  const recalls=text=>/crimson/i.test(text)&&/42/.test(text)&&/pixel/i.test(text);
  record('R2: turn 2 recalls all three facts',recalls(a2.content),a2.content);
  record('R2: requested poem mentions all three facts',recalls(a3.content),a3.content);
  S.info('R2: reasoning lengths (not a model-quality pass)',[a1.reasoning.length,a2.reasoning.length,a3.reasoning.length].join(','));
});
scenario('r3',async()=>{
  const cwd=freshCwd('r3');await H.start(cwd);
  const reply=await H.chat([{role:'user',content:'Create counter.txt with the single line "count: 0". Read it back and tell me what it says.'}],300000);
  const file=path.join(cwd,'counter.txt');
  record('R3: counter content correct',fs.existsSync(file)&&fs.readFileSync(file,'utf8').trim()==='count: 0');
  record('R3: read tool actually completes with expected data',reply.tools.some(t=>t.type==='result'&&t.name==='read_file'&&t.status==='completed'&&String(t.result).includes('count: 0')));
});
scenario('r4',async()=>{
  await H.start(freshCwd('r4'));const r=await H.chat([{role:'user',content:'请用中文写一个关于编程的短句，不超过20个字。'}],180000);
  record('R4: nonempty Chinese answer without replacement chars',/[\u3400-\u9fff]/.test(r.content)&&!r.content.includes('\uFFFD'),r.content);
  record('R4: reasoning contains no replacement chars',!r.reasoning.includes('\uFFFD'));
});
scenario('r5',async()=>{
  const second=(process.env.REAL_SECOND_MODEL||'').trim();
  if(!second||second.toLowerCase()===MODEL.toLowerCase()){S.skip('R5: second model evaluation','set REAL_SECOND_MODEL to a distinct available model');return;}
  const cwd=freshCwd('r5');fs.mkdirSync(path.join(cwd,'.7coder'));
  const profiles=Object.create(null);profiles[second]={endpoint:process.env.REAL_SECOND_ENDPOINT||EP,apiKey:process.env.REAL_SECOND_API_KEY===undefined?KEY:process.env.REAL_SECOND_API_KEY};
  fs.writeFileSync(path.join(cwd,'.7coder','models.json'),JSON.stringify(profiles));await H.start(cwd);
  const r=await H.chat([{role:'user',content:'What is 2+3? Answer with just the number.'}],180000,second);
  record('R5: explicitly selected second model responds',r.models.length>0&&r.models.every(model=>model===second)&&r.content.trim()==='5','models='+r.models.join(',')+' reply='+r.content);
});
S.runAll(scenarios);
