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
  return async (source = 'pc', outgoing = null, session = '', after = 0, extras = {}) => {
    const res = await fetch(base + '/api/sync', {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, outgoing, session, after, ...extras })
    });
    return { code: res.status, ...await res.json() };
  };
}

test('AI: watch conversation context is reused and reset at a fresh app entry', async t => {
  const contexts = [];
  const sync = await fixture(t, async (text, signal, context) => {
    contexts.push({ text, history: context.history });
    return '回答：' + text;
  });
  const conversationId = 'watch-session';
  const first = await sync('watch', { id: 'context-1', text: '我叫小明' }, '', 0,
    { conversationId, conversationEpoch: 1 });
  await waitFor(sync, data => data.ai.jobs[0].state === 'succeeded');
  const second = await sync('watch', { id: 'context-2', text: '我叫什么？' }, first.session, first.cursor,
    { conversationId, conversationEpoch: 1 });
  await waitFor(sync, data => data.ai.jobs[1].state === 'succeeded');
  assert.deepEqual(contexts[0].history, []);
  assert.deepEqual(contexts[1].history, [
    { role: 'user', content: '我叫小明' },
    { role: 'assistant', content: '回答：我叫小明' }
  ]);
  await sync('watch', { id: 'context-3', text: '你还记得吗？' }, second.session, second.cursor,
    { conversationId, conversationEpoch: 2 });
  await waitFor(sync, data => data.ai.jobs[2].state === 'succeeded');
  assert.deepEqual(contexts[2].history, []);
});
async function waitFor(sync, predicate) {
  for (let i = 0; i < 100; i++) {
    const result = await sync();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected AI state within 1 second');
}

async function complete(sync, id, text, extras, source = 'watch') {
  const sent = await sync(source, { id, text, ...(source === 'pc' ? { ai: true } : {}) }, '', 0, extras);
  assert.equal(sent.code, 200);
  await waitFor(sync, data => data.ai.jobs.some(job => job.requestId === id && job.state === 'succeeded'));
}

test('AI: re-entry fences active, queued and pending old questions; reset retries and stale polls cannot restore memory', async t => {
  const calls = [];
  let resolveOld;
  const sync = await fixture(t, async (text, signal, context) => {
    calls.push({ text, history: context.history });
    if (text === '旧问题生成中') return new Promise(resolve => { resolveOld = resolve; });
    return '回答：' + text;
  });
  const old = { conversationId: 'reentry', conversationEpoch: 1 };
  const fresh = { ...old, conversationEpoch: 2 };
  await complete(sync, 'seed', '旧会话背景', old);
  await sync('watch', { id: 'active-old', text: '旧问题生成中' }, '', 0, old);
  await waitFor(sync, data => data.ai.jobs.some(job => job.requestId === 'active-old' && job.state === 'generating'));
  await sync('watch', { id: 'queued-old', text: '旧排队问题' }, '', 0, old);
  // Re-entry clears even when there is no new question. Replaying the same
  // entry after a lost HTTP response must be idempotent.
  assert.equal((await sync('watch', null, '', 0, fresh)).code, 200);
  await sync('watch', null, '', 0, fresh);
  await sync('watch', { id: 'fresh-1', text: '新会话背景' }, '', 0, fresh);
  resolveOld('迟到的旧回答');
  await waitFor(sync, data => data.ai.jobs.some(job => job.requestId === 'fresh-1' && job.state === 'succeeded'));
  assert.equal(calls[1].history[0].content, '旧会话背景');
  assert.deepEqual(calls[2].history, []);
  assert.deepEqual(calls[3].history, []);
  // A delayed old poll, old upload retry, and first delivery of a pending old
  // upload must not reset or join the current conversation.
  await sync('watch', null, '', 0, old);
  await sync('watch', { id: 'active-old', text: '旧问题生成中', conversationEpoch: 1 }, '', 0, fresh);
  await sync('watch', { id: 'pending-old', text: '此前未上传的问题', conversationEpoch: 1 }, '', 0, fresh);
  await waitFor(sync, data => data.ai.jobs.some(job => job.requestId === 'pending-old' && job.state === 'succeeded'));
  assert.deepEqual(calls[4].history, []);
  await complete(sync, 'fresh-2', '继续追问', fresh);
  assert.deepEqual(calls[5].history, [
    { role: 'user', content: '新会话背景' },
    { role: 'assistant', content: '回答：新会话背景' }
  ]);
  assert.equal(calls.length, 6);
});

test('AI: clients and sources are isolated; failed turns and invalid resets do not change memory', async t => {
  const calls = [];
  const sync = await fixture(t, async (text, signal, context) => {
    calls.push({ text, history: context.history });
    if (text === '失败问题') throw new Error('private failure');
    return '回答：' + text;
  });
  const main = { conversationId: 'client-a', conversationEpoch: 1 };
  await complete(sync, 'a1', '有效背景', main);
  await complete(sync, 'b1', '其他设备', { ...main, conversationId: 'client-b' });
  await complete(sync, 'pc1', '网页内容', main, 'pc');
  await complete(sync, 'legacy', '旧版本独立提问', {});
  assert.ok(calls.slice(1).every(call => call.history.length === 0));
  await sync('watch', { id: 'failed', text: '失败问题' }, '', 0, main);
  await waitFor(sync, data => data.ai.jobs.some(job => job.requestId === 'failed' && job.state === 'failed'));
  for (const invalid of [
    { conversationId: 'client-a' }, { conversationEpoch: 2 },
    { ...main, conversationEpoch: 0 }, { ...main, conversationEpoch: '2' }
  ]) assert.equal((await sync('watch', null, '', 0, invalid)).code, 400);
  assert.equal((await sync('watch', { id: 'invalid-reset', text: '' }, '', 0,
    { ...main, conversationEpoch: 2 })).code, 400);
  await complete(sync, 'a2', '追问', main);
  assert.deepEqual(calls.at(-1).history, [
    { role: 'user', content: '有效背景' },
    { role: 'assistant', content: '回答：有效背景' }
  ]);
});

test('AI: model context keeps complete recent turns within the round and character budgets', async t => {
  const histories = [];
  const sync = await fixture(t, async (text, signal, context) => {
    histories.push(context.history);
    return text;
  });
  const conversation = { conversationId: 'bounded', conversationEpoch: 1 };
  for (let i = 0; i < 8; i++) await complete(sync, 'short-' + i, '轮次' + i, conversation);
  assert.equal(histories[7].length, 12);
  assert.equal(histories[7][0].content, '轮次1');
  const next = { ...conversation, conversationEpoch: 2 };
  for (let i = 0; i < 4; i++) await complete(sync, 'long-' + i, '😀'.repeat(2000), next);
  const history = histories.at(-1);
  assert.equal(history.length, 4);
  assert.equal(history.reduce((n, message) => n + Array.from(message.content).length, 0), 8000);
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(history.every(message => message.content === '😀'.repeat(2000)));
});

test('DeepSeek: actual completion payload includes the previous turn and drops it after app re-entry', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-context-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.txt');
  await fs.writeFile(keyFile, 'sk-FAKE_TEST_ONLY_0123456789');
  const payloads = [];
  const provider = createDeepSeek({ keyFile, printEnabled: false, fetch: async (_, request) => {
    const body = JSON.parse(request.body);
    payloads.push(body);
    return Response.json({ choices: [{ message: { content: '好的，小明。' } }] });
  } });
  const sync = await fixture(t, provider.generate);
  const conversation = { conversationId: 'wire-test', conversationEpoch: 1 };
  await complete(sync, 'wire-1', '我叫小明', conversation);
  await complete(sync, 'wire-2', '我叫什么？', conversation);
  assert.deepEqual(payloads[1].messages.slice(1), [
    { role: 'user', content: '我叫小明' },
    { role: 'assistant', content: '好的，小明。' },
    { role: 'user', content: '我叫什么？' }
  ]);
  assert.ok(!payloads[1].messages[0].content.includes('每次问题独立回答'));
  await complete(sync, 'wire-3', '我叫什么？', { ...conversation, conversationEpoch: 2 });
  assert.deepEqual(payloads[2].messages.slice(1), [{ role: 'user', content: '我叫什么？' }]);
});

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

test('DeepSeek server mode: only search tools are registered and unexpected printing cannot execute', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-cloud-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.txt');
  await fs.writeFile(keyFile, 'sk-FAKE_TEST_ONLY_0123456789');
  let calls = 0, prints = 0;
  const provider = createDeepSeek({ keyFile, printEnabled: false,
    printer: { print: async () => { prints++; return 'unexpected'; } },
    fetch: async (_, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.tools.length, 4);
      assert.ok(body.tools.every(tool => tool.function.name.startsWith('anysearch_')));
      assert.match(body.messages[0].content, /不支持实际打印/);
      assert.ok(!body.messages[0].content.includes('时调用一次 print_text'));
      if (calls++ === 0) return Response.json({ choices: [{ message: { content: '服务器问答正常' } }] });
      return Response.json({ choices: [{ message: { tool_calls: [{ type: 'function',
        function: { name: 'print_text', arguments: '{"text":"禁止执行"}' } }] } }] });
    }
  });
  assert.equal(await provider.generate('你好'), '服务器问答正常');
  await assert.rejects(provider.generate('打印测试'), /服务器未启用打印/);
  assert.equal(prints, 0);
});
