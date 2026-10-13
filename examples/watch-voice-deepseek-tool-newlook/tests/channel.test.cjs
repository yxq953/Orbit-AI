const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

test('server-session change drains history and preserves pending uploads without clearing the view', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/common/channel.js'), 'utf8')
  const { createChannel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const requests = [], events = [], jobs = new Map()
  let jobId = 0
  const clock = {
    setTimeout(fn) { const id = ++jobId; jobs.set(id, fn); return id },
    clearTimeout(id) { jobs.delete(id) }
  }
  const channel = createChannel({ fetch: options => requests.push(options) }, { url: 'http://pc', token: 'test' }, {
    status() {},
    reconnect() { events.push('clear') },
    restart(outgoing) { events.push('restart:' + outgoing) },
    receive(text, reply, delivery) { events.push((delivery.historical ? 'history:' : 'live:') + text) },
    sent(text, id) { events.push('sent:' + id) }
  }, clock)
  function success(index, session, messages = [], ack = null, cursor = 0) {
    requests[index].success({ code: 200, data: JSON.stringify({ session, messages, ack, cursor }) })
  }
  channel.start(); success(0, 'server-one')
  assert.equal(channel.send('正在上传的问题'), true)
  const id = JSON.parse(requests[1].data).outgoing.id
  success(1, 'server-two', [{ id: 1, source: 'pc', text: '旧消息' }], id, 1)
  assert.deepEqual(events, ['restart:true', 'history:旧消息', 'sent:' + id])
  assert.equal(JSON.parse(requests[1].data).outgoing.id, id)
  channel.retry()
  assert.equal(JSON.parse(requests[2].data).after, 1)
  success(2, 'server-two', [{ id: 2, source: 'pc', text: '重试送达的消息' }], null, 2)
  assert.ok(events.includes('live:重试送达的消息'))
  channel.stop(); channel.start()
  success(3, 'server-two', [{ id: 3, source: 'pc', text: '退出期间的消息' }], null, 3)
  assert.ok(events.includes('history:退出期间的消息'))
  const clears = events.filter(event => event === 'clear').length
  channel.send('新问题')
  const nextId = JSON.parse(requests[4].data).outgoing.id
  success(4, 'server-two', [{ id: 4, source: 'pc', text: '新回答' }], nextId, 4)
  assert.ok(events.includes('live:新回答'))
  assert.equal(events.filter(event => event === 'clear').length, clears)
  channel.stop()
  assert.equal(jobs.size, 0)
})
