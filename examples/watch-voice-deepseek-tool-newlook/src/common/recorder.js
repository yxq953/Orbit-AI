// Reuses the watch-native-recorder protocol verified on the user's Redmi Watch 5.
const START_ERRORS = { 1: '重复开始', 3: '超时', 4: '失去焦点', 5: 'Channel 通道错误', 6: 'Logic 服务错误' }
const STOP_ERRORS = { 2: '当前未录音', 5: 'Channel 通道错误', 6: 'Logic 服务错误' }

function describe(value) {
  try { return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 300) }
  catch (e) { return String(value).slice(0, 300) }
}

function createRecorder(load, hooks, clock) {
  const timers = clock || { setTimeout, clearTimeout, setInterval, clearInterval }
  const notify = hooks || {}
  let library = null
  let state = 'unloaded'
  let disposed = false
  let nextId = 1
  let pending = {}
  let durationTimer = null
  let noopTimer = null
  let startId = null
  let taskRegistered = false
  let eventRegistered = false
  let foreground = false
  let listTask = null

  function resetResult() { if (!disposed && notify.result) notify.result('', false) }
  function validCode(value) {
    return typeof value === 'number' || (typeof value === 'string' && value !== '' && Number.isFinite(Number(value)))
  }

  function log(message) { if (!disposed && notify.log) notify.log(message) }
  function change(next, message) {
    state = next
    if (!disposed && notify.state) notify.state(next, message)
    if (message) log(message)
  }
  function forget(id) {
    const task = pending[id]
    if (task) { timers.clearTimeout(task.timer); delete pending[id] }
  }
  function clearRecordingTimers() {
    timers.clearTimeout(durationTimer)
    timers.clearInterval(noopTimer)
    durationTimer = null
    noopTimer = null
    if (startId !== null) forget(startId)
    startId = null
  }
  function invoke(name, body, callback, timeout, sensitive) {
    const id = callback ? nextId++ : 0
    if (callback) {
      pending[id] = { callback, sensitive, timer: timeout ? timers.setTimeout(() => {
        if (!pending[id] || disposed) return
        delete pending[id]
        callback({ timeout: true })
      }, timeout) : null }
    }
    try {
      library.js_invoke_function({ task_id: id, func_name: name,
        request_body: typeof body === 'object' ? JSON.stringify(body) : body })
      log('调用 ' + name + ' #' + id)
    } catch (e) { forget(id); throw e }
    return id
  }
  function receive(event) {
    if (disposed) return
    // Text and conversation IDs stay on the page, including replies to cancelled tasks.
    log(event ? '任务回调 #' + event.task_id + ' code=' + event.error_code : '收到空回调')
    if (!event || event.task_id === undefined) return
    const task = pending[event.task_id]
    if (!task) return
    forget(event.task_id)
    let body = event.resp_body
    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}') }
      catch (e) { log('响应正文不是 JSON，保留原文') }
    }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      log('响应字段：' + Object.keys(body).slice(0, 10).join(', '))
    }
    task.callback({ code: event.error_code, body })
  }
  function unregister() {
    if (!library) return
    if (taskRegistered && typeof library.js_unregist_task_callback === 'function') {
      try { library.js_unregist_task_callback() } catch (e) { log('注销任务回调失败: ' + describe(e.message || e)) }
    }
    if (eventRegistered && typeof library.js_unregist_event_callback === 'function') {
      try { library.js_unregist_event_callback() } catch (e) { log('注销事件回调失败: ' + describe(e.message || e)) }
    }
    taskRegistered = false
    eventRegistered = false
  }
  function clearQuery() {
    if (listTask === null) return
    const id = listTask
    listTask = null
    forget(id)
    try { invoke('cancelLongpolling', { taskid: id }, null) }
    catch (e) { log('结束会话查询异常：' + describe(e.message || e)) }
  }
  function cancel(reason) {
    if (disposed || !library || ['attempting', 'processing', 'stopping', 'uncertain'].indexOf(state) < 0) return false
    clearRecordingTimers()
    Object.keys(pending).forEach(forget)
    change('stopping', '正在取消' + (reason ? '：' + reason : ''))
    try {
      invoke('stopRecord', 'cancel', result => {
        if (result.timeout) { change('uncertain', '取消无回调，请再次取消'); return }
        const code = Number(result.code)
        if (validCode(result.code) && (code === 0 || code === 2)) {
          change('ready', code === 0 ? '已取消本次录音' : '服务报告当前未录音')
        } else {
          change('uncertain', '取消未确认：' + (STOP_ERRORS[code] || '错误码 ' + result.code))
        }
      }, 5000)
    } catch (e) { change('uncertain', '取消调用异常：' + describe(e.message || e)) }
    return true
  }
  function finish() {
    if (disposed || !library || state !== 'attempting') return false
    clearRecordingTimers()
    change('processing', '正在停止录音并识别，请稍候…')
    try {
      // Shipped WeChat uses trans to return text; it does not send a chat message.
      invoke('stopRecord', 'trans', result => {
        if (result.timeout) { change('uncertain', '识别超时，请点取消确认状态'); return }
        const code = Number(result.code)
        if (!validCode(result.code)) { change('uncertain', '停止响应无有效错误码，请点取消'); return }
        if (code === 2) { change('ready', '服务报告未录音，本次未验证'); return }
        if (code !== 0) {
          change('uncertain', '停止未确认：' + (STOP_ERRORS[code] || '错误码 ' + result.code))
          return
        }
        const body = result.body
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string') {
          change('ready', '停止已确认，未返回识别文字；录音待验证')
          return
        }
        if (body.error_code !== undefined && (!validCode(body.error_code) || Number(body.error_code) !== 0)) {
          change('ready', '识别服务错误 ' + body.error_code + '；录音待验证')
          return
        }
        const transcript = body.text.trim()
        if (!transcript) { change('ready', '未识别到文字，请对着手表清楚说话重试'); return }
        if (notify.result) notify.result(transcript, true)
        change('ready', '已返回识别文字')
      }, 30000, true)
    } catch (e) { change('uncertain', '停止调用异常：' + describe(e.message || e)) }
    return true
  }

  return {
    check() {
      if (disposed || ['querying', 'attempting', 'processing', 'stopping', 'uncertain'].indexOf(state) >= 0) return false
      if (library && taskRegistered) { change('ready', '桥接已加载；录音授权待验证'); return true }
      try {
        library = load()
        if (!library || typeof library.js_invoke_function !== 'function' ||
            typeof library.js_regist_task_callback !== 'function' ||
            typeof library.js_unregist_task_callback !== 'function') {
          throw new Error('缺少 invoke / register / unregister 方法')
        }
        log('方法检查：invoke / register / unregister 均存在')
        // Match WeChat: loadLibrary returns the bridge; do not guess init arguments.
        taskRegistered = true
        library.js_regist_task_callback(receive)
        if (typeof library.js_regist_event_callback === 'function' &&
            typeof library.js_unregist_event_callback === 'function') {
          eventRegistered = true
          library.js_regist_event_callback(event => log('事件 ' + describe(event)))
        }
        change('ready', '桥接已加载；录音授权待验证')
        return true
      } catch (e) {
        unregister()
        library = null
        change('unloaded', '桥接加载失败：' + describe(e.message || e))
        return false
      }
    },
    readConversations() {
      if (disposed || state !== 'ready' || !foreground) return false
      change('querying', '正在读取微信会话…')
      if (notify.conversations) notify.conversations([])
      // Assign before invoking: the native implementation may reply synchronously.
      listTask = nextId
      try {
        invoke('startLongpolling', {
          time_interval: 2000, req_func: 'GetConversationList',
          req_body: JSON.stringify({ size: 5 }), resp_body: ''
        }, result => {
          clearQuery()
          if (result.timeout) { change('ready', '读取会话超时，请重试'); return }
          const body = result.body
          if ((result.code !== 0 && result.code !== '0') ||
              !body || typeof body !== 'object' || Array.isArray(body)) {
            change('ready', '会话查询失败，错误码 ' + result.code)
            return
          }
          if (body.error_code !== undefined && Number(body.error_code) !== 0) {
            change('ready', '会话服务错误 ' + body.error_code)
            return
          }
          const list = Array.isArray(body.conversations) ? body.conversations : []
          const names = []
          list.forEach(item => {
            if (item && typeof item.conversation_name === 'string' && item.conversation_name &&
                names.indexOf(item.conversation_name) < 0) names.push(item.conversation_name)
          })
          if (notify.conversations) notify.conversations(names.slice(0, 5))
          change('ready', names.length ? '已读取会话；可尝试录音' : '没有可用会话，请先检查微信登录和连接')
        }, 12000, true)
        return true
      } catch (e) {
        clearQuery()
        change('ready', '会话调用异常：' + describe(e.message || e))
        return false
      }
    },
    start(conversation) {
      if (disposed || state !== 'ready') { log('请先检查接口或确认取消'); return false }
      const name = typeof conversation === 'string' ? conversation.trim() : ''
      if (!name) { log('请填写实际微信 conversation_name'); return false }
      if (!foreground) { log('请保持应用前台'); return false }
      resetResult()
      change('attempting', '已请求录音，请说话；8 秒后自动识别')
      // Arm timers before invoke: a native callback can occur synchronously.
      durationTimer = timers.setTimeout(finish, 8000)
      noopTimer = timers.setInterval(() => {
        if (state !== 'attempting') return
        try { invoke('recordNoop', {}, null) }
        catch (e) { log('保活失败：' + describe(e.message || e)); cancel('保活异常') }
      }, 3000)
      try {
        const id = invoke('startRecord', name, result => {
          if (state !== 'attempting') return
          // The shipped start callback reports errors, not a reliable start ACK.
          log('开始回调：' + (START_ERRORS[result.code] || '未确认的错误码 ' + result.code))
          cancel('开始回调')
        }, 0)
        if (state === 'attempting') startId = id
        return true
      } catch (e) { log('开始调用异常：' + describe(e.message || e)); cancel('开始异常'); return false }
    },
    finish,
    cancel,
    setForeground(value) {
      if (disposed) return
      foreground = !!value
      if (!value && state === 'querying') { clearQuery(); change('ready', '已停止会话查询') }
      if (!value) cancel('应用离开前台')
      if (library && taskRegistered) {
        try { invoke('foregroundChanged', value ? 'foreground' : 'background', null) }
        catch (e) { log('前台状态通知失败：' + describe(e.message || e)) }
      }
    },
    dispose() {
      if (disposed) return
      clearQuery()
      clearRecordingTimers()
      Object.keys(pending).forEach(forget)
      if (library && ['attempting', 'processing', 'stopping', 'uncertain'].indexOf(state) >= 0) {
        try { invoke('stopRecord', 'cancel', null) } catch (e) { log('退出取消异常：' + describe(e.message || e)) }
      }
      unregister()
      library = null
      disposed = true
      state = 'disposed'
    },
    getState() { return state }
  }
}

module.exports = { createRecorder }
