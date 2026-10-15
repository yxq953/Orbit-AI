const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrintQueue, createBridgeServer } = require('./print-bridge.cjs');
const { createAgent } = require('../desktop/print-agent.cjs');
const { createServer } = require('./server.cjs');
const { createDeepSeek } = require('./deepseek.cjs');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  return { dir, file, queue: createPrintQueue({ file, ...options }) };
}
const request = (queue) => async (route, body) => route === '/poll'
  ? queue.poll(body.agentId, body.instance) : queue.result(body.agentId, body);

test('bridge: offline rejects before enqueue; online registration excludes concurrent agent', async t => {
  let now = 0;
  const { queue } = fixture(t, { now: () => now });
  await assert.rejects(queue.print({ text: '测试' }, null, { requestId: 'watch:a' }), /未连接/);
  assert.equal(queue.status().jobs.length, 0);
  queue.poll('pc', 'first');
  assert.equal(queue.status().online, true);
  assert.throws(() => queue.poll('pc', 'second'), /已有/);
  now = 40001;
  assert.equal(queue.status().online, false);
  queue.poll('pc', 'second');
});

test('bridge: agent prints once despite lost result ACK, duplicate claim, and process restart', async t => {
  const { dir, file, queue } = fixture(t);
  let prints = 0, lost = true;
  const fileJournal = path.join(dir, 'journal.json');
  let delivered;
  const adapter = async (route, body) => {
    const result = await request(queue)(route, body);
    if (route === '/poll' && result.job) delivered = result.job;
    if (route === '/result' && lost) { lost = false; throw new Error('lost ACK'); }
    return result;
  };
  const printer = { print: async () => { prints++; return '结果 : 任务已离开队列'; } };
  const agent = createAgent({ file: fileJournal, printer, request: adapter });
  await agent.tick();
  const answer = queue.print({ text: '桥接测试' }, null, { requestId: 'watch:1' });
  await assert.rejects(agent.tick(), /lost ACK/);
  assert.match(await answer, /已离开队列/);
  await agent.tick();
  const restarted = createAgent({ file: fileJournal, printer,
    request: async (route, body) => route === '/poll' ? { job: delivered } : queue.result(body.agentId, body) });
  await restarted.tick();
  assert.equal(prints, 1);
  const cloudRestart = createPrintQueue({ file });
  assert.match(await cloudRestart.print({ text: '桥接测试' }, null, { requestId: 'watch:1' }), /已离开队列/);
  await assert.rejects(cloudRestart.print({ text: 'changed' }, null, { requestId: 'watch:1' }), /内容发生变化/);
});

test('bridge: no claimed-job redelivery; timeouts cancel queued jobs and mark claims uncertain', async t => {
  let now = 0;
  const { queue } = fixture(t, { now: () => now, waitMs: 100 });
  queue.poll('pc', 'instance');
  const first = queue.print({ text: '1' }, null, { requestId: 'first' });
  const job = queue.poll('pc', 'instance').job;
  assert.ok(job);
  const second = queue.print({ text: '2' }, null, { requestId: 'second' });
  assert.equal(queue.poll('pc', 'instance').job, null);
  now = 101;
  assert.equal(queue.poll('pc', 'instance').job, null);
  assert.match(await first, /状态未确认/);
  assert.match(await second, /未及时领取/);
  assert.deepEqual(queue.status().jobs.map(job => job.state), ['uncertain', 'failed']);
  queue.result('pc', { id: job.id, state: 'succeeded', result: '结果 : 任务已离开队列' });
  assert.equal(queue.status().jobs[0].state, 'succeeded');
});

test('bridge: cloud restart and cancellation never requeue claimed jobs', async t => {
  const { file, queue } = fixture(t);
  queue.poll('pc', 'instance');
  const controller = new AbortController();
  const pending = queue.print({ text: '1' }, controller.signal, { requestId: '1' });
  queue.poll('pc', 'instance');
  const recovered = createPrintQueue({ file });
  assert.equal(recovered.status().jobs[0].state, 'uncertain');
  assert.equal(recovered.poll('pc', 'new').job, null);
  controller.abort();
  assert.match(await pending, /状态未确认/);
});

test('agent: restart during printing reports uncertainty without calling printer', async t => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'journal.json');
  fs.writeFileSync(file, JSON.stringify({ agentId: 'pc', jobs: { old: { state: 'printing', reported: false } } }));
  const reports = [];
  const agent = createAgent({ file, printer: { print: () => assert.fail('must not reprint') },
    request: async (route, body) => { if (route === '/result') reports.push(body); return { job: null }; } });
  await agent.tick();
  assert.equal(reports[0].state, 'uncertain');
  assert.match(reports[0].result, /上次执行时中断/);
});

test('agent: printer failure is reported, persisted and never automatically retried', async t => {
  const { dir, queue } = fixture(t);
  let prints = 0;
  const agent = createAgent({ file: path.join(dir, 'journal.json'), request: request(queue),
    printer: { print: async () => { prints++; throw new Error('SECRET'); } } });
  await agent.tick();
  const pending = queue.print({ text: '1' }, null, { requestId: '1' });
  await agent.tick();
  assert.match(await pending, /未确认/);
  await agent.tick();
  assert.equal(prints, 1);
  assert.ok(!JSON.stringify(queue.status()).includes('SECRET'));
});

test('bridge HTTP: independent auth and existing watch protocol returns print result', async t => {
  const { queue, dir } = fixture(t);
  const token = 'b'.repeat(64);
  const bridge = createBridgeServer(token, queue);
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); bridge.closeAllConnections(); });
  const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  assert.equal((await fetch(bridgeUrl + '/status')).status, 401);
  assert.equal((await fetch(bridgeUrl + '/status', { headers: { Authorization: 'Bearer watch-token' } })).status, 401);
  async function post(route, body) {
    const res = await fetch(bridgeUrl + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    assert.equal(res.status, 200); return res.json();
  }
  const agent = createAgent({ file: path.join(dir, 'journal.json'), request: post,
    printer: { print: async () => '结果 : 任务已离开队列，打印机状态 就绪' } });
  await agent.tick();
  const keyFile = path.join(dir, 'key');
  fs.writeFileSync(keyFile, 'sk-FAKE_TEST_ONLY_0123456789');
  const ai = createDeepSeek({ keyFile, printEnabled: true, printer: queue,
    fetch: async () => Response.json({ choices: [{ message: { tool_calls: [{ id: 'p1', type: 'function',
      function: { name: 'print_text', arguments: '{"text":"打印桥接测试"}' } }] } }] }) });
  const watch = createServer('watch-token', ai);
  await new Promise(resolve => watch.listen(0, '127.0.0.1', resolve));
  t.after(() => { watch.close(); watch.closeAllConnections(); });
  async function sync(outgoing) {
    const res = await fetch(`http://127.0.0.1:${watch.address().port}/api/sync`, { method: 'POST',
      headers: { Authorization: 'Bearer watch-token' },
      body: JSON.stringify({ source: 'watch', session: '', after: 0, outgoing }) });
    return res.json();
  }
  assert.equal((await sync({ id: 'test', text: '帮我打印测试' })).ack, 'test');
  for (let i = 0; i < 100 && !queue.status().jobs.length; i++) await new Promise(r => setTimeout(r, 10));
  await agent.tick();
  let response;
  for (let i = 0; i < 100; i++) {
    response = await sync();
    if (response.messages.some(m => m.source === 'pc')) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.match(response.messages.at(-1).text, /任务已离开队列/);
  assert.equal((await fetch(`http://127.0.0.1:${watch.address().port}/poll`, { method: 'POST' })).status, 404);
});
