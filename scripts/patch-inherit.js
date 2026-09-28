const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/index.js';
let s = fs.readFileSync(p, 'utf8');
const NL = /\r?\n/;
let ok = true;

// 1) depth flag
if (!s.includes('workflowStepDepth')) {
  const a1 = 'let agentDepth = 0;';
  if (!s.includes(a1)) { console.error('flag anchor missing'); ok = false; }
  else s = s.replace(a1, a1 + '\n// >0 while workflow_tool inner steps execute: they inherit the plan approval\n// (soft per-step light-model checks are skipped; hard rails stay active).\nlet workflowStepDepth = 0;');
}

// 2) auto block (regex, CRLF tolerant)
if (!s.includes('inheritPlan')) {
  const a2 = /      if \(name === 'workflow_tool'\) \{\r?\n        console\.log\('\[PERM\] workflow auto-approved \(each inner step is still permission-checked\)'\);\r?\n      \} else \{\r?\n        const safe = await isAutoApprovalSafe\(name, args, risk\);\r?\n        if \(!safe\) return `Auto-approval declined by light model\. Risk: \$\{risk\}\.`;\r?\n      \}/;
  if (!a2.test(s)) { console.error('auto block missing'); ok = false; }
  else s = s.replace(a2, [
    "      const inheritPlan = workflowStepDepth > 0 && !protectedWrite;",
    "      if (name === 'workflow_tool') {",
    "        console.log('[PERM] workflow auto-approved (each inner step is still permission-checked)');",
    "      } else if (inheritPlan) {",
    "        console.log('[PERM] workflow inner step inherits plan approval: ' + name);",
    "      } else {",
    "        const safe = await isAutoApprovalSafe(name, args, risk);",
    "        if (!safe) return `Auto-approval declined by light model. Risk: ${risk}.`;",
    "      }"
  ].join('\n'));
}

// 3) default askApproval guard
if (!s.includes('workflow inner step inherits plan approval')) {
  const a3 = /      const approved = await askApproval\(`Execute \$\{name\}\$\{protectedWrite \? ' \(PROTECTED FILE - make sure you really want this\)' : ''\}\? \(y\/n\) `\);\r?\n      if \(!approved\) return 'User declined the tool action\.';/;
  if (!a3.test(s)) { console.error('ask anchor missing'); ok = false; }
  else s = s.replace(a3, [
    "      if (workflowStepDepth > 0 && !protectedWrite) {",
    "        console.log('[PERM] workflow inner step inherits plan approval: ' + name);",
    "      } else {",
    "        const approved = await askApproval(`Execute ${name}${protectedWrite ? ' (PROTECTED FILE - make sure you really want this)' : ''}? (y/n) `);",
    "        if (!approved) return 'User declined the tool action.';",
    "      }"
  ].join('\n'));
}

// 4) depth++/-- in workflow handler
if (!s.includes('workflowStepDepth++')) {
  const a4 = /      for \(let i = 0; i < steps\.length; i\+\+\) \{\r?\n        const st = steps\[i\] \|\| \{\};/;
  if (!a4.test(s)) { console.error('wf loop missing'); ok = false; }
  else s = s.replace(a4, '      workflowStepDepth++;\n      try {\n      for (let i = 0; i < steps.length; i++) {\n        const st = steps[i] || {};');
  const a5 = /(      return finishWf\(null\);\r?\n)(      \})/;
  if (!a5.test(s)) { console.error('wf end missing'); ok = false; }
  else s = s.replace(a5, '$1      } finally { workflowStepDepth--; }\n$2');
}

if (!ok) { process.exit(1); }
fs.writeFileSync(p, s);
const depth = (s.match(/workflowStepDepth/g) || []).length;
console.log('references=' + depth + ' (expect >=5), syntax next');
