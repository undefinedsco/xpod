#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function check(root, files) {
  const failures = [];
  for (const file of files) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/```[^\n]*\n[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
      let decoded; try { decoded = decodeURIComponent(target); } catch { failures.push(file); continue; }
      if (!fs.existsSync(path.resolve(root, path.dirname(file), decoded))) failures.push(`${file}:${target}`);
    }
  }
  if (failures.length) throw new Error(`document_link_missing:${failures.join(',')}`);
  return files.length;
}
module.exports = { check };
if (require.main === module) { try { console.log(`document_links_checked:${check(process.cwd(), process.argv.slice(2))}`); } catch (error) { console.error(error.message); process.exitCode = 1; } }
