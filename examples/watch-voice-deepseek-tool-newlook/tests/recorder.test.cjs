const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecorder } = require('../src/common/recorder')

function fixture(options = {}) {
  let now = 0, next = 1, callback
  const scheduled = new Map()
  const calls = [], states = [], logs = [], conversations = [], results = []
  let taskUnregisters = 0, eventUnregisters = 0
  const clock = {
    setTimeout(fn, delay) { const id = next++; scheduled.set(id, { fn, at: now + delay }); return id },
    clearTimeout(id) { scheduled.delete(id) },
    setInterval(fn, delay) { const id = next++; scheduled.set(id, { fn, at: now + delay, delay }); return id },
    clearInterval(id) { scheduled.delete(id) }
  }
  const library = {
    js_regist_task_callback(fn) { callback = fn },
    js_unregist_task_callback() { taskUnregisters++ },
    js_regist_event_callback() {},
    js_unregist_event_callback() { eventUnregisters++ },
    js_invoke_function(call) { calls.push(call); if (options.invoke) options.invoke(call, callback) }
  }
  const recorder = createRecorder(() => options.load ? options.load() : library, {
    state(state, message) { states.push({ state, message }) }, log(message) { logs.push(message) },
    conversations(names) { conversations.push(names) },
    result(text, hasText) { results.push({ text, hasText }) }
  }, clock)
  return {
    recorder, calls, states, logs, scheduled, conversations, results,
    ready() { assert.equal(recorder.check(), true); recorder.setForeground(true) },
    reply(call, code, body = '{}') { callback({ task_id: call.task_id, error_code: code, resp_body: body }) },
    tick(delta) {
      const end = now + delta
      while (true) {
        const entries = [...scheduled].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)
        if (!entries.length) break
        const [id, job] = entries[0]; now = job.at
        if (job.delay) job.at += job.delay
        else scheduled.delete(id)
        job.fn()
      }
      now = end
    },
    unregisters() { return [taskUnregisters, eventUnregisters] }
  }
}

test('unavailable library is reported without any recording request', () => {
  const f = fixture({ load() { throw new Error('permission denied') } })
  assert.equal(f.recorder.check(), false)
  assert.equal(f.recorder.getState(), 'unloaded')
  assert.match(f.logs.join('\n'), /permission denied/)
  assert.equal(f.recorder.start('conversation'), false)
  assert.equal(f.calls.length, 0)
})

test('requires foreground and a real conversation string; duplicate starts are blocked', () => {
  const f = fixture(); f.recorder.check()
  assert.equal(f.recorder.start('conversation'), false)
  f.recorder.setForeground(true)
  assert.equal(f.recorder.start('  '), false)
  assert.equal(f.recorder.start('wxid_sample'), true)
  assert.equal(f.recorder.start('wxid_sample'), false)
  assert.equal(f.calls.filter(c => c.func_name === 'startRecord').length, 1)
})

test('start needs no ACK; automatic stop transcribes and returns actual text without sending a message', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample')
  const start = f.calls.find(c => c.func_name === 'startRecord')
  assert.equal(start.request_body, 'wxid_sample')
  f.tick(7000)
  assert.equal(f.recorder.getState(), 'attempting')
  const noops = f.calls.filter(c => c.func_name === 'recordNoop')
  assert.equal(noops.length, 2)
  assert.ok(noops.every(c => c.task_id === 0 && c.request_body === '{}'))
  f.tick(1000)
  const stop = f.calls.find(c => c.func_name === 'stopRecord')
  assert.equal(stop.request_body, 'trans')
  assert.equal(f.recorder.getState(), 'processing')
  f.reply(start, 4) // stale start error must not start another cancellation
  assert.equal(f.calls.filter(c => c.func_name === 'stopRecord').length, 1)
  f.reply(stop, 0, '{"text":"现在开始测试手表录音"}')
  assert.equal(f.recorder.getState(), 'ready')
  assert.equal(f.scheduled.size, 0)
  assert.deepEqual(f.results.at(-1), { text: '现在开始测试手表录音', hasText: true })
  assert.ok(f.calls.every(c => c.request_body !== 'send'))
  assert.ok(!f.logs.join('\n').includes('现在开始测试手表录音'))
})

test('start Channel error cancels immediately and never reports recording success', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample')
  f.reply(f.calls.find(c => c.func_name === 'startRecord'), 5)
  assert.equal(f.recorder.getState(), 'stopping')
  assert.match(f.logs.join('\n'), /Channel/)
  const stop = f.calls.find(c => c.func_name === 'stopRecord')
  f.reply(stop, 2)
  assert.equal(f.recorder.getState(), 'ready')
  f.tick(10000)
  assert.equal(f.calls.filter(c => c.func_name === 'recordNoop').length, 0)
})

test('unconfirmed cancellation prevents restarting, can be retried, and ignores old replies', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.recorder.cancel()
  const firstStop = f.calls.find(c => c.func_name === 'stopRecord')
  f.tick(5000)
  assert.equal(f.recorder.getState(), 'uncertain')
  assert.equal(f.recorder.start('wxid_sample'), false)
  assert.equal(f.recorder.check(), false)
  f.recorder.cancel()
  const stops = f.calls.filter(c => c.func_name === 'stopRecord')
  f.reply(firstStop, 0)
  assert.equal(f.recorder.getState(), 'stopping')
  f.reply(stops[1], 0)
  assert.equal(f.recorder.getState(), 'ready')
})

test('malformed or unsuccessful stop callback is not treated as success', () => {
  for (const code of [undefined, null, '', 5, 6]) {
    const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.recorder.cancel()
    f.reply(f.calls.find(c => c.func_name === 'stopRecord'), code)
    assert.equal(f.recorder.getState(), 'uncertain')
  }
})

test('synchronous start callback cannot leave recording timers running', () => {
  const f = fixture({ invoke(call, callback) {
    if (call.func_name === 'startRecord') callback({ task_id: call.task_id, error_code: 6, resp_body: '{}' })
    if (call.func_name === 'stopRecord') callback({ task_id: call.task_id, error_code: 2, resp_body: '{}' })
  } })
  f.ready(); f.recorder.start('wxid_sample')
  assert.equal(f.recorder.getState(), 'ready')
  assert.equal(f.scheduled.size, 0)
  f.tick(10000)
  assert.equal(f.calls.filter(c => c.func_name === 'recordNoop').length, 0)
})

test('hiding cancels; destroying sends final cancel and unregisters both callbacks once', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample')
  f.recorder.setForeground(false)
  assert.equal(f.recorder.getState(), 'stopping')
  assert.equal(f.calls.at(-1).request_body, 'background')
  f.recorder.dispose(); f.recorder.dispose()
  assert.equal(f.recorder.getState(), 'disposed')
  assert.equal(f.calls.at(-1).request_body, 'cancel')
  assert.deepEqual(f.unregisters(), [1, 1])
  assert.equal(f.scheduled.size, 0)
  const count = f.logs.length
  f.reply(f.calls.find(c => c.func_name === 'startRecord'), 4)
  assert.equal(f.logs.length, count)
})

test('reads real conversation IDs via the shipped longpoll protocol, without recording', () => {
  const f = fixture(); f.ready(); f.recorder.readConversations()
  const request = f.calls.find(c => c.func_name === 'startLongpolling')
  assert.deepEqual(JSON.parse(request.request_body), {
    time_interval: 2000, req_func: 'GetConversationList', req_body: '{"size":5}', resp_body: ''
  })
  assert.equal(f.recorder.start('wxid_sample'), false)
  f.reply(request, 0, JSON.stringify({ error_code: 0, conversations: [
    { conversation_name: 'wxid_actual' }, { conversation_name: 'wxid_actual' }, { nickname: 'Nickname only' }
  ] }))
  assert.equal(f.recorder.getState(), 'ready')
  assert.equal(f.scheduled.size, 0)
  assert.deepEqual(f.conversations.at(-1), ['wxid_actual'])
  assert.ok(f.calls.some(c => c.func_name === 'cancelLongpolling'))
  assert.ok(!f.calls.some(c => c.func_name === 'startRecord'))
  assert.ok(!f.logs.join('\n').includes('wxid_actual'))
})

test('query timeout and foreground loss clean up longpolling and ignore late data', () => {
  for (const hide of [false, true]) {
    const f = fixture(); f.ready(); f.recorder.readConversations()
    const request = f.calls.find(c => c.func_name === 'startLongpolling')
    if (hide) f.recorder.setForeground(false)
    else f.tick(12000)
    assert.equal(f.recorder.getState(), 'ready')
    assert.equal(f.scheduled.size, 0)
    f.reply(request, 0, '{"conversations":[{"conversation_name":"late"}]}')
    assert.equal(f.recorder.getState(), 'ready')
    assert.ok(f.calls.some(c => c.func_name === 'cancelLongpolling'))
  }
})

test('service error and malformed query body do not claim that conversations were loaded', () => {
  for (const body of ['not json', '{"error_code":-1001}', '{}']) {
    const f = fixture(); f.ready(); f.recorder.readConversations()
    f.reply(f.calls.find(c => c.func_name === 'startLongpolling'), 0, body)
    assert.equal(f.recorder.getState(), 'ready')
    assert.ok(!f.states.some(s => s.message === '已读取会话；可尝试录音'))
  }
})

test('manual finish clears timers and duplicate finish cannot stop twice', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.tick(1000)
  assert.equal(f.recorder.finish(), true)
  assert.equal(f.recorder.finish(), false)
  assert.equal(f.recorder.start('wxid_sample'), false)
  assert.equal(f.recorder.check(), false)
  f.reply(f.calls.find(c => c.func_name === 'stopRecord'), '0', '{"text":"手表麦克风测试"}')
  f.tick(8000)
  assert.equal(f.calls.filter(c => c.func_name === 'stopRecord').length, 1)
  assert.equal(f.scheduled.size, 0)
  f.recorder.start('wxid_sample')
  assert.deepEqual(f.results.at(-1), { text: '', hasText: false })
})

test('empty text, invalid body, and service failure never establish successful audio capture', () => {
  for (const body of ['not json', '{}', '{"text":null}', '{"text":"   "}',
    '{"text":"untrusted","error_code":-1}', '{"text":"untrusted","error_code":null}']) {
    const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.recorder.finish()
    f.reply(f.calls.find(c => c.func_name === 'stopRecord'), 0, body)
    assert.equal(f.recorder.getState(), 'ready')
    assert.ok(f.results.every(r => !r.hasText))
    assert.equal(f.scheduled.size, 0)
  }
})

test('transcription timeout blocks restart until cancellation; late text cannot overwrite result', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.tick(8000)
  const trans = f.calls.find(c => c.func_name === 'stopRecord')
  f.tick(30000)
  assert.equal(f.recorder.getState(), 'uncertain')
  assert.equal(f.recorder.start('wxid_sample'), false)
  f.recorder.cancel('超时')
  f.reply(trans, 0, '{"text":"late audio"}')
  assert.ok(f.results.every(r => !r.hasText))
  assert.equal(f.recorder.getState(), 'stopping')
  f.reply(f.calls.filter(c => c.func_name === 'stopRecord').at(-1), 2)
  assert.equal(f.recorder.getState(), 'ready')
  assert.equal(f.scheduled.size, 0)
})

test('not recording and failed transcription replies preserve a truthful result', () => {
  for (const code of [2, 5, 6, undefined, null, '']) {
    const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.recorder.finish()
    f.reply(f.calls.find(c => c.func_name === 'stopRecord'), code, '{"text":"not accepted"}')
    assert.equal(f.recorder.getState(), code === 2 ? 'ready' : 'uncertain')
    assert.ok(f.results.every(r => !r.hasText))
  }
})

test('hiding during transcription cancels it and ignores its late result', () => {
  const f = fixture(); f.ready(); f.recorder.start('wxid_sample'); f.recorder.finish()
  const trans = f.calls.find(c => c.request_body === 'trans')
  f.recorder.setForeground(false)
  const cancel = f.calls.find(c => c.request_body === 'cancel')
  assert.ok(cancel)
  f.reply(trans, 0, '{"text":"late"}')
  assert.equal(f.recorder.getState(), 'stopping')
  assert.ok(f.results.every(r => !r.hasText))
  f.recorder.dispose()
  assert.equal(f.scheduled.size, 0)
  assert.deepEqual(f.unregisters(), [1, 1])
})

test('synchronous transcription response leaves no outstanding timers', () => {
  const f = fixture({ invoke(call, callback) {
    if (call.func_name === 'stopRecord') callback({ task_id: call.task_id, error_code: 0, resp_body: '{"text":"真实文字"}' })
  } })
  f.ready(); f.recorder.start('wxid_sample'); f.tick(8000)
  assert.equal(f.recorder.getState(), 'ready')
  assert.deepEqual(f.results.at(-1), { text: '真实文字', hasText: true })
  assert.equal(f.scheduled.size, 0)
})
