const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { saveJson } = require('../shared/store.cjs');
const { createPrinter, PrinterError } = require('./printer.cjs');
const { validatePrint } = require('../shared/print-contract.cjs');

function createAgent({ file, printer, request }) {
  const journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { agentId: randomUUID(), jobs: {} };
  const instance = randomUUID();
  const persist = () => saveJson(file, journal);
  for (const job of Object.values(journal.jobs)) {
    if (job.state === 'printing') {
      job.state = 'uncertain';
      job.result = '本地代理上次执行时中断，任务可能已提交，请检查打印队列，勿直接重复打印';
    }
  }
  persist();
  async function report(id, job) {
    await request('/result', { agentId: journal.agentId, id, state: job.state, result: job.result });
    job.reported = true; persist();
  }
  return {
    async tick() {
      for (const [id, job] of Object.entries(journal.jobs)) if (!job.reported) await report(id, job);
      const { job } = await request('/poll', { agentId: journal.agentId, instance });
      if (!job) return;
      if (typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('无效任务');
      if (Object.hasOwn(journal.jobs, job.id)) {
        await report(job.id, journal.jobs[job.id]); return;
      }
      const record = { state: 'printing', reported: false };
      journal.jobs[job.id] = record;
      persist(); // Failure to save must stop before calling Python.
      try {
        validatePrint({ text: job.text });
      } catch {
        record.state = 'failed'; record.result = '打印参数无效，未调用打印机';
      }
      if (record.state === 'printing') {
        try {
          record.result = await printer.print({ text: job.text });
          record.state = /仍在队列|没看到|未看到|未证实|超时|未确认|可能/.test(record.result) ? 'uncertain' : 'succeeded';
        } catch (error) {
          record.state = 'uncertain';
          record.result = error instanceof PrinterError ? error.message : '打印执行中断，任务状态未确认，请检查打印队列';
        }
      }
      persist();
      console.log(`打印任务 ${job.id}：${record.state}\n${record.result}`);
      await report(job.id, record);
    }
  };
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('已有本地打印代理运行，请先关闭原来的进程');
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}

async function main() {
  const runtime = path.resolve(__dirname, '../.runtime');
  const configFile = process.env.PRINT_AGENT_CONFIG || path.join(runtime, 'print-agent.json');
  if (!fs.existsSync(configFile)) throw new Error('缺少 .runtime/print-agent.json，请先配置云端桥接连接');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (!/^[\w.-]+@[\w.-]+$/.test(config.sshTarget || '') || typeof config.token !== 'string' || config.token.length < 32) throw new Error('打印桥接配置无效');
  const port = config.localPort || 18768;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地隧道端口无效');
  const unlock = acquireLock(path.join(runtime, 'print-agent.lock'));
  process.once('exit', unlock);
  let stopping = false, child = null;
  const controller = new AbortController();
  function stop() { stopping = true; controller.abort(); child?.kill(); }
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, stop);
  const agent = createAgent({ file: path.join(runtime, 'print-journal.json'), printer: createPrinter(),
    request: async (route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) { await res.body?.cancel(); throw new Error('打印桥接请求失败'); }
      return res.json();
    }
  });
  console.log('本地仅运行打印代理；问答与 AnySearch 在云端运行。');
  console.log(process.env.PRINT_DRY_RUN === '1' ? '当前为演练模式，不实际出纸。' : '当前为实际打印模式。');
  while (!stopping) {
    const tunnel = spawn('ssh', ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${port}:127.0.0.1:8768`, config.sshTarget],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child = tunnel;
    let exited = false;
    tunnel.stderr.on('data', () => {}); // Never echo SSH config or remote output.
    tunnel.on('error', () => { exited = true; });
    tunnel.on('exit', () => { exited = true; });
    let connected = false;
    while (!stopping && !exited) {
      try {
        await agent.tick();
        if (!connected) console.log('已连接云端，等待手表打印命令。');
        connected = true;
      } catch {
        if (connected) console.log('云端连接暂时中断，正在重连；已领取的任务不会重复打印。');
        connected = false;
      }
      await delay(1500, undefined, { signal: controller.signal }).catch(() => {});
    }
    tunnel.kill(); child = null;
    if (!stopping) {
      console.log('SSH 隧道未连接，5秒后重试，请确认网络和 SSH 密钥。');
      await delay(5000, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
}

if (require.main === module) main().catch(() => { console.error('打印代理启动失败，请检查配置、日志文件和端口占用。'); process.exitCode = 1; });
module.exports = { createAgent, acquireLock };
