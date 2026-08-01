import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const distDir = path.resolve(process.argv[2] ?? 'dist')

await rewriteDirectory(distDir)

async function rewriteDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewriteDirectory(entryPath)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      await rewriteFile(entryPath)
    }
  }
}

async function rewriteFile(filePath) {
  const source = await readFile(filePath, 'utf8')
  const next = source
    .replaceAll(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, rewriteSpecifier)
    .replaceAll(/(import\s*\(\s*['"])(\.\.?\/[^'"]+)(['"]\s*\))/g, rewriteSpecifier)

  if (next !== source) {
    await writeFile(filePath, next)
  }
}

function rewriteSpecifier(_match, prefix, specifier, suffix) {
  if (path.extname(specifier)) {
    return `${prefix}${specifier}${suffix}`
  }
  return `${prefix}${specifier}.js${suffix}`
}
