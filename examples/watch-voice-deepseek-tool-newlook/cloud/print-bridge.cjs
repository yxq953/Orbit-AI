const fs = require('node:fs');
const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { saveJson } = require('../shared/store.cjs');
const { validatePrint, PrinterError } = require('../shared/print-contract.cjs');

const uncertain = '打印任务状态未确认，请检查本地打印队列，勿直接重复打印';
const terminal = new Set(['succeeded', 'failed', 'uncertain']);

function createPrintQueue({ file, now = Date.now, waitMs = 35000, onlineMs = 40000 }) {
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { jobs: [] };
  let agent = null;
  const persist = () => saveJson(file, data);
  for (const job of data.jobs) {
    if (!terminal.has(job.state)) {
      job.state = job.state === 'queued' ? 'failed' : 'uncertain';
      job.result = job.state === 'failed' ? '云端重启，未领取的打印任务已取消' : uncertain;
    }
  }
  persist();
  const online = () => !!agent && now() - agent.time < onlineMs;
  function expire() {
    let changed = false;
    for (const job of data.jobs) {
      if (!terminal.has(job.state) && now() >= job.deadline) {
        job.result = job.state === 'queued' ? '本地电脑未及时领取，打印已取消' : uncertain;
        job.state = job.state === 'queued' ? 'failed' : 'uncertain';
        changed = true;
      }
    }
    if (changed) persist();
  }
  return {
    status() { expire(); return { online: online(), jobs: data.jobs.slice(-20).map(({ id, state, result }) => ({ id, state, result })) }; },
    poll(agentId, instance) {
      expire();
      if (online() && (agent.id !== agentId || agent.instance !== instance)) {
        throw Object.assign(new Error('已有打印代理在线'), { status: 409 });
      }
      agent = { id: agentId, instance, time: now() };
      // Only one outstanding job per printer, and never redeliver a claimed job.
      if (data.jobs.some(job => job.state === 'claimed')) return { job: null };
      const job = data.jobs.find(job => job.state === 'queued');
      if (!job) return { job: null };
      job.state = 'claimed'; job.agentId = agentId;
      persist();
      return { job: { id: job.id, text: job.text } };
    },
    result(agentId, body) {
      const job = data.jobs.find(job => job.id === body.id);
      if (!job || job.agentId !== agentId) throw Object.assign(new Error('任务不存在或不属于此代理'), { status: 409 });
      if (!terminal.has(body.state) || typeof body.result !== 'string' || !body.result || body.result.length > 2000) {
        throw new Error('打印结果无效');
      }
      // Repeated acknowledgements are harmless; late results can resolve uncertainty.
      if (job.state === 'claimed' || job.state === 'uncertain') {
        job.state = body.state; job.result = body.result;
        persist();
      }
      return { ok: true };
    },
    async print(args, signal, context = {}) {
      validatePrint(args);
      if (typeof context.requestId !== 'string' || !context.requestId) throw new PrinterError('打印请求缺少唯一标识');
      expire();
      let job = data.jobs.find(job => job.requestId === context.requestId);
      if (job && job.text !== args.text) throw new PrinterError('同一打印请求的内容发生变化，已阻止重复提交');
      if (!job) {
        if (signal?.aborted) throw new PrinterError('打印已取消，尚未提交');
        if (!online()) throw new PrinterError('本地打印电脑未连接，请在电脑运行 npm.cmd start 后重新发送打印请求');
        if (data.jobs.length >= 50000) throw new PrinterError('打印记录已满，请联系管理员归档');
        job = { id: randomUUID(), requestId: context.requestId, text: args.text,
          state: 'queued', deadline: now() + waitMs };
        data.jobs.push(job); persist();
      }
      // An existing request ID always returns its recorded result, even after restart.
      while (!terminal.has(job.state)) {
        expire();
        if (signal?.aborted && !terminal.has(job.state)) {
          job.result = job.state === 'queued' ? '打印请求已取消，尚未领取' : uncertain;
          job.state = job.state === 'queued' ? 'failed' : 'uncertain';
          persist();
        }
        if (!terminal.has(job.state)) await delay(100);
      }
      return job.result;
    },
    close() {
      for (const job of data.jobs) {
        if (terminal.has(job.state)) continue;
        job.result = job.state === 'queued' ? '云端停止，打印任务未执行' : uncertain;
        job.state = job.state === 'queued' ? 'failed' : 'uncertain';
      }
      persist();
    }
  };
}

function createBridgeServer(token, queue) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('请配置独立的 PRINT_BRIDGE_TOKEN（至少32字符）');
  return http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const expected = Buffer.from('Bearer ' + token), actual = Buffer.from(req.headers.authorization || '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return reply(401, { error: '认证失败' });
    if (req.method === 'GET' && req.url === '/status') return reply(200, queue.status());
    if (req.method !== 'POST' || !['/poll', '/result'].includes(req.url)) return reply(404, { error: 'Not found' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) return reply(413, { error: '请求过大' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body.agentId !== 'string' || !/^[\w-]{1,100}$/.test(body.agentId)) throw new Error();
      if (req.url === '/poll' && (typeof body.instance !== 'string' || !/^[\w-]{1,100}$/.test(body.instance))) throw new Error();
      reply(200, req.url === '/poll' ? queue.poll(body.agentId, body.instance) : queue.result(body.agentId, body));
    } catch (error) {
      if (!res.headersSent) reply(error.status || 400, { error: error.status === 409 ? error.message : '请求无效或状态无法保存' });
    }
  });
}

function startBridge() {
  const queue = createPrintQueue({ file: process.env.PRINT_QUEUE_FILE || '/var/lib/orbit-ai/print-queue.json' });
  const server = createBridgeServer(process.env.PRINT_BRIDGE_TOKEN, queue);
  server.on('error', () => { console.error('打印桥接监听失败'); process.exit(1); });
  // This port is intentionally absent from the public watch gateway.
  server.listen(8768, '127.0.0.1');
  return { printer: queue, close() { queue.close(); server.close(); server.closeAllConnections(); } };
}

module.exports = { createPrintQueue, createBridgeServer, startBridge };
