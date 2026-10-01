#!/usr/bin/env node
// Count STATIC assertion points in the test/ runner suites.
//
// A "static assertion point" is a `record(` call site in a runner source file;
// the `function record(...)` definition itself is not an assertion and is
// subtracted when present. This is a SOURCE-LEVEL count and is deliberately a
// different ruler from the runtime pass counts a suite run prints. Docs must
// not mix the two — that drift is exactly what this script cures.
//
// Usage:
//   node scripts/count-assertions.js           print the table (file -> count, total)
//   node scripts/count-assertions.js --write   rewrite the marked block in ISSUES-LOG.md
//
// The --write mode replaces everything between `<!-- assert-count:start -->`
// and `<!-- assert-count:end -->` in ISSUES-LOG.md (markers are kept). If the
// markers are missing, the file is left untouched and the script errors out.
//
// Zero dependencies, synchronous IO, Node 13 compatible.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TEST_DIR = path.join(REPO, 'test');
const LOG_PATH = path.join(REPO, 'ISSUES-LOG.md');

const RUNNER_RE = /^runner[a-z0-9-]*\.js$/;
const MARK_START = '<!-- assert-count:start -->';
const MARK_END = '<!-- assert-count:end -->';

const FOOTNOTE =
  '注：以上为静态断言点数（源码中 `record(` 调用次数，文件内 `function record` 定义已扣除），' +
  '与套件实测通过数（套件运行输出统计）是两个口径，请勿混用。';

function listRunnerFiles() {
  let names;
  try {
    names = fs.readdirSync(TEST_DIR);
  } catch (err) {
    console.error('ERROR: cannot read test directory: ' + TEST_DIR + ' (' + err.message + ')');
    process.exit(1);
  }
  return names
    .filter(function (name) { return RUNNER_RE.test(name); })
    .filter(function (name) { return fs.statSync(path.join(TEST_DIR, name)).isFile(); })
    .sort();
}

function countRecordCalls(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const calls = (src.match(/\brecord\(/g) || []).length;
  const definesRecord = /\bfunction\s+record\s*\(/.test(src);
  return {
    calls: calls,
    definesRecord: definesRecord,
    count: definesRecord ? calls - 1 : calls
  };
}

function collect() {
  const files = listRunnerFiles();
  if (files.length === 0) {
    console.error('ERROR: no /^runner[a-z0-9-]*\\.js$/ files found under ' + TEST_DIR);
    process.exit(1);
  }
  const rows = [];
  let total = 0;
  files.forEach(function (name) {
    const r = countRecordCalls(path.join(TEST_DIR, name));
    rows.push({ name: name, count: r.count });
    total += r.count;
  });
  return { rows: rows, total: total };
}

function pad(str, width) {
  return str + ' '.repeat(Math.max(0, width - str.length));
}

function printTable(data) {
  const headerFile = '文件名';
  const headerCount = '静态断言点数（record 调用）';
  let nameWidth = headerFile.length;
  data.rows.forEach(function (r) { nameWidth = Math.max(nameWidth, r.name.length); });
  nameWidth = Math.max(nameWidth, '合计'.length);

  console.log(pad(headerFile, nameWidth) + '  ' + headerCount);
  data.rows.forEach(function (r) {
    console.log(pad(r.name, nameWidth) + '  ' + String(r.count));
  });
  console.log(pad('合计', nameWidth) + '  ' + String(data.total));
  console.log('');
  console.log('说明：这是"静态断言点数（record 调用）"，源码文本层面的计数；' +
    '与套件实测通过数（套件运行输出统计）是两个不同口径，请勿混用。');
}

function buildBlockLines(data) {
  const lines = [];
  lines.push('| 文件 | 静态断言点数 |');
  lines.push('| --- | ---: |');
  data.rows.forEach(function (r) {
    lines.push('| ' + r.name + ' | ' + r.count + ' |');
  });
  lines.push('| **合计** | **' + data.total + '** |');
  lines.push('');
  lines.push(FOOTNOTE);
  return lines;
}

function writeLog(data) {
  const src = fs.readFileSync(LOG_PATH, 'utf8');
  const startIdx = src.indexOf(MARK_START);
  const endIdx = src.indexOf(MARK_END);
  if (startIdx === -1 || endIdx === -1) {
    console.error('ERROR: ISSUES-LOG.md does not contain the marker pair ' +
      MARK_START + ' / ' + MARK_END + '. File left UNTOUCHED. ' +
      'Insert the markers first, then rerun with --write.');
    process.exit(1);
  }
  if (endIdx < startIdx) {
    console.error('ERROR: ISSUES-LOG.md markers are out of order ' +
      '(found ' + MARK_END + ' before ' + MARK_START + '). File left UNTOUCHED.');
    process.exit(1);
  }
  const eol = src.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const body = buildBlockLines(data).join(eol);
  const next = src.slice(0, startIdx) + MARK_START + eol + body + eol + MARK_END +
    src.slice(endIdx + MARK_END.length);
  fs.writeFileSync(LOG_PATH, next, 'utf8');
  console.log('Written: ' + LOG_PATH + ' — assert-count block updated (total ' + data.total + ').');
}

function main() {
  const data = collect();
  if (process.argv.indexOf('--write') !== -1) {
    writeLog(data);
  }
  printTable(data);
}

main();
