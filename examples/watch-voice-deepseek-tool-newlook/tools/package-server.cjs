const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(project, '.runtime'), { recursive: true });
const stage = fs.mkdtempSync(path.join(project, '.runtime', 'cloud-upload-'));
for (const directory of ['cloud', 'shared', 'deploy']) {
  fs.cpSync(path.join(project, directory), path.join(stage, directory), {
    recursive: true, filter: file => !file.endsWith('.test.cjs')
  });
}
console.log(stage);
console.log('仅包含云端代码，不读取本地模型密钥、AnySearch Skill 或 RPK 配置。');
