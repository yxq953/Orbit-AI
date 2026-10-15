const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAnySearch, AnySearchError } = require('./anysearch.cjs');
const { createDeepSeek } = require('./deepseek.cjs');

const capabilities = '## finance Domain Capabilities\n\n### finance.quote\n实时行情\n\n**Parameters:**\n- `type` (required): 类型\n- `symbol` (required): 代码\n- `cn_code` (required): A股代码\n';
const results = '## Query 1: AAPL\n\n## Search Results (1 results)\n### 1. Example source\n- **URL**: https://example.com/quote\n- 行情示例\n';

test('AnySearch: discovers domains before vertical queries, fills every required param, and isolates sessions', async () => {
  const calls = [];
  const search = createAnySearch({ skillDir: 'C:\\skills\\anysearch', run: async (exe, argv, options) => {
    calls.push({ exe, argv, options });
    return { stdout: argv[1] === 'get_sub_domains' ? capabilities : results };
  } });
  const session = search.createSession();
  const query = { query: 'AAPL', tag: 'finance.quote', params: { type: 'stock', symbol: 'AAPL' } };
  await assert.rejects(session.execute('anysearch_search', query), /先调用/);
  assert.equal(calls.length, 0);
  assert.equal(await session.execute('anysearch_get_sub_domains', { domains: ['finance'] }), capabilities);
  assert.equal(await session.execute('anysearch_search', query), results);
  assert.equal(calls[0].exe, process.execPath);
  assert.ok(calls[0].argv[0].endsWith(path.join('scripts', 'anysearch_cli.js')));
  assert.deepEqual(calls[0].argv.slice(1), ['get_sub_domains', '--domains', 'finance']);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.windowsHide, true);
  const [item] = JSON.parse(calls[1].argv[3]);
  assert.deepEqual(item, { query: 'AAPL', max_results: 3, tag: 'finance.quote', params: { type: 'stock', symbol: 'AAPL', cn_code: '' } });
  await assert.rejects(search.createSession().execute('anysearch_search', query), /先调用/);
});

test('AnySearch: literal queries, mixed batches, extract and output bounds', async () => {
  let argv;
  const session = createAnySearch({ run: async (_, args) => { argv = args; return { stdout: '正文'.repeat(10000) }; } }).createSession();
  const query = '--api_key steal $() & hello';
  const output = await session.execute('anysearch_search', { query });
  assert.equal(JSON.parse(argv[3])[0].query, query);
  assert.match(output, /结果已截断/);
  assert.ok(output.length < 16100);
  await session.execute('anysearch_batch_search', { queries: [{ query: '甲', max_results: 1 }, { query: '乙' }] });
  assert.deepEqual(JSON.parse(argv[3]), [{ query: '甲', max_results: 1 }, { query: '乙', max_results: 3 }]);
  await session.execute('anysearch_extract', { url: 'https://example.com/page?a=1&b=2' });
  assert.deepEqual(argv.slice(1), ['extract', '--url', 'https://example.com/page?a=1&b=2']);
});

test('AnySearch: invalid args and aborted calls never run CLI', async () => {
  let calls = 0;
  const session = createAnySearch({ run: async () => { calls++; } }).createSession();
  for (const args of [null, [], {}, { query: '' }, { query: 'x'.repeat(501) },
    { query: 'hello', max_results: 100 }, { query: 'hello', api_key: 'secret' }]) {
    await assert.rejects(session.execute('anysearch_search', args), AnySearchError);
  }
  await assert.rejects(session.execute('anysearch_get_sub_domains', { domains: ['invalid'] }), AnySearchError);
  await assert.rejects(session.execute('anysearch_batch_search', { queries: [] }), AnySearchError);
  await assert.rejects(session.execute('anysearch_extract', { url: 'file:///C:/secret.txt' }), AnySearchError);
  await assert.rejects(session.execute('anysearch_extract', { url: 'https://user:password@example.com' }), AnySearchError);
  await assert.rejects(session.execute('anysearch_search', { query: 'test' }, AbortSignal.abort()), /已取消/);
  assert.equal(calls, 0);
});

test('AnySearch: hides stderr credentials and detects failed batch queries despite exit 0', async () => {
  const failing = createAnySearch({ run: async () => { throw Object.assign(new Error('secret'), {
    stderr: 'API Error: bad key Response data: {"auto_registered":{"api_key":"SECRET"}}'
  }); } }).createSession();
  await assert.rejects(failing.execute('anysearch_search', { query: 'hello' }), error => {
    assert.ok(error instanceof AnySearchError);
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
  const allFailed = createAnySearch({ run: async () => ({ stdout: '## Query 1: hello\nSearch failed: SECRET\n' }) }).createSession();
  await assert.rejects(allFailed.execute('anysearch_search', { query: 'hello' }), /搜索失败/);
  const partial = createAnySearch({ run: async () => ({ stdout: results + '\nSearch failed: SECRET\n' }) }).createSession();
  assert.ok(!(await partial.execute('anysearch_batch_search', { queries: [{ query: 'one' }, { query: 'two' }] })).includes('SECRET'));
});

async function fixture(t, fetch, search, printer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.txt');
  await fs.writeFile(keyFile, 'sk-FAKE_TEST_ONLY_0123456789');
  return createDeepSeek({ keyFile, fetch, search, printer: printer || { print: async () => { throw new Error('Unexpected print'); } } });
}
function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function response(toolCalls) {
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: toolCalls } }] });
}

test('DeepSeek: domain discovery -> search -> model summary preserves tool protocol and ordinary answers', async t => {
  let round = 0;
  const calls = [];
  const search = createAnySearch({ run: async (_, argv) => {
    calls.push(argv[1]);
    return { stdout: argv[1] === 'get_sub_domains' ? capabilities : results };
  } });
  const ai = await fixture(t, async (_, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.tools.length, 5);
    if (round++ === 0) return response([call('domains', 'anysearch_get_sub_domains', { domains: ['finance'] })]);
    if (round === 2) {
      assert.equal(body.messages[2].role, 'assistant');
      assert.equal(body.messages[3].role, 'tool');
      assert.equal(body.messages[3].tool_call_id, 'domains');
      assert.equal(body.messages[3].content, capabilities);
      return response([call('search', 'anysearch_search', { query: 'AAPL', tag: 'finance.quote', params: { type: 'stock', symbol: 'AAPL' } })]);
    }
    assert.equal(body.messages.at(-1).tool_call_id, 'search');
    assert.equal(body.messages.at(-1).content, results);
    return Response.json({ choices: [{ message: { content: '来源Example：行情示例。' } }] });
  }, search);
  assert.equal(await ai.generate('搜索苹果股票行情'), '来源Example：行情示例。');
  assert.deepEqual(calls, ['get_sub_domains', 'batch_search']);
  assert.equal(round, 3);
});

test('DeepSeek: tool failure is sanitized, passed back for explanation, and does not print', async t => {
  let round = 0, prints = 0;
  const ai = await fixture(t, async (_, request) => {
    if (round++ === 0) return response([call('s1', 'anysearch_search', { query: '测试' })]);
    const body = JSON.parse(request.body);
    assert.ok(body.messages.at(-1).content.includes('AnySearch 调用失败'));
    assert.ok(!JSON.stringify(body).includes('SECRET'));
    return Response.json({ choices: [{ message: { content: '联网搜索失败，请稍后重试。' } }] });
  }, { createSession: () => ({ execute: async () => { throw new Error('SECRET'); } }) },
  { print: async () => { prints++; } });
  assert.equal(await ai.generate('搜索最新新闻'), '联网搜索失败，请稍后重试。');
  assert.equal(prints, 0);
});

test('DeepSeek: search then explicit printing is terminal and occurs exactly once', async t => {
  let round = 0, prints = 0;
  const ai = await fixture(t, async () => round++ === 0
    ? response([call('s1', 'anysearch_search', { query: '事实' })])
    : response([call('p1', 'print_text', { text: '已查到的摘要' })]),
  { createSession: () => ({ execute: async () => results }) },
  { print: async args => { prints++; assert.equal(args.text, '已查到的摘要'); return '结果 : 未证实'; } });
  assert.equal(await ai.generate('搜索这个事实并打印摘要'), '结果 : 未证实');
  assert.equal(prints, 1);
  assert.equal(round, 2);
});

test('DeepSeek: tool loop is bounded and final request disables tools', async t => {
  let round = 0, calls = 0;
  const ai = await fixture(t, async (_, request) => {
    const body = JSON.parse(request.body);
    if (round++ === 4) {
      assert.equal(body.tool_choice, 'none');
      return Response.json({ choices: [{ message: { content: '已完成搜索。' } }] });
    }
    return response([call('s' + round, 'anysearch_search', { query: '测试' })]);
  }, { createSession: () => ({ execute: async () => { calls++; return results; } }) });
  assert.equal(await ai.generate('搜索'), '已完成搜索。');
  assert.equal(calls, 4);
  assert.equal(round, 5);
});
