// Coordinates the native recorder and HTTP channel; no credentials or UI APIs here.
function createVoiceChat(options) {
  const hooks = options.hooks || {}
  const clock = options.clock || { setTimeout, clearTimeout }
  let alive = true, visible = false, initialized = false
  let awaiting = false, requestId = '', waitTimer = null
  let receivedParts = []
  let receivedReplies = [], replayReplies = false
  let retiredRequests = []
  const view = {
    phase: '点击录音开始提问', network: '正在连接电脑…',
    recorderStatus: '正在准备语音识别', transcript: '',
    conversation: '', selection: '0/0'
  }
  let names = [], selected = 0
  function update(values) {
    Object.assign(view, values)
    if (alive && hooks.change) hooks.change(Object.assign({}, view))
  }
  function message(prefix, text) { if (alive && hooks.message) hooks.message(prefix, text) }
  function finishWait() {
    awaiting = false
    clock.clearTimeout(waitTimer)
    waitTimer = null
  }
  function retireRequest(id) {
    if (id && retiredRequests.indexOf(id) < 0) {
      retiredRequests = retiredRequests.concat(id).slice(-200)
    }
  }
  function clearDialogue() {
    if (hooks.clear) hooks.clear()
    // App re-entry clears the view, but an already submitted question keeps
    // its ID and partial answer so delivery can finish without another send.
    if (!awaiting) {
      retireRequest(requestId)
      requestId = ''
      receivedParts = []
      receivedReplies = []
      replayReplies = false
      update({ transcript: '', phase: recorder.getState() === 'ready' && view.conversation ?
        '可以开始新对话' : view.recorderStatus })
    } else replayReplies = true
  }
  function submit() {
    if (!alive || !visible || awaiting || !view.transcript) return false
    if (Array.from(view.transcript).length > 2000) {
      update({ phase: '识别文字超过 2000 字，请缩短后重录' })
      return false
    }
    awaiting = true
    receivedParts = []
    receivedReplies = []
    replayReplies = false
    update({ phase: '识别成功，正在上传…' })
    // queued supplies the ID before sync, including synchronous fetch callbacks.
    if (!channel.send(view.transcript)) {
      finishWait()
      update({ phase: '上一条上传未确认，请点连接状态重试' })
      return false
    }
    return true
  }
  const channel = options.createChannel(options.fetchApi, options.connection, {
    status: network => update({ network }),
    history: messages => {
      messages.forEach(reply => {
        if (reply.requestId !== requestId) retireRequest(reply.requestId)
      })
    },
    queued: id => { requestId = id },
    sent: (text, id) => {
      if (id !== requestId || !awaiting) return
      update({ phase: '问题已上传，等待 AI 回答…' })
      clock.clearTimeout(waitTimer)
      waitTimer = clock.setTimeout(() => {
        if (!alive || !awaiting) return
        finishWait()
        update({ phase: '回答等待较久，可继续等待或重新提问' })
      }, 75000)
    },
    failed: (reason, id) => {
      if (id !== requestId) return
      finishWait()
      update({ phase: reason + '，请重新提问' })
    },
    restart: outgoing => {
      if (awaiting && !outgoing) {
        finishWait()
        update({ phase: '设备服务已重启，请重新提问' })
      }
    },
    receive: (text, reply, delivery) => {
      const current = !!requestId && reply.origin === 'ai' && reply.requestId === requestId
      if (reply.origin === 'ai' && retiredRequests.indexOf(reply.requestId) >= 0) return
      if (delivery && delivery.historical && !current) return
      if (current && receivedParts.indexOf(reply.part) >= 0) return
      if (current && replayReplies) {
        // A partially received current answer remains complete when its next
        // part arrives, even though app re-entry cleared the old visible rows.
        receivedReplies.forEach(text => message('AI: ', text))
        replayReplies = false
      }
      message(reply.origin === 'ai' ? 'AI: ' : '电脑: ', text)
      if (reply.requestId !== requestId || reply.origin !== 'ai') return
      receivedParts.push(reply.part)
      receivedReplies.push(text)
      if (receivedParts.length >= reply.parts) {
        finishWait()
        update({ phase: '已收到回答，可继续录音提问' })
      } else update({ phase: '正在接收回答 ' + receivedParts.length + '/' + reply.parts })
    }
  }, options.clock)
  const recorder = options.createRecorder(options.loadLibrary, {
    state: (state, recorderStatus) => {
      update({ recorderStatus })
      if (!awaiting && ['attempting', 'processing', 'stopping', 'uncertain'].indexOf(state) >= 0) {
        update({ phase: recorderStatus })
      } else if (!awaiting && !view.transcript) {
        update({ phase: recorderStatus })
      }
    },
    log: text => { if (alive && hooks.log) hooks.log(text) },
    conversations: list => {
      names = list
      selected = 0
      update({ conversation: names[0] || '', selection: names.length ? '1/' + names.length : '0/0' })
    },
    result: (text, valid) => {
      if (!alive) return
      update({ transcript: valid ? text : '' })
      if (valid) {
        message('我: ', text)
        submit()
      }
    }
  }, options.clock)
  return {
    show() {
      if (!alive || visible) return
      visible = true
      clearDialogue()
      channel.start()
      const ready = recorder.check()
      recorder.setForeground(true)
      if (ready) {
        if (!initialized) { initialized = true; recorder.readConversations() }
      }
    },
    hide() { visible = false; channel.stop(); recorder.setForeground(false) },
    dispose() {
      alive = false
      visible = false
      finishWait()
      channel.stop()
      recorder.dispose()
    },
    start() {
      if (!alive || !visible) return false
      if (awaiting) { update({ phase: '上一条问题正在上传或回答，请稍候' }); return false }
      const state = recorder.getState()
      if (state !== 'ready') { update({ phase: view.recorderStatus }); return false }
      if (!view.conversation) { update({ phase: '请先读取可用微信会话' }); return false }
      retireRequest(requestId)
      requestId = ''
      return recorder.start(view.conversation)
    },
    finish() { return recorder.finish() },
    cancel() {
      if (!recorder.cancel('手动取消')) update({ phase: awaiting ? '问题已提交，等待回传' : '当前没有录音' })
    },
    prepare() {
      if (recorder.check()) { recorder.setForeground(visible); recorder.readConversations() }
    },
    nextConversation() {
      if (recorder.getState() !== 'ready' || !names.length) return
      selected = (selected + 1) % names.length
      update({ conversation: names[selected], selection: (selected + 1) + '/' + names.length })
    },
    changeConversation(text) {
      if (recorder.getState() === 'ready') update({ conversation: text || '' })
    },
    retry() { channel.retry() },
    resend: submit,
    snapshot() { return Object.assign({}, view) }
  }
}

module.exports = { createVoiceChat }
