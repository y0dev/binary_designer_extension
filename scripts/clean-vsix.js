/* Removes stale .vsix bundles before packaging a fresh one. */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
for (const name of fs.readdirSync(root)) {
  if (name.endsWith('.vsix')) {
    fs.rmSync(path.join(root, name));
    console.log(`removed ${name}`);
  }
}
