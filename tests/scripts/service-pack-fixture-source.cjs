const fs = require('node:fs');
const path = require('node:path');

// Keep the actual worker under the fixture repository, just as the production
// command does. Linux runtime replay verifies this path against the real argv.
function copyServicePackFixtureSource(root) {
  const source = path.resolve(__dirname, '../../scripts');
  const target = path.join(root, 'scripts');
  fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (name.endsWith('.cjs') || name.endsWith('.py')) {
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
  }
  for (const name of fs.readdirSync(path.join(source, 'lib'))) {
    if (name.endsWith('.json')) {
      fs.copyFileSync(path.join(source, 'lib', name), path.join(target, 'lib', name));
    }
  }
  return path.join(target, 'run-npm-pack.cjs');
}

module.exports = { copyServicePackFixtureSource };
