'use strict';
const assert = require('assert'), vm = require('vm'), F = require('./_tool-declarations');
const clone = value => JSON.parse(JSON.stringify(value));
const scope = process.env.TOOL_DECLARATION_SCOPE || 'all';
assert.ok(['all', 'parameters', 'parameters-omitted'].includes(scope), 'unknown declaration oracle scope');
let checks = 0;
function check(label, ok) { assert.ok(ok, label); checks++; console.log('PASS ' + label); }
const tool = { type: 'function', function: { name: 'fixture', description: 'business description', parameters: { type: 'object', properties: {
  value: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
}, required: ['value'] } } };
const declaration = 'const tools = [\n' + JSON.stringify(tool) + '\n];';
const prefix = 'async function discover(){\n  const tools = [];\n  await Promise.resolve();\n}\n';
const metadata = '\nconst FIXTURE_METADATA = true;\n';
const source = prefix + declaration + metadata + '// ====================== SYSTEM PROMPT\nconst doNotRun = missing();';
const regions = F.regions(source), actual = vm.runInNewContext(regions.declaration + '\ntools;');
function reject(label, field, mutate) { const data = clone([tool]); mutate(data); check(label, F.problems(data)[field].length > 0); }
if (scope === 'all') {
check('only top-level declaration is extracted despite earlier MCP-style local array', JSON.stringify(actual) === JSON.stringify([tool]) && !regions.declaration.includes('await') && !regions.declaration.includes('missing()'));
check('metadata region ends before system initialization', regions.metadata === declaration + metadata);
check('CRLF and LF produce equivalent declaration regions', JSON.stringify(vm.runInNewContext(F.regions(source.replace(/\n/g, '\r\n')).declaration + '\ntools;')) === JSON.stringify(actual));
for (const [label, input] of [['only local array', prefix + '// ====================== SYSTEM PROMPT'], ['missing terminator', 'const tools = [\n{}\n// ====================== SYSTEM PROMPT'], ['missing metadata boundary', declaration], ['ambiguous top-level declarations', declaration + '\n' + declaration + '\n// ====================== SYSTEM PROMPT']]) {
  assert.throws(() => F.regions(input)); check(label + ' fails explicitly rather than slicing a wrong region', true);
}
const valid = F.problems([tool]);
check('valid nested declarations satisfy all three independent checks', Object.values(valid).every(errors => errors.length === 0));
check('empty declarations cannot pass empty every()/regex loops', Object.values(F.problems([])).every(errors => errors.length > 0));
check('non-array declarations cannot pass', F.problems({}).names.length > 0);
reject('duplicate tool names are rejected', 'names', a => a.push(clone(a[0])));
reject('blank names are rejected', 'names', a => { a[0].function.name = ' '; });
reject('missing function contract is rejected', 'names', a => { delete a[0].function; });
reject('non-function declaration type is rejected', 'names', a => { a[0].type = 'other'; });
reject('missing descriptions are no longer skipped by a nested-object regex', 'descriptions', a => { delete a[0].function.description; });
reject('whitespace-only description is rejected', 'descriptions', a => { a[0].function.description = '\n '; });
reject('missing top-level required property is rejected', 'required', a => { a[0].function.parameters.required = ['missing']; });
reject('missing nested workflow item property is rejected', 'required', a => { a[0].function.parameters.properties.steps.items.required = ['missing']; });
reject('non-array required declaration is rejected', 'required', a => { a[0].function.parameters.required = 'value'; });
reject('duplicate required fields are rejected', 'required', a => { a[0].function.parameters.required.push('value'); });
}
if (scope !== 'parameters-omitted') {
reject('wrong root parameter type cannot pass', 'required', a => { a[0].function.parameters.type = 'array'; });
reject('required fields without a properties dictionary cannot pass', 'required', a => { delete a[0].function.parameters.properties; });
const empty = clone(tool); empty.function.parameters = { type: 'object' };
check('valid empty parameter schema may omit properties', Object.values(F.problems([empty])).every(errors => errors.length === 0));
reject('explicit non-object properties dictionary is rejected', 'required', a => { a[0].function.parameters.properties = []; });
}
reject('explicit null parameters object is rejected', 'required', a => { a[0].function.parameters = null; });
const noArguments = clone(tool); delete noArguments.function.parameters;
check('no-argument function may omit its entire parameters field', Object.values(F.problems([noArguments])).every(errors => errors.length === 0));
const expected = scope === 'all' ? 26 : scope === 'parameters' ? 6 : 2;
assert.strictEqual(checks, expected); console.log('TOOL/DECLARATION-ORACLES ' + scope + ' ' + checks + '/' + expected);
