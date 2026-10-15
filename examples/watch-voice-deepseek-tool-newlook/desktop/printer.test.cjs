const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPrinter, PrinterError } = require('./printer.cjs');
const { createDeepSeek } = require('../cloud/deepseek.cjs');
const { createServer } = require('../cloud/server.cjs');

const output = '打印机 : Test HP\n规模   : 1 页 x 1 份 = 1 张（单面）\n任务号 : [123]\n结果   : 任务已离开队列，打印机状态 就绪\n';

async function provider(t, fetch, printer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-print-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key.txt');
  await fs.writeFile(keyFile, 'sk-FAKE_TEST_ONLY_0123456789');
  return createDeepSeek({ keyFile, fetch, printer });
}

function toolResponse(args = { text: '你好打印机' }, name = 'print_text') {
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  } }] });
}

test('printer: uses current script, explicit printer, one copy, safe literal Unicode arguments and verification', async () => {
  let invocation;
  const printer = createPrinter({ python: 'C:\\Python\\python.exe', printer: 'Test HP', dryRun: false,
    run: async (...args) => { invocation = args; return { stdout: output }; } });
  const text = '--copies 99\n你好 $() & "打印"\n' + '中文'.repeat(20);
  const answer = await printer.print({ text });
  const [exe, argv, options] = invocation;
  assert.equal(exe, 'C:\\Python\\python.exe');
  assert.ok(path.isAbsolute(argv[1]));
  assert.ok(argv[1].endsWith(path.join('tool', 'print', 'scripts', 'print.py')));
  assert.equal(argv[argv.indexOf('--printer') + 1], 'Test HP');
  assert.equal(argv[argv.indexOf('--copies') + 1], '1');
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  const lines = argv.slice(argv.indexOf('--') + 1);
  assert.equal(lines[0], '--copies 99');
  assert.equal(lines[1], '你好 $() & "打印"');
  assert.ok(lines.every(line => Array.from(line).length <= 24));
  assert.equal(lines.slice(2).join(''), '中文'.repeat(20));
  assert.match(answer, /1 页 x 1 份/);
  assert.match(answer, /任务号 : \[123\]/);
  assert.match(answer, /任务已离开队列/);
});

test('printer: preserves pending, unverified and dry-run results without claiming success', async () => {
  for (const result of ['结果 : 超时，任务仍在队列 123(缺纸)',
    '结果 : 提交后队列里没看到对应任务，可能已被打印机瞬间取走',
    '[dry-run] print_text 共 1 页 x 1 份 = 1 张（单面），未发送任务']) {
    const printer = createPrinter({ dryRun: true, run: async (_, argv) => {
      assert.ok(argv.includes('--dry-run'));
      return { stdout: result };
    } });
    assert.equal(await printer.print({ text: '测试' }), result);
  }
});

test('printer: invalid or cancelled requests never spawn; failures are sanitized and never retried', async () => {
  let calls = 0;
  const printer = createPrinter({ run: async () => { calls++; throw new Error('secret details'); } });
  for (const args of [null, [], {}, { text: '' }, { text: ' ' }, { text: 'x'.repeat(501) },
    { text: '\0' }, { text: '你好', copies: 100 }, { text: 'a\n'.repeat(40) }]) {
    await assert.rejects(printer.print(args), PrinterError);
  }
  await assert.rejects(printer.print({ text: '测试' }, AbortSignal.abort()), /未调用打印工具/);
  assert.equal(calls, 0);
  await assert.rejects(printer.print({ text: '测试' }), /任务状态未确认/);
  assert.equal(calls, 1);
  const timeout = createPrinter({ run: async () => { throw Object.assign(new Error(), { killed: true }); } });
  await assert.rejects(timeout.print({ text: '测试' }), /任务可能已提交/);
});

test('DeepSeek: registers automatic tool and executes once with null assistant content', async t => {
  const requests = [], prints = [];
  const ai = await provider(t, async (_, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    assert.equal(body.tools[0].function.name, 'print_text');
    assert.equal(body.tool_choice, 'auto');
    return toolResponse();
  }, { print: async (args, signal) => { prints.push({ args, signal }); return output; } });
  const signal = new AbortController().signal;
  assert.equal(await ai.generate('帮我打印：你好打印机', signal), output);
  assert.equal(requests.length, 1);
  assert.equal(prints.length, 1);
  assert.deepEqual(prints[0].args, { text: '你好打印机' });
  assert.equal(prints[0].signal.aborted, false);
});

test('DeepSeek: ordinary answers do not print; unknown, malformed and multiple calls do not execute', async t => {
  let response, prints = 0;
  const ai = await provider(t, async () => response, { print: async () => { prints++; } });
  response = Response.json({ choices: [{ message: { content: '你好' } }] });
  assert.equal(await ai.generate('不要打印，只回答你好'), '你好');
  response = toolResponse({}, 'unknown');
  await assert.rejects(ai.generate('测试'), /仅支持/);
  response = Response.json({ choices: [{ message: { tool_calls: [
    { type: 'function', function: { name: 'print_text', arguments: '{' } }
  ] } }] });
  await assert.rejects(ai.generate('测试'), /参数格式无效/);
  response = Response.json({ choices: [{ message: { tool_calls: [{}, {}] } }] });
  await assert.rejects(ai.generate('测试'), /仅支持/);
  assert.equal(prints, 0);
});

test('HTTP: printing request retries deduplicate and result reaches existing watch protocol', async t => {
  let calls = 0;
  const printer = createPrinter({ dryRun: false, run: async () => { calls++; return { stdout: output }; } });
  const ai = await provider(t, async () => toolResponse(), printer);
  const server = createServer('test-token', ai);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function sync(source, outgoing = null, session = '', after = 0) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sync`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, outgoing, session, after })
    });
    assert.equal(res.status, 200);
    return res.json();
  }
  const outgoing = { id: 'print-1', text: '帮我打印：你好打印机' };
  const ack = await sync('watch', outgoing);
  assert.equal(ack.ack, outgoing.id);
  await sync('watch', outgoing);
  let ready;
  for (let i = 0; i < 100; i++) {
    ready = await sync('pc');
    if (ready.ai.jobs[0].state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(ready.ai.jobs[0].state, 'succeeded');
  assert.equal(calls, 1);
  const received = await sync('watch', null, ack.session, ack.cursor);
  assert.match(received.messages.map(message => message.text).join('\n'), /任务已离开队列/);
  assert.ok(received.messages.every(message => message.source === 'pc' && message.origin === 'ai'));
  await sync('watch', outgoing);
  assert.equal(calls, 1);
});
