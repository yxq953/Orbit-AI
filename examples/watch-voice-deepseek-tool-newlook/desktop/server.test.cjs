const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('./server.cjs');

test('HTTP: bidirectional Unicode, retry deduplication, delivery acknowledgement and validation', async t => {
  const server = createServer('test-token', { generate: () => new Promise(() => {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function sync(source, session = '', after = 0, outgoing = null, token = 'test-token') {
    const res = await fetch(url + '/api/sync', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, session, after, outgoing })
    });
    return { code: res.status, ...await res.json() };
  }
  assert.equal((await sync('pc', '', 0, null, 'wrong')).code, 401);
  assert.equal((await sync('pc', '', 0, { id: 'long', text: 'x'.repeat(121) })).code, 400);
  assert.equal((await sync('watch', '', 0, { id: 'empty', text: '   ' })).code, 400);
  const watchSent = await sync('watch', '', 0, { id: 'watch-1', text: 'ABC123' });
  assert.equal(watchSent.ack, 'watch-1');
  const pc = await sync('pc');
  assert.equal(pc.messages[0].text, 'ABC123');
  const pcSent = await sync('pc', pc.session, pc.cursor, { id: 'pc-1', text: '你好手表 😀' });
  assert.equal(pcSent.ack, 'pc-1');
  const retry = await sync('pc', pc.session, pc.cursor, { id: 'pc-1', text: '你好手表 😀' });
  assert.equal(retry.messages.length, 1);
  assert.equal(retry.cursor, pcSent.cursor);
  assert.equal((await sync('pc', pc.session, pc.cursor, { id: 'pc-1', text: 'changed' })).code, 409);
  const received = await sync('watch', watchSent.session, watchSent.cursor);
  assert.equal(received.messages[0].text, '你好手表 😀');
  await sync('watch', received.session, received.cursor);
  const delivered = await sync('pc', pcSent.session, pcSent.cursor);
  assert.equal(delivered.watchCursor, pcSent.cursor);
  assert.ok(delivered.watchLastSeen > 0);
  for (let i = 0; i < 23; i++) await sync('pc', pc.session, pcSent.cursor, { id: 'batch-' + i, text: String(i) });
  const batch1 = await sync('watch', received.session, received.cursor);
  assert.equal(batch1.messages.length, 20);
  const batch2 = await sync('watch', batch1.session, batch1.cursor);
  assert.equal(batch2.messages.length, 3);
  const newSession = await sync('watch', 'old-server-session', 99999);
  assert.equal(newSession.messages[0].id, 1);
});

test('watch transport: lost reply retries same ID, hides safely, rejects stale callbacks', async () => {
  const source = await fs.readFile(require('node:path').join(__dirname, '../src/common/channel.js'), 'utf8');
  const { createChannel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const jobs = new Map();
  let job = 0;
  const timers = {
    setTimeout(callback, delay) { const id = ++job; jobs.set(id, { callback, delay }); return id; },
    clearTimeout(id) { jobs.delete(id); }
  };
  function run(delay) {
    const entry = [...jobs].find(([, value]) => value.delay === delay);
    assert.ok(entry, 'Expected timer ' + delay);
    jobs.delete(entry[0]); entry[1].callback();
  }
  const requests = [], received = [], sent = [], status = [];
  const channel = createChannel({ fetch: options => requests.push(options) }, { url: 'http://pc', token: 'test' }, {
    receive: text => received.push(text), sent: text => sent.push(text), status: text => status.push(text)
  }, timers);
  function success(index, messages = [], ack = null, cursor = 0) {
    requests[index].success({ code: 200, data: JSON.stringify({ session: 'session', messages, ack, cursor }) });
  }
  channel.start(); success(0);
  assert.equal(channel.send('abc'), true);
  assert.equal(channel.send('def'), false);
  const id = JSON.parse(requests[1].data).outgoing.id;
  run(15000);
  success(1, [{ id: 1, source: 'pc', text: 'late' }], id, 1);
  assert.deepEqual(sent, []);
  assert.deepEqual(received, []);
  run(2500);
  assert.equal(JSON.parse(requests[2].data).outgoing.id, id);
  success(1, [{ id: 1, source: 'pc', text: 'stale' }], id, 1);
  assert.deepEqual(received, []);
  success(2, [{ id: 2, source: 'pc', text: '你好' }], id, 2);
  assert.deepEqual(sent, ['abc']); assert.deepEqual(received, ['你好']);
  run(2500);
  assert.equal(JSON.parse(requests[3].data).after, 2);
  channel.stop();
  success(3, [{ id: 3, source: 'pc', text: 'hidden' }], null, 3);
  assert.deepEqual(received, ['你好']); assert.equal(jobs.size, 0);
  channel.start();
  success(4, [{ id: 2, source: 'pc', text: '你好' }, { id: 3, source: 'pc', text: 'next' }], null, 3);
  assert.deepEqual(received, ['你好', 'next']);
  channel.stop();
});
