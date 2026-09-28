const fs = require('fs');
const p = 'D:/ai-workspaces/7coder/index.js';
let s = fs.readFileSync(p, 'utf8');
const applied = [];

// 1) REPL welcome: auto-load saved session on start if present
const welc = "    console.log('Type your task (multi-line OK), /btw <note> for background notes, then /execute-task-now to run.');";
if (!s.includes(welc)) { console.error('welcome anchor missing'); process.exit(1); }
s = s.replace(welc, welc + "\n    if (resumeFlag && loadSession()) console.log('[OK] Previous session resumed (' + (messages.length - 1) + ' turns). Use /clear to start fresh.');");

// 2) /resume command before /clear handler
const clearAnchor = "      if (trimmed === '/clear') {";
if (!s.includes(clearAnchor)) { console.error('clear anchor missing'); process.exit(1); }
s = s.replace(clearAnchor, [
  "      if (trimmed === '/resume') {",
  "        if (taskRunning) { console.log('A task is running - wait before /resume.'); safePrompt(); return; }",
  '        if (loadSession()) {',
  "          console.log('[OK] Session resumed (' + (messages.length - 1) + ' turns).');",
  '        } else {',
  "          console.log('No saved session found in .7coder/session.json.');",
  '        }',
  '        safePrompt();',
  '        return;',
  '      }',
  '',
  clearAnchor
].join('\n'));

// 3) auto-save after each REPL task (the executeTask inside /execute-task-now)
const execAnchor = '            await executeTask();\n          } finally {';
if (!s.includes(execAnchor)) { console.error('exec anchor missing'); process.exit(1); }
s = s.replace(execAnchor, '            await executeTask();\n            saveSession();\n          } finally {');

// 4) /bye also saves
const byeAnchor = "        console.log('Goodbye!');";
if (!s.includes(byeAnchor)) { console.error('bye anchor missing'); process.exit(1); }
s = s.replace(byeAnchor, '        saveSession();\n' + byeAnchor);

applied.push('welcome-load', 'resume-cmd', 'task-save', 'bye-save');
fs.writeFileSync(p, s);
console.log('applied: ' + applied.join(', '));
