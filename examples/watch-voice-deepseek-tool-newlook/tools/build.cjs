const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const local = path.join(root, 'node_modules')
const shared = path.resolve(root, '../hello-world/node_modules')
if (!fs.existsSync(path.join(root, 'src/common/connection.js'))) {
  throw new Error('Run npm.cmd run configure before building the watch app.')
}
if (!fs.existsSync(local)) {
  if (!fs.existsSync(path.join(shared, 'aiot-toolkit/lib/bin.js'))) {
    throw new Error('Existing hello-world build dependencies are missing. No packages were installed.')
  }
  fs.symlinkSync(shared, local, 'junction')
}
const cli = path.join(local, 'aiot-toolkit/lib/bin.js')
const started = Date.now()
const result = spawnSync(process.execPath, [cli, 'build'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status === null ? 1 : result.status)
// Some toolkit validation failures exit with status 0. Require a fresh artifact.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'))
const rpk = path.join(root, 'dist', manifest.package + '.debug.' + manifest.versionName + '.rpk')
if (!fs.existsSync(rpk) || fs.statSync(rpk).mtimeMs < started - 1000) {
  throw new Error('Toolkit did not produce a fresh RPK. Check build diagnostics above.')
}
console.log('Verified artifact: ' + rpk)
