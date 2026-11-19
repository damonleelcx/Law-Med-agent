// Live updates, as the web app's live.tsx: one long-lived stream of
// /api/stream while the mini program is in the foreground. The server only
// says "something changed for you"; pages refetch what they show. A
// reconnect also counts as a change, so nothing stays stale for long.
const { API_BASE } = require('./config')
const { Utf8Stream, SSEParser } = require('./sse')

const listeners = new Set()
let task = null
let retry = 0
let timer = null
let running = false
let online = false
let debounce = null

function emit() {
  // Coalesce bursts: a plan writes many events at once.
  if (debounce) return
  debounce = setTimeout(() => {
    debounce = null
    listeners.forEach((fn) => {
      try {
        fn({ online })
      } catch (e) {}
    })
  }, 200)
}

function open() {
  const tok = wx.getStorageSync('act_token')
  if (!running || !tok) return
  const utf8 = new Utf8Stream()
  const sse = new SSEParser((ev) => {
    if (ev === 'hello') {
      online = true
      retry = 0
      emit()
    } else if (ev === 'refresh') {
      emit()
    }
  })
  task = wx.request({
    url: API_BASE + '/api/stream',
    method: 'GET',
    enableChunked: true,
    responseType: 'arraybuffer',
    timeout: 3600000,
    header: { 'X-ACT': '1', Authorization: 'Bearer ' + tok },
    complete: () => {
      task = null
      if (!running) return
      online = false
      emit()
      timer = setTimeout(open, Math.min(30000, 1000 * Math.pow(2, retry++)))
    },
  })
  task.onChunkReceived((c) => sse.push(utf8.push(c.data)))
}

module.exports = {
  // start/stop follow the app's foreground (app.js). Safe to call repeatedly.
  start() {
    if (running) return
    running = true
    retry = 0
    open()
  },
  stop() {
    running = false
    online = false
    clearTimeout(timer)
    if (task) task.abort()
    task = null
  },
  restart() {
    this.stop()
    this.start()
  },
  online: () => online,
  // on(fn) subscribes; returns the unsubscribe function.
  on(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
