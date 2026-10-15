const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// Persist before acknowledging any transition that can lead to paper output.
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

module.exports = { saveJson };
