// One in-flight request; retries reuse the message ID so a lost reply cannot duplicate a send.
export function createChannel(fetchApi, config, hooks, timers) {
  const clock = timers || { setTimeout, clearTimeout }
  let active = false
  let request = 0
  let busy = false
  let wake = null
  let deadline = null
  let cursor = 0
  let session = ''
  let pending = null
  let sequence = 0
  let catchingUp = false
  // Only app entry advances the context epoch. A lost ACK or delayed request
  // cannot repeat a reset or move the server back to a previous conversation.
  let conversationEpoch = 0
  const client = Date.now().toString(36) + Math.random().toString(36).slice(2)

  function schedule() {
    if (active) wake = clock.setTimeout(sync, 2500)
  }
  function sync() {
    if (!active || busy) return
    clock.clearTimeout(wake)
    busy = true
    const current = ++request
    const outgoing = pending
    let settled = false
    function finish(error, response) {
      if (settled || request !== current || !active) return
      settled = true
      clock.clearTimeout(deadline)
      busy = false
      let succeeded = false
      if (error) {
        hooks.status(error)
      } else {
        try {
          const body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          if (response.code !== 200) {
            if (outgoing && pending && pending.id === outgoing.id &&
                [400, 401, 403, 409, 413, 503].indexOf(response.code) >= 0) {
              pending = null
              if (hooks.failed) hooks.failed('上传被拒绝（HTTP ' + response.code + '）', outgoing.id)
            }
            throw new Error('HTTP ' + response.code)
          }
          if (!body || !Array.isArray(body.messages) || typeof body.session !== 'string' || typeof body.cursor !== 'number') {
            throw new Error('响应格式错误')
          }
          if (outgoing && body.ack !== outgoing.id) throw new Error('未收到发送确认')
          if (session !== body.session) {
            cursor = 0
            catchingUp = true
            if (session && hooks.restart) hooks.restart(!!outgoing)
          }
          // Only app entry or a server session change drains old history.
          // Network retries keep the current cursor and deliver missed replies.
          if (catchingUp && hooks.history) hooks.history(body.messages)
          body.messages.forEach(message => {
            if (message.id > cursor && message.source === 'pc') {
              hooks.receive(message.text, message, { historical: catchingUp })
            }
          })
          catchingUp = catchingUp && body.messages.length >= 20
          session = body.session
          cursor = body.cursor
          if (outgoing && pending && pending.id === outgoing.id) {
            pending = null
            hooks.sent(outgoing.text, outgoing.id)
          }
          hooks.status('已连接服务器')
          succeeded = true
        } catch (e) { hooks.status(e.message || '响应错误') }
      }
      if (succeeded && (catchingUp || (pending && !outgoing))) sync()
      else schedule()
    }
    deadline = clock.setTimeout(() => finish('连接超时，自动重试'), 15000)
    try {
      fetchApi.fetch({
        url: config.url + '/api/sync',
        method: 'POST',
        header: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.token },
        data: JSON.stringify({
          source: 'watch', session, after: cursor, outgoing,
          conversationId: client, conversationEpoch
        }),
        responseType: 'text',
        success: response => finish(null, response),
        fail: (data, code) => finish('网络错误 ' + code)
      })
    } catch (e) { finish('网络接口不可用') }
  }
  return {
    start() {
      if (!active) {
        catchingUp = true
        conversationEpoch++
        active = true
        sync()
      }
    },
    stop() {
      active = false
      request++
      busy = false
      clock.clearTimeout(wake)
      clock.clearTimeout(deadline)
    },
    retry() { if (active) sync() },
    send(text) {
      if (pending || typeof text !== 'string' || !text.trim() || Array.from(text).length > 2000) return false
      // A pending upload keeps its original epoch across app re-entry. It may
      // still finish delivery, but must not become part of the new context.
      pending = { id: client + '-' + (++sequence), text, conversationEpoch }
      if (hooks.queued) hooks.queued(pending.id)
      hooks.status('发送中…')
      sync()
      return true
    }
  }
}
