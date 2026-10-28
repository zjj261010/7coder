// Source-region boundary for offline static/VM tests, not product discovery.
function regions(source) {
  const declarations = [], re = /(^|\n)const tools = \[/g;
  let match;
  while ((match = re.exec(source))) declarations.push(match.index + match[1].length);
  if (declarations.length !== 1) throw Error('expected exactly one top-level tools declaration');
  const start = declarations[0], tail = source.slice(start), closing = /^\];\r?$/m.exec(tail);
  if (!closing) throw Error('tool declaration terminator not found');
  const end = start + closing.index + closing[0].length;
  const metadataEnd = source.indexOf('// ====================== SYSTEM PROMPT', end);
  if (metadataEnd < end) throw Error('tool metadata terminator not found');
  return { declaration: source.slice(start, end), metadata: source.slice(start, metadataEnd) };
}
function problems(tools) {
  const result = { names: [], descriptions: [], required: [] }, seen = new Set();
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!Array.isArray(tools) || !tools.length) return { names: ['empty/invalid declarations'], descriptions: ['empty/invalid declarations'], required: ['empty/invalid declarations'] };
  function required(schema, label, visited) {
    if (!object(schema) || visited.has(schema)) return;
    visited.add(schema);
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !object(schema.properties) || !Object.prototype.hasOwnProperty.call(schema.properties, key)) || new Set(schema.required).size !== schema.required.length) result.required.push(label);
    }
    if (object(schema.properties)) for (const key of Object.keys(schema.properties)) required(schema.properties[key], label + '.' + key, visited);
    if (object(schema.items)) required(schema.items, label + '[]', visited);
  }
  for (const tool of tools) {
    const fn = tool && tool.function, name = fn && fn.name;
    if (typeof name !== 'string' || !name.trim() || seen.has(name) || tool.type !== 'function') result.names.push(String(name));
    seen.add(name);
    if (!fn || typeof fn.description !== 'string' || !fn.description.trim()) result.descriptions.push(String(name));
    if (fn && fn.parameters === undefined) continue; // valid no-argument function
    if (!fn || !object(fn.parameters) || (fn.parameters.type !== undefined && fn.parameters.type !== 'object') || (fn.parameters.properties !== undefined && !object(fn.parameters.properties))) result.required.push(String(name) + ': invalid parameters');
    else required(fn.parameters, name, new Set());
  }
  return result;
}
module.exports = { regions, problems };
