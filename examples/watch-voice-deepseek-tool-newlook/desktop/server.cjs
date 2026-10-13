const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { ModelError } = require('./deepseek.cjs');

const project = path.resolve(__dirname, '..');
const runtimeFile = path.join(project, '.runtime', 'connection.json');
const MAX_TEXT = 120;

function reply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function createServer(token, options = {}) {
  const session = randomBytes(12).toString('hex');
  const messages = [];
  const seen = new Map();
  let next = 0;
  let watchLastSeen = 0;
  let watchCursor = 0;
  const jobs = [];
  const queue = [];
  let generating = false;
  let closed = false;
  const controller = new AbortController();
  function append(source, text, extra = {}) {
    const message = { id: ++next, source, text, time: Date.now(), ...extra };
    messages.push(message);
    if (messages.length > 200) messages.shift();
    return message;
  }
  function sendAnswer(job, text) {
    const chars = Array.from(text);
    const shortened = chars.length > 420 ? chars.slice(0, 419).join('') + '…' : text;
    const parts = Array.from(shortened);
    const count = Math.ceil(parts.length / 108);
    job.replyIds = [];
    for (let i = 0; i < count; i++) {
      const prefix = count > 1 ? `[AI ${i + 1}/${count}] ` : '[AI] ';
      const message = append('pc', prefix + parts.slice(i * 108, (i + 1) * 108).join(''), {
        origin: 'ai', jobId: job.id, requestId: job.requestId, part: i + 1, parts: count
      });
      job.replyIds.push(message.id);
    }
  }
  async function pump() {
    if (generating || closed) return;
    generating = true;
    while (queue.length && !closed) {
      const job = queue.shift();
      job.state = 'generating';
      try {
        const answer = await options.generate(job.prompt, controller.signal);
        if (closed) break;
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('empty');
        sendAnswer(job, answer.trim());
        job.state = 'succeeded';
      } catch (error) {
        if (closed) break;
        // Only deliberately sanitized provider errors may be shown to users.
        job.error = error instanceof ModelError ? error.message : '模型调用失败，请稍后重新提问';
        sendAnswer(job, job.error);
        job.state = 'failed';
      }
      job.finished = Date.now();
    }
    generating = false;
  }
  function enqueue(message) {
    const job = { id: message.id, requestId: message.requestId, prompt: message.text, state: 'queued', replyIds: [] };
    jobs.push(job);
    if (jobs.length > 100) jobs.shift();
    if (queue.length >= 8) {
      job.state = 'failed';
      job.error = '请求队列已满，请稍后重新提问';
      sendAnswer(job, job.error);
    } else {
      queue.push(job);
      setImmediate(pump);
    }
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(res, 200, { ok: true, name: 'Redmi Watch Voice DeepSeek', aiEnabled: !!options.generate });
    }
    // The desktop UI is served to this computer; phone/watch calls use the paired API token.
    if (req.method === 'GET' && url.pathname === '/' && local) {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__PAIR_TOKEN__', token);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method !== 'POST' || url.pathname !== '/api/sync') return reply(res, 404, { error: 'Not found' });
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(res, 401, { error: '连接密钥不匹配' });
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 8192) return reply(res, 413, { error: '请求过大' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!['watch', 'pc'].includes(body.source) || !Number.isSafeInteger(body.after) || body.after < 0 || typeof body.session !== 'string') {
        return reply(res, 400, { error: '无效的同步参数' });
      }
      let ack = null;
      if (body.outgoing != null) {
        const { id, text } = body.outgoing;
        const ask = body.source === 'pc' && body.outgoing.ai === true;
        if (ask && !local) return reply(res, 403, { error: '网页提问仅允许在电脑本机操作' });
        if ((ask || body.source === 'watch') && !options.generate) return reply(res, 503, { error: '模型服务未配置' });
        const limit = body.source === 'watch' ? 2000 : ask ? 1000 : MAX_TEXT;
        if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || typeof text !== 'string' || !text.trim() || Array.from(text).length > limit) {
          return reply(res, 400, { error: `消息需为 1–${limit} 个字符` });
        }
        const key = body.source + ':' + id;
        if (seen.has(key) && (seen.get(key).text !== text || !!seen.get(key).ask !== ask)) return reply(res, 409, { error: '消息 ID 重复' });
        if (!seen.has(key)) {
          const message = append(ask ? 'user' : body.source, text, { requestId: id });
          seen.set(key, { text, ask });
          if (seen.size > 1000) seen.delete(seen.keys().next().value);
          if (options.generate && (ask || body.source === 'watch')) enqueue(message);
        }
        ack = id;
      }
      const after = body.session === session ? Math.min(body.after, next) : 0;
      if (body.source === 'watch') {
        watchLastSeen = Date.now();
        watchCursor = after;
      }
      const batch = messages.filter(message => message.id > after).slice(0, 20);
      reply(res, 200, {
        session,
        cursor: batch.length ? batch[batch.length - 1].id : after,
        messages: batch,
        ack,
        watchLastSeen,
        watchCursor,
        ...(body.source === 'pc' ? { ai: { enabled: !!options.generate, model: options.model || '', jobs: jobs.slice(-20) } } : {})
      });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, 400, { error: '请求 JSON 无效' });
    }
  });
  server.on('close', () => { closed = true; controller.abort(); queue.length = 0; });
  return server;
}

function lanAddress() {
  const list = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    entries.filter(entry => entry.family === 'IPv4' && !entry.internal && !/^(169\.254|198\.18)\./.test(entry.address))
      .map(entry => ({ name, address: entry.address })));
  const physical = list.filter(entry => !/vmware|vethernet|virtual|wsl|clash|vpn|tun/i.test(entry.name));
  const selected = physical.find(entry => /wlan|wi-fi|wifi|无线/i.test(entry.name)) || physical[0];
  if (!selected) throw new Error('未找到局域网地址。请指定 --host 手机可访问的电脑IPv4地址');
  return selected.address;
}

function configure(host, port) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.split('.').some(part => Number(part) > 255)) throw new Error('host 必须是电脑 IPv4 地址');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  let previous;
  if (fs.existsSync(runtimeFile)) previous = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const config = { host, port, token: previous?.token || randomBytes(24).toString('hex') };
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(project, 'src/common/connection.js'),
    '// Generated by desktop/server.cjs --configure. Rebuild RPK after changing the address.\nexport default ' +
    JSON.stringify({ url: `http://${host}:${port}`, token: config.token }) + '\n');
  console.log(`手表连接地址：http://${host}:${port}`);
  return config;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
  try {
    const port = Number(option('--port') || 8767);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
    if (args.includes('--configure')) {
      configure(option('--host') || lanAddress(), port);
    } else {
      if (!fs.existsSync(runtimeFile)) throw new Error('请先运行 node desktop/server.cjs --configure，然后编译 RPK');
      const config = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      const provider = require('./deepseek.cjs').createDeepSeek();
      const server = createServer(config.token, provider);
      server.on('error', error => { console.error(error.message); process.exitCode = 1; });
      server.listen(config.port, '0.0.0.0', () => {
        console.log(`电脑聊天窗口：http://127.0.0.1:${config.port}`);
        console.log(`DeepSeek 模型：${provider.model}；手表提问自动回传，网页也可提问。`);
        console.log(`手机连通性测试：http://${config.host}:${config.port}/health`);
        console.log('保持手机和电脑同一 Wi-Fi、微信和小米运动健康运行，打开手表的“腕上语音AI”。');
      });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { createServer, configure };
