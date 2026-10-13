const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server.cjs');
const { createDeepSeek } = require('./deepseek.cjs');

async function fixture(t, generate) {
  const server = createServer('test-token', { generate, model: 'test-model' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (source = 'pc', outgoing = null, session = '', after = 0) => {
    const res = await fetch(base + '/api/sync', {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, outgoing, session, after })
    });
    return { code: res.status, ...await res.json() };
  };
}
async function waitFor(sync, predicate) {
  for (let i = 0; i < 100; i++) {
    const result = await sync();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected AI state within 1 second');
}

test('AI: watch ACK is immediate, retry is deduplicated, chunks reach unchanged watch transport', async t => {
  let resolve, calls = 0;
  const sync = await fixture(t, () => { calls++; return new Promise(done => { resolve = done; }); });
  const outgoing = { id: 'watch-q1', text: 'hello' };
  const sent = await sync('watch', outgoing);
  assert.equal(sent.ack, outgoing.id);
  assert.equal(sent.messages.length, 1);
  await waitFor(sync, data => data.ai.jobs[0].state === 'generating');
  await sync('watch', outgoing);
  assert.equal(calls, 1);
  resolve('😀你好'.repeat(200));
  const ready = await waitFor(sync, data => data.ai.jobs[0].state === 'succeeded');
  const replies = ready.messages.filter(message => message.source === 'pc');
  assert.equal(replies.length, 4);
  assert.ok(replies.every(message => Array.from(message.text).length <= 120 && message.origin === 'ai'));
  assert.ok(replies.at(-1).text.endsWith('…'));
  const received = await sync('watch', null, sent.session, sent.cursor);
  assert.deepEqual(received.messages, replies);
  await sync('watch', null, received.session, received.cursor);
  assert.equal((await sync()).watchCursor, received.cursor);
  assert.equal(calls, 1);
});

test('AI: web question and manual send stay distinct; mode changes cannot reuse an ID', async t => {
  const questions = [];
  const sync = await fixture(t, async text => { questions.push(text); return '简短回答'; });
  const ask = { id: 'web-q1', text: '介绍自己', ai: true };
  const sent = await sync('pc', ask);
  assert.equal(sent.messages[0].source, 'user');
  await waitFor(sync, data => data.ai.jobs[0].state === 'succeeded');
  await sync('pc', ask);
  assert.deepEqual(questions, ['介绍自己']);
  assert.equal((await sync('pc', { ...ask, ai: false })).code, 409);
  assert.equal((await sync('pc', { id: 'manual', text: '你好手表', ai: false })).code, 200);
  assert.deepEqual(questions, ['介绍自己']);
  assert.equal((await sync('pc', { id: 'long', text: 'x'.repeat(1001), ai: true })).code, 400);
  const watch = await sync('watch');
  assert.deepEqual(watch.messages.filter(message => message.source === 'pc').map(message => message.text), ['[AI] 简短回答', '你好手表']);
});

test('AI: failure is sanitized and next queued request succeeds without automatic model retry', async t => {
  let calls = 0;
  const sync = await fixture(t, async () => { if (++calls === 1) throw new Error('secret-upstream-detail'); return '第二次成功'; });
  await sync('watch', { id: 'fail', text: 'one' });
  await sync('watch', { id: 'ok', text: 'two' });
  const data = await waitFor(sync, data => data.ai.jobs[1]?.state === 'succeeded');
  assert.equal(data.ai.jobs[0].state, 'failed');
  assert.ok(!JSON.stringify(data).includes('secret-upstream-detail'));
  assert.equal(calls, 2);
});

test('AI: sequential bounded queue rejects overflow and shutdown aborts provider', async t => {
  let calls = 0, capturedSignal;
  const sync = await fixture(t, (_, signal) => { calls++; capturedSignal = signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve('stopped'))); });
  await sync('watch', { id: 'active', text: 'one' });
  await waitFor(sync, data => data.ai.jobs[0].state === 'generating');
  for (let i = 0; i < 9; i++) await sync('watch', { id: 'queued-' + i, text: 'two' });
  const data = await sync();
  assert.equal(data.ai.jobs.filter(job => job.state === 'queued').length, 8);
  assert.equal(data.ai.jobs.at(-1).state, 'failed');
  assert.equal(calls, 1);
  t.after(() => assert.equal(capturedSignal.aborted, true));
});

test('DeepSeek client: fixed endpoint/auth, disabled thinking, response extraction and safe errors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-ai-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.txt');
  const fakeKey = 'sk-FAKE_TEST_ONLY_0123456789';
  await fs.writeFile(keyFile, fakeKey);
  let failure = false;
  const provider = createDeepSeek({ keyFile, fetch: async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer ' + fakeKey);
    const body = JSON.parse(request.body);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.stream, false);
    assert.equal(body.messages[1].content, 'Hello');
    return failure ? new Response('sensitive-provider-body', { status: 401 }) : Response.json({ choices: [{ message: { content: ' 测试回复 ', reasoning_content: 'hidden' } }] });
  } });
  assert.equal(await provider.generate('Hello'), '测试回复');
  failure = true;
  await assert.rejects(provider.generate('Hello'), { message: 'DeepSeek 密钥无效' });
});
