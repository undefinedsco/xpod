#!/usr/bin/env bun
// Historical command is now verification-only; it never emits a shared apply manifest.
const fs = require('node:fs');
const { parse } = require('yaml');
const { GZ_NAMESPACE, verifySharedRoutes } = require('./verify-gz-rc-prerequisites.cjs');

async function main() {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const option = process.argv[index], value = process.argv[index + 1];
    if (!['--input','--output','--namespace'].includes(option) || !value) throw new Error('invalid verification arguments');
    args[option.slice(2)] = value;
  }
  if (args.namespace !== GZ_NAMESPACE) throw new Error('unexpected GZ namespace');
  const raw = args.input ? fs.readFileSync(args.input, 'utf8') : await new Promise(resolve => {
    let text = ''; process.stdin.on('data', chunk => { text += chunk; }); process.stdin.on('end', () => resolve(text));
  });
  const input = parse(raw);
  const identities = verifySharedRoutes(input.gateway,input.ingresses);
  const output = JSON.stringify({status:'ok',identities});
  if (args.output) fs.writeFileSync(args.output,output,{mode:0o600});
  else process.stdout.write(output);
}
main().catch(() => { console.error('existing GZ routes failed verification; shared mutation refused'); process.exitCode = 1; });
