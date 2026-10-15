const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRecorder } = require('../src/common/recorder')
const { createVoiceChat } = require('../src/common/voice-chat')
const { createServer } = require('../cloud/server.cjs')

async function fixture(t, generate = async () => '这是模型回复', loseAck = false, history = []) {
  const source = await fs.readFile(path.join(__dirname, '../src/common/channel.js'), 'utf8')
  const { createChannel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  let callback, next = 0, calls = 0, clears = 0, failNext = false
  const scheduled = new Map(), native = [], displayed = [], uploads = []
  const clock = {
    setTimeout(fn, delay) { const id = ++next; scheduled.set(id, { fn, delay }); return id },
    clearTimeout(id) { scheduled.delete(id) },
    setInterval(fn, delay) { const id = ++next; scheduled.set(id, { fn, delay }); return id },
    clearInterval(id) { scheduled.delete(id) }
  }
  const server = createServer('test-token', { generate: async (...args) => { calls++; return generate(...args) } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  async function pcSend(text, id, ai = false) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'pc', session: '', after: 0, outgoing: { id, text, ai } })
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  for (let i = 0; i < history.length; i++) await pcSend(history[i], 'history-' + i)
  const requests = []
  const chat = createVoiceChat({
    createRecorder, createChannel, clock,
    connection: { url: `http://127.0.0.1:${server.address().port}`, token: 'test-token' },
    fetchApi: { fetch(options) {
      if (failNext) { failNext = false; options.fail({}, 'offline'); return }
      const outgoing = JSON.parse(options.data).outgoing
      if (outgoing) uploads.push(outgoing)
      requests.push(fetch(options.url, { method: options.method, headers: options.header, body: options.data })
        .then(async response => {
          const data = await response.text()
          if (outgoing && loseAck) { loseAck = false; options.fail({}, 'lost-ack') }
          else options.success({ code: response.status, data })
        }))
    } },
    loadLibrary: () => ({
      js_regist_task_callback(fn) { callback = fn },
      js_unregist_task_callback() {},
      js_invoke_function(call) {
        native.push(call)
        if (call.func_name === 'startLongpolling') {
          callback({ task_id: call.task_id, error_code: 0,
            resp_body: JSON.stringify({ conversations: [{ conversation_name: 'actual-conversation' }] }) })
        }
      }
    }),
    hooks: {
      message(prefix, text) { displayed.push(prefix + text) },
      clear() { clears++; displayed.length = 0 }
    }
  })
  async function drain() {
    while (requests.length) await requests.shift()
    await new Promise(resolve => setImmediate(resolve))
  }
  t.after(async () => {
    chat.dispose()
    await drain()
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  })
  function run(delay) {
    const entry = [...scheduled].find(([, value]) => value.delay === delay)
    assert.ok(entry, 'Expected timer ' + delay)
    scheduled.delete(entry[0]); entry[1].fn()
  }
  function reply(call, body, code = 0) {
    callback({ task_id: call.task_id, error_code: code, resp_body: JSON.stringify(body) })
  }
  async function pollUntil(predicate) {
    for (let i = 0; i < 20; i++) {
      await drain()
      if (predicate()) return
      run(2500)
    }
    assert.fail('Expected state did not arrive')
  }
  chat.show(); await drain()
  return {
    chat, native, displayed, uploads, scheduled, drain, run, reply, pollUntil, pcSend,
    calls: () => calls, clears: () => clears, failNextSync() { failNext = true }
  }
}

test('native transcription uploads full Unicode once despite lost ACK, receives all AI parts and unlocks next recording', async t => {
  const prompt = '请解释手表语音到模型回复的流程😀'.repeat(30)
  const f = await fixture(t, async text => { assert.equal(text, prompt); return '中文回答😀'.repeat(75) }, true)
  assert.equal(f.chat.snapshot().selection, '1/1')
  assert.equal(f.chat.start(), true)
  f.run(8000)
  const stop = f.native.find(call => call.func_name === 'stopRecord')
  assert.equal(stop.request_body, 'trans')
  f.reply(stop, { text: prompt })
  assert.equal(f.chat.start(), false)
  await f.drain()
  assert.equal(f.uploads[0].text, prompt)
  f.run(2500)
  await f.pollUntil(() => f.chat.snapshot().phase === '已收到回答，可继续录音提问')
  assert.equal(f.calls(), 1)
  assert.equal(f.uploads[0].id, f.uploads[1].id)
  assert.equal(f.displayed.filter(text => text.startsWith('AI: ')).length, 4)
  assert.equal(f.chat.start(), true)
  assert.ok(f.native.every(call => call.request_body !== 'send'))
})

test('empty recognition and cancelled late result never upload; background pauses HTTP and resumes delivery', async t => {
  let answer
  const f = await fixture(t, () => new Promise(resolve => { answer = resolve }))
  f.chat.start(); f.chat.finish()
  f.reply(f.native.at(-1), { text: '  ' })
  await f.drain()
  assert.equal(f.uploads.length, 0)
  f.chat.start(); f.chat.finish()
  const trans = f.native.at(-1)
  f.chat.cancel()
  const cancel = f.native.at(-1)
  f.reply(trans, { text: '迟到的文字' })
  f.reply(cancel, {})
  assert.equal(f.uploads.length, 0)
  f.chat.start(); f.chat.finish()
  f.reply(f.native.at(-1), { text: '正常问题' })
  await f.drain()
  f.chat.hide()
  answer('后台生成的回答')
  await f.drain()
  assert.equal(f.displayed.filter(text => text.startsWith('AI: ')).length, 0)
  f.chat.show()
  await f.pollUntil(() => f.chat.snapshot().phase === '已收到回答，可继续录音提问')
  assert.ok(f.displayed.some(text => text.includes('后台生成的回答')))
})

test('overlong transcription is displayed but never truncated or submitted to the model', async t => {
  const f = await fixture(t)
  f.chat.start(); f.chat.finish()
  const text = '字'.repeat(2001)
  f.reply(f.native.at(-1), { text })
  await f.drain()
  assert.equal(f.chat.snapshot().transcript, text)
  assert.match(f.chat.snapshot().phase, /超过 2000/)
  assert.equal(f.uploads.length, 0)
  assert.equal(f.calls(), 0)
})

test('model error returns safe text to watch and allows a new question', async t => {
  const f = await fixture(t, async () => { throw new Error('secret upstream body') })
  f.chat.start(); f.chat.finish()
  f.reply(f.native.at(-1), { text: '测试失败' })
  await f.pollUntil(() => f.chat.snapshot().phase === '已收到回答，可继续录音提问')
  assert.ok(f.displayed.some(text => text.includes('模型调用失败')))
  assert.ok(f.displayed.every(text => !text.includes('secret')))
  assert.equal(f.chat.start(), true)
})

test('returning to foreground before native cancellation finishes restores recorder foreground', async t => {
  const f = await fixture(t)
  assert.equal(f.chat.start(), true)
  f.chat.hide()
  const cancel = f.native.find(call => call.request_body === 'cancel')
  f.chat.show()
  f.reply(cancel, {})
  await f.drain()
  assert.equal(f.chat.start(), true)
})

test('multiple questions, polling, manual retry and duplicate show retain history; app re-entry clears once', async t => {
  const f = await fixture(t)
  f.chat.start(); f.chat.finish()
  f.reply(f.native.at(-1), { text: '旧问题' })
  await f.pollUntil(() => f.chat.snapshot().phase === '已收到回答，可继续录音提问')
  assert.ok(f.displayed.some(text => text.startsWith('AI: ')))
  const clears = f.clears()
  const displayed = [...f.displayed]
  f.run(2500); await f.drain()
  assert.equal(f.clears(), clears)
  assert.deepEqual(f.displayed, displayed)
  f.chat.retry(); await f.drain()
  assert.equal(f.clears(), clears)
  assert.deepEqual(f.displayed, displayed)
  f.chat.show(); await f.drain()
  assert.equal(f.clears(), clears)
  assert.deepEqual(f.displayed, displayed)
  assert.equal(f.chat.start(), true)
  assert.deepEqual(f.displayed, displayed)
  f.chat.finish()
  f.reply(f.native.at(-1), { text: '第二轮问题' })
  await f.pollUntil(() => f.chat.snapshot().phase === '已收到回答，可继续录音提问')
  assert.deepEqual(f.displayed, [...displayed, '我: 第二轮问题', 'AI: [AI] 这是模型回复'])
  assert.equal(f.clears(), clears)
  assert.equal(f.calls(), 2)
  assert.equal(f.native.filter(call => call.func_name === 'startLongpolling').length, 1)
  f.chat.hide(); f.chat.show()
  assert.equal(f.clears(), clears + 1)
  assert.deepEqual(f.displayed, [])
  await f.drain()
  assert.equal(f.chat.snapshot().transcript, '')
  assert.equal(f.chat.resend(), false)
  assert.deepEqual(f.displayed, [])
  assert.equal(f.chat.start(), true)
  assert.equal(f.clears(), clears + 1)
})

test('automatic network recovery retains history and delivers messages missed while offline', async t => {
  const f = await fixture(t)
  await f.pcSend('连接前的消息', 'before-offline')
  f.run(2500); await f.drain()
  assert.ok(f.displayed.some(text => text.includes('连接前的消息')))
  const clears = f.clears()
  f.failNextSync(); f.run(2500); await f.drain()
  assert.match(f.chat.snapshot().network, /网络错误/)
  await f.pcSend('断线期间的旧消息', 'during-offline')
  f.run(2500); await f.drain()
  assert.equal(f.clears(), clears)
  assert.deepEqual(f.displayed, ['电脑: 连接前的消息', '电脑: 断线期间的旧消息'])
  await f.pcSend('恢复连接后的新消息', 'after-offline')
  f.run(2500); await f.drain()
  assert.deepEqual(f.displayed, ['电脑: 连接前的消息', '电脑: 断线期间的旧消息', '电脑: 恢复连接后的新消息'])
  assert.equal(f.clears(), clears)
})

test('fresh connection drains more than one history batch without replaying it or dropping later messages', async t => {
  const f = await fixture(t, async () => '这是模型回复', false,
    Array.from({ length: 45 }, (_, i) => '旧消息 ' + i))
  assert.equal(f.clears(), 1)
  assert.deepEqual(f.displayed, [])
  await f.pcSend('新消息', 'fresh-message')
  f.run(2500); await f.drain()
  assert.deepEqual(f.displayed, ['电脑: 新消息'])
  assert.equal(f.clears(), 1)
})

test('manual retry preserves the visible in-flight question and accepts its answer exactly once', async t => {
  let answer
  const f = await fixture(t, () => new Promise(resolve => { answer = resolve }))
  f.chat.start(); f.chat.finish()
  f.reply(f.native.at(-1), { text: '仍在处理的问题' })
  await f.drain()
  const clears = f.clears()
  f.chat.retry(); await f.drain()
  assert.equal(f.clears(), clears)
  assert.deepEqual(f.displayed, ['我: 仍在处理的问题'])
  assert.equal(f.chat.start(), false)
  answer('重连后送达的回答')
  await f.pollUntil(() => f.chat.snapshot().phase === '已收到回答，可继续录音提问')
  assert.equal(f.displayed.filter(text => text.includes('重连后送达的回答')).length, 1)
  assert.equal(f.calls(), 1)
  assert.equal(f.chat.start(), true)
})

test('late parts of a previously cleared AI conversation cannot reappear after app re-entry', async t => {
  let answer
  const f = await fixture(t, () => new Promise(resolve => { answer = resolve }))
  f.chat.start(); f.chat.finish()
  f.reply(f.native.at(-1), { text: '已超时的旧问题' })
  await f.drain()
  f.run(75000)
  f.chat.hide(); f.chat.show(); await f.drain()
  assert.deepEqual(f.displayed, [])
  assert.equal(f.chat.snapshot().transcript, '')
  answer('不应重新显示的旧回答')
  await f.drain(); f.run(2500); await f.drain()
  assert.deepEqual(f.displayed, [])
  assert.equal(f.chat.start(), true)
})

for (const reenter of [false, true]) test('multipart answer stays complete after ' + (reenter ? 'app re-entry' : 'manual retry'), () => {
  let channelHooks, recorderHooks, state = 'ready', outgoingId = 'pending-question'
  const displayed = []
  const clock = { setTimeout() { return 1 }, clearTimeout() {} }
  const chat = createVoiceChat({
    clock,
    createChannel(fetch, config, hooks) {
      channelHooks = hooks
      return {
        start() {}, stop() {}, retry() {},
        send(text) { hooks.queued(outgoingId); hooks.sent(text, outgoingId); return true }
      }
    },
    createRecorder(load, hooks) {
      recorderHooks = hooks
      return {
        check() { return true }, setForeground() {}, dispose() {}, getState() { return state },
        readConversations() { hooks.conversations(['actual-conversation']) },
        start() { state = 'attempting'; return true }
      }
    },
    hooks: { clear() { displayed.length = 0 }, message(prefix, text) { displayed.push(prefix + text) } }
  })
  chat.show(); chat.start()
  recorderHooks.result('分段回复测试', true)
  state = 'ready'
  const first = { origin: 'ai', requestId: outgoingId, part: 1, parts: 2 }
  channelHooks.receive('回答的前半段', first)
  if (reenter) { chat.hide(); chat.show() }
  else chat.retry()
  assert.deepEqual(displayed, reenter ? [] : ['我: 分段回复测试', 'AI: 回答的前半段'])
  channelHooks.receive('回答的后半段', { ...first, part: 2 })
  const expected = (reenter ? [] : ['我: 分段回复测试']).concat('AI: 回答的前半段', 'AI: 回答的后半段')
  assert.deepEqual(displayed, expected)
  channelHooks.receive('回答的前半段', first)
  assert.equal(displayed.length, expected.length)
  assert.equal(chat.snapshot().phase, '已收到回答，可继续录音提问')
  chat.dispose()
})

test('server rejects watch submissions without a provider instead of ACKing a question with no possible reply', async t => {
  const server = createServer('test-token')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync`, {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'watch', session: '', after: 0, outgoing: { id: 'q1', text: '你好' } })
  })
  assert.equal(response.status, 503)
})
