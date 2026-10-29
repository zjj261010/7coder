'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function cut(a, b) { const start = source.indexOf(a), end = source.indexOf(b, start); assert.ok(start >= 0 && end > start, a); return source.slice(start, end); }
let notes, failure, reads, memory, warnings, checks = 0;
const c = vm.createContext({
  systemPrompt: 'fixture system', managedWorkspacePath: name => name,
  readStateRecord(file) { assert.strictEqual(file, '7CODER.md'); reads++; if (failure) throw failure; return notes === null ? null : { value: notes }; },
  recallMemory: prompt => { assert.strictEqual(typeof prompt, 'string'); return memory; },
  console: { error(...args) { warnings.push(args); } }
});
vm.runInContext(cut('function buildTaskUserContent(', '// ====================== EDIT SAFETY NET') +
  cut('function conversationFromClient(', '// ====================== HTTP SERVER'), c);
function reset(value) { notes = value; failure = null; reads = 0; memory = { note: '', topics: [] }; warnings = []; }
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const prompt = 'TASK', prefix = prompt + "\n\nthis is what's already been done.\n";
for (const [label, value, expected] of [
  ['absent', null, prompt], ['empty', '', prompt], ['whitespace only', '\uFEFF \r\n\t', prompt],
  ['indented Markdown', '    code\n  continuation  \n', prefix + '    code\n  continuation  \n'],
  ['BOM/CRLF/Chinese', '\uFEFF    中文😀\r\n\tend  ', prefix + '    中文😀\r\n\tend  '],
  ['leading blank lines', '\n\n    code\n', prefix + '\n\n    code\n'],
  ['embedded BOM is content', 'first\uFEFFsecond', prefix + 'first\uFEFFsecond'],
  ['remove only first BOM', '\uFEFF\uFEFFcode', prefix + '\uFEFFcode']
]) { reset(value); check(label + ' retains exact prompt bytes with one read', c.buildTaskUserContent(prompt) === expected && reads === 1); }
reset('    NOTES\r\n  '); memory = { note: '\nMEMORY', topics: ['topic'] };
check('topic recall follows untrimmed worklog without changing its body', c.buildTaskUserContent(prompt) === prefix + '    NOTES\r\n  \nMEMORY\n\nMemory topics on disk: topic (memory_tool with action=list shows contents; save new durable facts with action=save).');
reset('irrelevant'); failure = Error('fixture access denied'); memory.note = '\nMEMORY';
check('read failure reports original error and still supplies task plus recalled memory', c.buildTaskUserContent(prompt) === prompt + '\nMEMORY' && warnings.length === 1 && warnings[0][1] === failure);
reset('    NOTES\n'); const cli = c.prepareMessagesForPrompt(prompt);
check('CLI preparation keeps original system and exact note content', JSON.stringify(cli) === JSON.stringify([{ role: 'system', content: 'fixture system' }, { role: 'user', content: prefix + '    NOTES\n' }]));
reset('    NOTES\n'); const plain = c.conversationFromClient([{ role: 'user', content: prompt }, { role: 'assistant', content: 'prior' }, { role: 'user', content: 'next' }]);
check('HTTP text augments first user exactly once and retains later history', reads === 1 && plain[1].content === prefix + '    NOTES\n' && plain[2].content === 'prior' && plain[3].content === 'next');
reset('    NOTES\n'); const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
const multi = c.conversationFromClient([{ role: 'user', content: [{ type: 'text', text: prompt }, image] }]);
check('HTTP multimodal text keeps indentation and original image', reads === 1 && multi[1].content[0].text === prefix + '    NOTES\n' && JSON.stringify(multi[1].content[1]) === JSON.stringify(image));
reset('    NOTES\n'); const textParts = c.conversationFromClient([{ role: 'user', content: [{ type: 'text', text: prompt }] }]);
check('HTTP text-part array retains exact note body', textParts[1].content === prefix + '    NOTES\n' && reads === 1);
reset('    NOTES\n'); const empty = c.conversationFromClient([]);
check('empty HTTP conversation still seeds exact worklog in default user message', empty.length === 2 && empty[1].content === prefix.slice(prompt.length) + '    NOTES\n' && reads === 1);
assert.strictEqual(checks, 15); console.log('WORKLOG/CONTEXT 15/15; no real model or file mutation');
