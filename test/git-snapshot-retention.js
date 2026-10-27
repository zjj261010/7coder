const assert=require('assert'),fs=require('fs'),path=require('path'),crypto=require('crypto'),vm=require('vm'),cp=require('child_process');
const S=require('./_shared').create({suite:'git-snapshot-retention'}),source=fs.readFileSync(S.IDX,'utf8');let checks=0;
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
const isolatedConfig=path.join(S.runDir,'git-config');fs.writeFileSync(isolatedConfig,'');
const env={};for(const k of Object.keys(process.env))if(!/^GIT_/i.test(k))env[k]=process.env[k];Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:isolatedConfig,GIT_TERMINAL_PROMPT:'0'});
function gitAt(cwd){return (args,opts)=>cp.execFileSync('git',args,Object.assign({cwd,encoding:'utf8',timeout:10000,env},opts||{}));}
function readRows(c,g,policy){return c.parseOwnedGitSnapshots(g(c.snapshotListArgs(policy)),policy);}
function context(cwd){const warnings=[],c=vm.createContext({fs,path,crypto,process,launchDir:cwd,checkExecution(){},console:{log(){},warn:text=>warnings.push(text)},child_process:{execFileSync:(file,args,opts)=>cp.execFileSync(file,args,Object.assign({},opts,{env}))}});
  const a=source.indexOf('function ownedGitSnapshotPolicy('),b=source.indexOf('// GAP-8: end-of-session token usage',a);assert.ok(a>=0&&b>a);vm.runInContext(source.slice(a,b),c);return {c,warnings};}
(async()=>{
  try{
    const cwd=S.freshCwd('repo 中文 空格'),g=gitAt(cwd);g(['init']);g(['config','user.email','fixture@invalid']);g(['config','user.name','fixture']);g(['config','core.autocrlf','false']);
    fs.writeFileSync(path.join(cwd,'tracked.txt'),'base\n');g(['add','tracked.txt']);g(['commit','-m','base']);
    fs.writeFileSync(path.join(cwd,'tracked.txt'),'staged\n');g(['add','tracked.txt']);fs.writeFileSync(path.join(cwd,'tracked.txt'),'working\n');fs.writeFileSync(path.join(cwd,'untracked.txt'),'untouched\n');
    const staged=g(['diff','--cached','--binary']),head=g(['rev-parse','HEAD']).trim(),{c,warnings}=context(cwd);
    vm.runInContext('Date.now=()=>1700000000000;',c);
    const task=c.ownedGitSnapshotPolicy('task'),sha=await c.recordOwnedGitSnapshotAsync(g,'task');
    check('checkpoint preserves working/index trees and excludes untracked files',g(['show',sha+':tracked.txt'])==='working\n'&&g(['show',sha+'^2:tracked.txt'])==='staged\n'&&!g(['ls-tree','-r','--name-only',sha]).includes('untracked.txt'));
    const first=readRows(c,g,task)[0];await c.recordOwnedGitSnapshotAsync(g,'task');let rows=readRows(c,g,task);
    check('fixed clock creates unique monotonically ordered refs without overwriting first',rows.length===2&&rows.some(r=>r.ref===first.ref)&&new Set(rows.map(r=>r.ref)).size===2&&Math.max(...rows.map(r=>r.stamp))===1700000000001);
    function seed(policy,object,n){let max=Math.max(...readRows(c,g,policy).map(r=>r.stamp));let input='';for(let i=0;i<n;i++)input+='create '+policy.prefix+String(++max).padStart(16,'0')+'-'+i.toString(16).padStart(16,'0')+'-'+object.slice(0,12)+' '+object+'\n';g(['update-ref','--stdin'],{input});}
    const unknown=task.prefix+'not-owned',wrong=task.prefix+'0000000000000000-ffffffffffffffff-'+head.slice(0,12),legacy='refs/7coder/task-snapshots/1700-'+sha.slice(0,12);
    for(const ref of [unknown,wrong,legacy])g(['update-ref',ref,head]);
    const symbolic=task.prefix+'0000000000000001-eeeeeeeeeeeeeeee-'+sha.slice(0,12);g(['update-ref','refs/heads/snapshot-alias-target',sha]);g(['symbolic-ref',symbolic,'refs/heads/snapshot-alias-target']);
    seed(task,sha,53);const beforeMax=Math.max(...readRows(c,g,task).map(r=>r.stamp));await c.recordOwnedGitSnapshotAsync(g,'task');rows=readRows(c,g,task);
    check('actual Git retention keeps exactly 50 newest owned task refs',rows.length===50&&Math.max(...rows.map(r=>r.stamp))===beforeMax+1&&Math.min(...rows.map(r=>r.stamp))===beforeMax-48);
    check('legacy malformed wrong-subject and symbolic refs remain untouched',[unknown,wrong,legacy].every(ref=>g(['rev-parse',ref]).trim()===head)&&g(['symbolic-ref',symbolic]).trim()==='refs/heads/snapshot-alias-target');
    vm.runInContext('Date.now=()=>1600000000000;',c);await c.recordOwnedGitSnapshotAsync(g,'task');rows=readRows(c,g,task);
    check('clock rollback cannot evict the newly recorded task snapshot',rows.length===50&&Math.max(...rows.map(r=>r.stamp))===beforeMax+2);
    const commit=c.ownedGitSnapshotPolicy('commit'),pre=await c.recordOwnedGitSnapshotAsync(g,'commit');seed(commit,pre,51);await c.recordOwnedGitSnapshotAsync(g,'commit');
    check('pre-commit retention has independent namespace and 50-ref budget',readRows(c,g,commit).length===50&&readRows(c,g,task).length===50);
    check('recording and pruning refs never changes HEAD index or worktree',g(['rev-parse','HEAD']).trim()===head&&g(['diff','--cached','--binary'])===staged&&fs.readFileSync(path.join(cwd,'tracked.txt'),'utf8')==='working\n'&&fs.readFileSync(path.join(cwd,'untracked.txt'),'utf8')==='untouched\n');

    const other=S.freshCwd('other worktree');g(['worktree','add','--detach',other,'HEAD']);fs.writeFileSync(path.join(other,'tracked.txt'),'other-worktree\n');const og=gitAt(other),oc=context(other).c,op=oc.ownedGitSnapshotPolicy('task'),os=await oc.recordOwnedGitSnapshotAsync(og,'task');await c.recordOwnedGitSnapshotAsync(g,'task');
    check('another worktree sharing this Git database keeps its own snapshot',op.prefix!==task.prefix&&readRows(oc,og,op).length===1&&g(['show',os+':tracked.txt'])==='other-worktree\n');
    let intercepted=0,victim;
    await c.recordOwnedGitSnapshotAsync((args,opts)=>{if(args[0]==='update-ref'&&args.includes('-d')){intercepted++;victim=args[args.length-1];g(['update-ref','refs/heads/cas-victim',victim]);g(['symbolic-ref',args[args.indexOf('-d')+1],'refs/heads/cas-victim']);assert.ok(args.includes('--no-deref'));}return g(args,opts);},'task');
    check('symbolic-ref race cannot delete a user branch even with matching old OID',intercepted===1&&g(['rev-parse','refs/heads/cas-victim']).trim()===victim&&g(['rev-parse','HEAD']).trim()===head);
    const old=readRows(c,g,task).map(r=>r.ref);let attempts=0;
    const retained=await c.recordOwnedGitSnapshotAsync((args,opts)=>{if(args[0]==='update-ref'&&args.includes('-d')){attempts++;throw Error('DELETE_EACCES');}return g(args,opts);},'task');
    check('delete failure stops after one attempt and retains new/current ref',attempts===1&&warnings.some(s=>s.includes('DELETE_EACCES'))&&old.every(ref=>g(['rev-parse',ref]).trim())&&readRows(c,g,task).some(r=>r.sha===retained&&!old.includes(r.ref)));
    const clean=S.freshCwd('clean');g(['worktree','add','--detach',clean,'HEAD']);const cc=context(clean).c;check('clean workspace creates no synthetic checkpoint',await cc.recordOwnedGitSnapshotAsync(gitAt(clean),'task')==='');
    console.log('GIT/SNAPSHOT '+checks+'/'+checks);
  }finally{S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
