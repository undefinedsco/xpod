#!/usr/bin/env node
/**
 * Seal private CI diagnostics so a failed public run keeps its real error.
 *
 * This repository is public, so raw failure evidence (messages, stacks, HTTP
 * bodies, test-account storage state) cannot be uploaded as a plain artifact.
 * Instead the private directory is packed and encrypted to the maintainers'
 * RSA public key (repository variable `XPOD_DIAGNOSTICS_PUBLIC_KEY`). Only the
 * holder of the private key can open it:
 *
 *   gh run download <run-id> -n <artifact-name> -D /tmp/diag
 *   node scripts/sealed-diagnostics.cjs open --key ~/.xpod/diagnostics.pem \
 *     --in /tmp/diag/diagnostics.sealed --out /tmp/diag/open
 *
 * Format: "XPODSEAL1\n" | u32be header length | header JSON | AES-256-GCM
 * ciphertext of a gzip tar. The header carries the RSA-OAEP(SHA-256) wrapped
 * content key, the IV and the GCM tag; nothing in it is secret.
 *
 *   seal --in <dir> [--in <dir>...] --out <file>
 *       Missing inputs are skipped. Without a public key the command reports
 *       why and exits 0: diagnostics never replace the real failure.
 *   open --key <private.pem> --in <file> --out <dir>
 *   keygen --private <file> --public <file>
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAGIC = Buffer.from('XPODSEAL1\n');

function parseArgs(argv) {
  const args = { in: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${name ?? '<end>'}`);
    const key = name.slice(2);
    if (key === 'in') args.in.push(value);
    else args[key] = value;
  }
  return args;
}

function pack(inputs) {
  const present = inputs.map(input => path.resolve(input)).filter(input => fs.existsSync(input));
  if (present.length === 0) return undefined;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-seal-'));
  try {
    present.forEach((input, index) => {
      fs.cpSync(input, path.join(staging, `${index}-${path.basename(input)}`), { recursive: true, dereference: false });
    });
    return execFileSync('tar', ['-czf', '-', '-C', staging, '.'], { maxBuffer: 1024 * 1024 * 1024 });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function seal(plaintext, publicKeyPem) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, key);
  const header = Buffer.from(JSON.stringify({ alg: 'RSA-OAEP-256+A256GCM', wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header, ciphertext]);
}

function open(sealed, privateKeyPem) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a sealed diagnostics file');
  const headerLength = sealed.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(sealed.subarray(headerStart, headerStart + headerLength).toString('utf8'));
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
  return Buffer.concat([decipher.update(sealed.subarray(headerStart + headerLength)), decipher.final()]);
}

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === 'seal') {
    if (!args.out || args.in.length === 0) throw new Error('seal requires --in and --out');
    const publicKey = process.env.XPOD_DIAGNOSTICS_PUBLIC_KEY?.trim();
    if (!publicKey) {
      console.log('::warning::XPOD_DIAGNOSTICS_PUBLIC_KEY is not set; private diagnostics were not sealed');
      return;
    }
    const plaintext = pack(args.in);
    if (!plaintext) {
      console.log('No private diagnostics exist to seal');
      return;
    }
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, seal(plaintext, publicKey));
    console.log(`Sealed ${plaintext.length} bytes of private diagnostics into ${args.out}`);
  } else if (command === 'open') {
    if (!args.key || args.in.length !== 1 || !args.out) throw new Error('open requires --key, one --in and --out');
    const archive = open(fs.readFileSync(args.in[0]), fs.readFileSync(args.key, 'utf8'));
    fs.mkdirSync(args.out, { recursive: true });
    execFileSync('tar', ['-xzf', '-', '-C', args.out], { input: archive });
    console.log(`Opened diagnostics into ${args.out}`);
  } else if (command === 'keygen') {
    if (!args.private || !args.public) throw new Error('keygen requires --private and --public');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    fs.writeFileSync(args.private, privateKey, { mode: 0o600 });
    fs.writeFileSync(args.public, publicKey);
    console.log(`Wrote ${args.private} (keep private) and ${args.public} (set as XPOD_DIAGNOSTICS_PUBLIC_KEY)`);
  } else {
    throw new Error('Usage: sealed-diagnostics.cjs seal|open|keygen ...');
  }
}

module.exports = { seal, open, pack };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
