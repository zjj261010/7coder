const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/index.js';
let s = fs.readFileSync(p, 'utf8');
// handler may already be inserted by the previous partial run? check
const hasHandler = s.includes('nested workflows are not allowed');
if (!hasHandler) {
  const hAnchor = "  if (name === 'synthetic_output_tool') {";
  if (!s.includes(hAnchor)) { console.error('handler anchor missing'); process.exit(1); }
  const handler = [
    "  // Workflow tool: sequential JSON step plan executed through the normal",
    "  // permission system. No recursion; unknown tools and malformed steps are",
    "  // reported per-step instead of crashing the batch.",
    "  if (name === 'workflow_tool') {",
    "    const steps = Array.isArray(args.steps) ? args.steps : null;",
    "    if (!steps || steps.length === 0) return 'Workflow error: steps must be a non-empty array';",
    "    if (steps.length > 50) return 'Workflow error: too many steps (max 50)';",
    "    const transcript = [];",
    "    const finishWf = (stopReason) => {",
    "      const head = stopReason ? ('[STOPPED] ' + stopReason) : '[OK] Workflow complete';",
    "      return head + '\\n' + transcript.join('\\n');",
    "    };",
    "    for (let i = 0; i < steps.length; i++) {",
    "      const st = steps[i] || {};",
    "      const toolName = typeof st.tool === 'string' ? st.tool.trim() : '';",
    "      if (!toolName) {",
    "        transcript.push('step ' + (i + 1) + ': ERROR - missing tool name');",
    "        if (!st.optional) return finishWf('step ' + (i + 1) + ' has no tool name');",
    "        continue;",
    "      }",
    "      if (toolName === 'workflow_tool') {",
    "        transcript.push('step ' + (i + 1) + ' (' + toolName + '): ERROR - nested workflows are not allowed');",
    "        return finishWf('nested workflow at step ' + (i + 1));",
    "      }",
    "      if (!tools.some(t => t.function.name === toolName)) {",
    "        transcript.push('step ' + (i + 1) + ' (' + toolName + '): ERROR - unknown tool');",
    "        if (!st.optional) return finishWf('unknown tool at step ' + (i + 1));",
    "        continue;",
    "      }",
    "      const stepArgs = (st.args && typeof st.args === 'object' && !Array.isArray(st.args)) ? st.args : {};",
    "      const res = await safeExecuteTool({ function: { name: toolName, arguments: JSON.stringify(stepArgs) } }, conversation);",
    "      const firstLine = String(res).split('\\n')[0];",
    "      transcript.push('step ' + (i + 1) + ' (' + toolName + '): ' + firstLine.substring(0, 160));",
    "      if (!st.optional && /^(?:\\[ERROR\\]|BLOCKED|Tool error|Parse error|Read error|Write error|Edit error|Workflow error)/.test(String(res))) {",
    "        transcript.push('(stopped after failed step ' + (i + 1) + ')');",
    "        return finishWf('step ' + (i + 1) + ' failed');",
    "      }",
    "    }",
    "    return finishWf(null);",
    "  }",
    "",
    "  if (name === 'synthetic_output_tool') {"
  ].join('\n');
  s = s.replace(hAnchor, handler);
  console.log('handler inserted');
} else console.log('handler already present');
// risk
if (!s.includes("workflow_tool: 'HIGH'")) {
  s = s.replace("      task_create_tool: 'HIGH', mcp_tool: 'HIGH'", "      task_create_tool: 'HIGH', mcp_tool: 'HIGH', workflow_tool: 'HIGH'");
  console.log('risk added');
} else console.log('risk already');
// explain
if (!s.includes('workflow_tool: (a)')) {
  const explOld = '  agent_tool: (a) => `Spawn sub-agent "${a.name}" with task: ${String(a.task || \'\').substring(0, 60)}`\n};';
  if (!s.includes(explOld)) { console.error('explain anchor missing'); process.exit(1); }
  s = s.replace(explOld, '  agent_tool: (a) => `Spawn sub-agent "${a.name}" with task: ${String(a.task || \'\').substring(0, 60)}`,\n  workflow_tool: (a) => `Run a ${Array.isArray(a.steps) ? a.steps.length : \'?\'-step tool workflow`\n};'.replace("'?'-step", "'?' + '-step"));
  console.log('explain added');
} else console.log('explain already');
fs.writeFileSync(p, s);
console.log('final: handler=' + s.includes('nested workflows are not allowed') + ' risk=' + s.includes("workflow_tool: 'HIGH'") + ' expl=' + s.includes('workflow_tool: (a)'));
