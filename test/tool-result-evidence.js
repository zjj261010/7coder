const assert=require('assert'),{resultForCall,auditMatches}=require('./_protocol');let count=0;
function check(label,ok){assert.ok(ok,label);count++;console.log('PASS '+label);}
const outputs=[{callId:'a',name:'read_file',result:'same text',status:'completed'},{callId:'b',name:'read_file',result:'same text',status:'error'}];
const audits=[{callId:'b',tool:'read_file',status:'error'},{callId:'a',tool:'read_file',status:'ok'}];
check('same-name identical bodies remain distinct by ID',resultForCall(outputs,'a').status==='completed'&&resultForCall(outputs,'b').status==='error');
check('audit order does not determine correlation',auditMatches(outputs,audits));
check('crossed statuses with same name and text cannot pass',!auditMatches(outputs,[{callId:'a',tool:'read_file',status:'error'},{callId:'b',tool:'read_file',status:'ok'}]));
check('missing and duplicate result IDs cannot match',!resultForCall(outputs,'missing')&&!resultForCall([...outputs,outputs[0]],'a'));
check('missing audit fails even if another call has required status',!auditMatches(outputs,[audits[1]]));
check('duplicate audit cannot satisfy exactly-once evidence',!auditMatches(outputs,[...audits,audits[0]]));
check('duplicate SSE result cannot satisfy exactly-once evidence',!auditMatches([...outputs,outputs[0]],audits));
check('zero results and uncorrelated fields cannot prove success',!auditMatches([],[])&&!auditMatches([{name:'read_file',status:'completed'}],[{tool:'read_file',status:'ok'}]));
check('unrelated internal workflow rows do not substitute or invalidate matching roots',auditMatches(outputs,[...audits,{callId:null,tool:'read_file',status:'error'}]));
check('mismatched tool and missing status fail',!auditMatches([{...outputs[0],name:'write_file'}],[audits[1]])&&!auditMatches([{...outputs[0],status:undefined}],[audits[1]]));
console.log('TOOL/EVIDENCE '+count+'/'+count);
