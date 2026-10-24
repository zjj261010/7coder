const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm');
const {loadContext}=require('./download-commit'),S=require('./_shared').create({suite:'read-window'});
const source=fs.readFileSync(S.IDX,'utf8');let checks=0;
function check(label,ok){assert.ok(ok,label);checks++;console.log('PASS '+label);}
function context(name,extra){const cwd=S.freshCwd(name),io={bytes:0,reads:0,opened:[],closed:[]};
  const overrides={open(file,flags,cb){fs.open(file,flags,(e,fd)=>{if(!e)io.opened.push(fd);cb(e,fd);});},read(fd,buffer,offset,length,position,cb){io.reads++;fs.read(fd,buffer,offset,length,position,(e,n,b)=>{io.bytes+=n||0;cb(e,n,b);});},close(fd,cb){fs.close(fd,e=>{if(!e)io.closed.push(fd);cb(e);});}};
  const c=loadContext(source,cwd,Object.assign(overrides,extra||{}),{Buffer});
  const a=source.indexOf("  if (name === 'read_file') {"),b=source.indexOf("  if (name === 'write_file') {",a);assert.ok(a>=0&&b>a);
  vm.runInContext('async function read(args,cancelled=null){const name="read_file";\n'+source.slice(a,b)+'\n}',c);
  return {cwd,c,io,file:(name,bytes)=>{const file=path.join(cwd,name);fs.writeFileSync(file,bytes);return file;}};
}
const closed=f=>f.io.opened.length===f.io.closed.length&&f.io.opened.every(fd=>{try{fs.fstatSync(fd);return false;}catch(e){return e.code==='EBADF';}});
(async()=>{
  try{
    let f=context('small');f.file('small.txt','alpha\nbeta\n');
    let r=await f.c.read({path:'small.txt'});check('small full read preserves numbering and trailing empty line',r.status==='ok'&&r.text==='     1\talpha\n     2\tbeta\n     3\t');
    r=await f.c.read({path:'small.txt',offset:2,limit:1});check('finite line window preserves exact numbering',r.text==='     2\tbeta');
    r=await f.c.read({path:'small.txt',offset:99});check('actual EOF reports exact line count',r.text==='(offset 99 is beyond EOF - the file has 3 line(s))');
    f.file('empty','');check('empty-file contract unchanged',(await f.c.read({path:'empty'})).text==='(empty file)');
    f.file('binary',Buffer.from([0,1,2]));check('initial binary probe remains explicit',(await f.c.read({path:'binary'})).text.startsWith('[BINARY] binary looks binary'));
    check('normal/empty/binary/EOF paths all close actual handles',closed(f));

    for(const character of ['中','😀']){
      f=context('boundary-'+character);f.file('utf8.txt','x'.repeat(65535)+character+'\n第二行\r\n');
      r=await f.c.read({path:'utf8.txt',offset:2,limit:1});check('UTF8 '+character+' split across chunks is lossless',r.status==='ok'&&r.text==='     2\t第二行\r'&&f.io.reads===2&&closed(f));
    }
    for(const [label,bytes]of [['GBK',Buffer.from([0xd6,0xd0,0xce,0xc4])],['truncated',Buffer.from([0xe4,0xb8])],['late NUL',Buffer.concat([Buffer.from('a'.repeat(5000)),Buffer.from([0])])]]){
      f=context(label);const file=f.file('bad',bytes);r=await f.c.read({path:'bad'});check(label+' errors without replacement or byte changes',r.status==='error'&&r.text.includes('Unsupported text encoding')&&fs.readFileSync(file).equals(bytes)&&closed(f));
    }
    f=context('giant-line');f.file('line.txt','a'.repeat(300000));r=await f.c.read({path:'line.txt'});
    check('giant selected line stops before whole-file allocation',r.status==='ok'&&r.text.includes('output budget exhausted')&&r.text.includes('DO NOT rewrite')&&r.text.length<=30000&&f.io.bytes===65536&&closed(f));
    const high=await f.c.readUtf8Window(path.join(f.cwd,'line.txt'),{path:'line.txt'},null,1000000);
    check('large configured result still has physical 128KiB view limit',high.length<=128*1024&&high.includes('output budget exhausted'));

    f=context('large-window');const large=path.join(f.cwd,'large.txt'),fd=fs.openSync(large,'w'),block=Buffer.alloc(65536,97);block.write('first\n',0);
    fs.writeSync(fd,block);fs.ftruncateSync(fd,100*1024*1024);fs.closeSync(fd);
    r=await f.c.read({path:'large.txt',offset:1,limit:1});check('100MiB file early window reads only one chunk; unscanned tail stays unknown',r.text==='     1\tfirst'&&f.io.bytes===65536&&closed(f));
    f=context('scan-cap');const big=path.join(f.cwd,'big.txt'),writer=fs.openSync(big,'w'),million=Buffer.alloc(1024*1024,97);
    for(let i=0;i<17;i++)fs.writeSync(writer,million);fs.closeSync(writer);let ticked=false;setImmediate(()=>ticked=true);
    r=await f.c.read({path:'big.txt',offset:2,limit:1});check('skipped giant line obeys 16MiB scan cap without false EOF',r.status==='ok'&&r.text.includes('16MiB scan budget exhausted')&&!r.text.includes('beyond EOF')&&f.io.bytes===16*1024*1024&&ticked&&closed(f));

    let stopped=false,opened;
    f=context('cancel',{read(fd,buffer,offset,length,position,cb){opened=fd;fs.read(fd,buffer,offset,length,position,(e,n,b)=>{stopped=true;cb(e,n,b);});}});f.file('x','owned');r=await f.c.read({path:'x'},()=>stopped);
    assert.throws(()=>fs.fstatSync(opened),/EBADF/);check('cancellation after real read closes fd and returns cancelled',r.status==='cancelled'&&f.io.closed.length===1);
    f=context('io-error',{read(fd,buffer,offset,length,position,cb){setImmediate(()=>cb(Object.assign(Error('READ_FAULT'),{code:'EIO'})));}});f.file('x','owned');r=await f.c.read({path:'x'});check('read failure closes fd and is not success',r.status==='error'&&r.text.includes('READ_FAULT')&&closed(f));
    f=context('close-error',{close(fd,cb){fs.close(fd,()=>cb(Object.assign(Error('CLOSE_FAULT'),{code:'EIO'})));}});f.file('x','owned');r=await f.c.read({path:'x'});check('close failure prevents a successful view',r.status==='error'&&r.text.includes('CLOSE_FAULT'));
    let changed=false;
    f=context('changed',{read(fd,buffer,offset,length,position,cb){fs.read(fd,buffer,offset,length,position,(e,n,b)=>{if(!changed){changed=true;fs.appendFileSync(path.join(f.cwd,'x'),'changed');}cb(e,n,b);});}});f.file('x','owned');r=await f.c.read({path:'x'});check('detected file changes discard mixed/stale view',r.status==='error'&&r.text.includes('file changed during read')&&closed(f));
    f=context('directory');r=await f.c.read({path:'.'});check('non-regular inputs fail before opening a reader',r.status==='error'&&r.text.includes('regular file')&&f.io.opened.length===0);
    console.log('READ/WINDOW '+checks+'/'+checks);
  }finally{S.cleanup();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
