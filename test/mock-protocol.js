const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http');
const { pairingValid, requestError } = require('./_protocol');
const S = require('./_shared').create({ suite: 'mock-protocol' });
let checks = 0;
const deadline = setTimeout(() => { console.error('MOCK/PROTOCOL deadline'); S.cleanup(); process.exit(1); }, 15000);
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const user = { role:'user',content:'HELLO' }, call = id => ({id,type:'function',function:{name:'read_file',arguments:'{"path":"note.txt"}'}});
const assistant = ids => ({role:'assistant',content:null,tool_calls:ids.map(call)}), result = id => ({role:'tool',tool_call_id:id,content:'owned-body'});
async function freePort() { const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const n=server.address().port;await new Promise(r=>server.close(r));return n; }
async function ready(mock) { const until=Date.now()+3000;while(true){if(mock.child.exitCode!==null)throw Error('mock exited');try{if((await S.httpReq(mock.port,'GET','/',null)).status===200)return;}catch(e){if(e.code!=='ECONNREFUSED')throw e;}if(Date.now()>until)throw Error('mock startup deadline');await new Promise(r=>setTimeout(r,10));} }
(async()=>{
  try {
    for(const [label,messages,valid] of [
      ['ordinary chat',[user,{role:'assistant',content:'hi'}],true],
      ['single complete',[user,assistant(['a']),result('a')],true],
      ['parallel complete',[user,assistant(['a','b']),result('a'),result('b')],true],
      ['parallel reversed results',[user,assistant(['a','b']),result('b'),result('a')],true],
      ['sequential complete',[user,assistant(['a']),result('a'),assistant(['b']),result('b')],true],
      ['empty',[],false],['null',null,false],['null message',[user,null],false],
      ['missing all',[user,assistant(['a'])],false],
      ['missing sibling',[user,assistant(['a','b']),result('a')],false],
      ['duplicate result',[user,assistant(['a']),result('a'),result('a')],false],
      ['wrong ID',[user,assistant(['a']),result('b')],false],
      ['orphan after text',[user,{role:'assistant',content:'hi'},result('a')],false],
      ['duplicate call',[user,assistant(['a','a']),result('a')],false],
      ['reused ID',[user,assistant(['a']),result('a'),assistant(['a']),result('a')],false],
      ['missing before user',[user,assistant(['a']),user,result('a')],false],
      ['empty ID',[user,assistant(['']),result('')],false]
    ]) check('pairing '+label,pairingValid(messages)===valid);
    const body={model:'main',tools:[{type:'function',function:{name:'read_file'}}],messages:[user,assistant(['a']),result('a')]};
    check('expectation accepts exact model/tools/IDs/content',requestError(body,{model:'main',tools:true,lastUserIncludes:'HELLO',toolIds:['a'],toolResults:{a:'owned-body'}})===null);
    for(const expect of [{model:'other'},{tools:false},{lastUserIncludes:'WRONG'},{toolIds:['b']},{toolResults:{a:'wrong'}}]) check('expectation rejects '+JSON.stringify(expect),!!requestError(body,expect));

    const strict=S.startProcessAt(await freePort(),'mock-server.js',[{expect:{model:'main',tools:false,lastUserIncludes:'HELLO'},reply:'STRICT_HELLO'}],{MOCK_STRICT:'1'});
    await ready(strict);
    const post=body=>S.httpReq(strict.port,'POST','/v1/chat/completions',body);
    let r=await post({messages:[user,assistant(['a','b']),result('a')],model:'main'});
    check('real strict mock rejects missing sibling with HTTP error',r.status===400&&r.body.includes('missing tool results'));
    r=await post({messages:[user],model:'wrong'});
    check('real strict mock rejects wrong model without consuming step',r.status===400&&r.body.includes('unexpected model'));
    r=await post({messages:[user],model:'main'});
    check('valid request still receives unconsumed first step',r.status===200&&r.body.includes('STRICT_HELLO'));
    r=await post({messages:[user],model:'main'});
    check('strict exhausted script errors instead of repeating final answer',r.status===409&&r.body.includes('script exhausted'));
    S.stopMock(strict);

    const legacy=S.startProcessAt(await freePort(),'mock-server.js',['LEGACY_LAST'],{MOCK_STRICT:'0'});await ready(legacy);
    const l1=await S.httpReq(legacy.port,'POST','/v1/chat/completions',{messages:[user]}),l2=await S.httpReq(legacy.port,'POST','/v1/chat/completions',{messages:[user]});
    check('legacy repeat mode remains explicit and available',l1.status===200&&l2.status===200&&l2.body.includes('LEGACY_LAST'));S.stopMock(legacy);

    const fixture=S.startProcessAt(await freePort(),'mock-server.js',[
      {expect:{model:'fixture-main',tools:true,lastUserIncludes:'READ_OWNED'},reply:{role:'assistant',content:null,tool_calls:[call('strict-read')]}},
      {expect:{model:'fixture-main',tools:true,toolIds:['strict-read'],toolResults:{'strict-read':'owned-body'}},reply:'STRICT_AGENT_DONE'}
    ],{MOCK_STRICT:'1'});await ready(fixture);
    const cwd=S.freshCwd('strict-agent');fs.writeFileSync(path.join(cwd,'note.txt'),'owned-body');
    const cli=await S.runCli({port:fixture.port,cwd,args:['--prompt','READ_OWNED'],timeoutMs:5000,env:{HEAVY_MODEL:'fixture-main',LIGHT_MODEL:'',SUMMARY_MODEL:'',PERMISSION_MODE:'bypass',DREAM_ALLOW:'false',ENABLE_RALPH_MODE:'false'}});
    check('actual Agent completes an expected strict tool transcript',cli.code===0&&cli.out.includes('STRICT_AGENT_DONE'));
    const log=S.readLog(fixture.log);
    check('strict Agent has exactly two paired requests and real result',log.length===2&&log.every(r=>pairingValid(r.messages))&&log[1].messages.some(m=>m.tool_call_id==='strict-read'&&m.content.includes('owned-body')));
    S.stopMock(fixture);
    console.log('MOCK/PROTOCOL '+checks+'/'+checks);
  } finally {clearTimeout(deadline);S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
