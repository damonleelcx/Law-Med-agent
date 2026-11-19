// The ACT API from inside WeChat.
//
// Sign-in: wx.login → POST /api/wx/login → a session token, sent back on every
// call as "Authorization: Bearer <token>" (a mini program has no cookie jar).
// Every call also carries X-ACT, which the server requires on all writes.
//
// Two answers trigger one silent re-login and retry:
//   401            the token expired or was revoked
//   wx_pay_error   WeChat refused our signature: the session_key the server
//                  holds is stale. A fresh wx.login gives it the current one.

const { API_BASE } = require('./config')
const { Utf8Stream, SSEParser } = require('./sse')

const TOKEN_KEY = 'act_token'
const USER_KEY = 'act_user'
let loginInFlight = null

function lang() {
  let l = ''
  try {
    l = (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()).language || ''
  } catch (e) {}
  return l.indexOf('zh') === 0 ? 'zh' : 'en'
}

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login returned no code'))),
      fail: reject,
    })
  })
}

function raw(method, path, data, token) {
  return new Promise((resolve, reject) => {
    const header = { 'X-ACT': '1', 'Content-Type': 'application/json' }
    if (token) header.Authorization = 'Bearer ' + token
    wx.request({
      url: API_BASE + path,
      method,
      data,
      header,
      success: (res) => resolve(res),
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
    })
  })
}

// login returns a token. force=true always does a fresh wx.login, which also
// refreshes the session_key the server signs payments with.
function login(force) {
  if (!force) {
    const t = wx.getStorageSync(TOKEN_KEY)
    if (t) return Promise.resolve(t)
  }
  if (loginInFlight) return loginInFlight
  loginInFlight = wxLoginCode()
    .then((code) => raw('POST', '/api/wx/login', { code, language: lang() }))
    .then((res) => {
      if (res.statusCode !== 200) throw apiError(res.statusCode, res.data)
      wx.setStorageSync(TOKEN_KEY, res.data.token)
      wx.setStorageSync(USER_KEY, res.data.user)
      return res.data.token
    })
  loginInFlight.then(clear, clear)
  return loginInFlight
}
function clear() {
  loginInFlight = null
}

// ensureSession re-logs in when WeChat's own session has lapsed, so the
// server's session_key matches the one WeChat checks payment signatures with.
function ensureSession() {
  return new Promise((resolve) => {
    wx.checkSession({
      success: () => resolve(login(false)),
      fail: () => resolve(login(true)),
    })
  })
}

function apiError(status, data) {
  const msg = (data && data.error) || 'error ' + status
  return Object.assign(new Error(msg), { status, data: data || {} })
}

function shouldRelogin(status, data) {
  return status === 401 || (status === 502 && data && data.error === 'wx_pay_error')
}

function request(method, path, data, retried) {
  return login(false)
    .then((token) => raw(method, path, data, token))
    .then((res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) return res.data
      if (!retried && shouldRelogin(res.statusCode, res.data)) {
        return login(true).then(() => request(method, path, data, true))
      }
      throw apiError(res.statusCode, res.data)
    })
}

// stream POSTs and delivers server-sent events as they arrive. Resolves when
// the response ends; rejects with {status, data} for a non-200 answer.
function stream(path, body, onEvent, retried) {
  return login(false).then(
    (token) =>
      new Promise((resolve, reject) => {
        let status = 0
        let text = ''
        const utf8 = new Utf8Stream()
        const sse = new SSEParser(onEvent)
        const task = wx.request({
          url: API_BASE + path,
          method: 'POST',
          data: body,
          enableChunked: true,
          responseType: 'arraybuffer',
          timeout: 180000,
          header: { 'X-ACT': '1', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          success: (res) => {
            status = status || res.statusCode
            if (status === 200) return resolve()
            // A refusal is a small JSON body, not a stream.
            if (!text && res.data && res.data.byteLength) text = utf8.push(res.data)
            let data = {}
            try {
              data = JSON.parse(text)
            } catch (e) {}
            if (!retried && shouldRelogin(status, data)) {
              return login(true)
                .then(() => stream(path, body, onEvent, true))
                .then(resolve, reject)
            }
            reject(apiError(status, data))
          },
          fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
        })
        task.onHeadersReceived((h) => {
          status = h.statusCode || status
        })
        task.onChunkReceived((c) => {
          const t = utf8.push(c.data)
          if (status && status !== 200) text += t
          else sse.push(t)
        })
      })
  )
}

module.exports = {
  lang,
  login,
  ensureSession,
  request,
  stream,
  get: (p) => request('GET', p),
  post: (p, d) => request('POST', p, d || {}),
  user: () => wx.getStorageSync(USER_KEY),
}
