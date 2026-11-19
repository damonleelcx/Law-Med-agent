// The ACT API from inside WeChat.
//
// Nothing signs in on its own. Every page can be browsed signed out; the
// first action that needs an account asks first (components/login-sheet),
// and only then runs wx.login → POST /api/wx/login → a session token. The
// token goes back on every call as "Authorization: Bearer <token>" (a mini
// program has no cookie jar), with X-ACT, which the server requires on writes.
//
// Once someone HAS signed in, two answers re-login silently and retry once:
//   401            the token expired or was revoked
//   wx_pay_error   WeChat refused our signature: the session_key the server
//                  holds is stale. A fresh wx.login gives it the current one.

const { API_BASE } = require('./config')
const { Utf8Stream, SSEParser } = require('./sse')

const TOKEN_KEY = 'act_token'
const USER_KEY = 'act_user'
let loginInFlight = null

function token() {
  return wx.getStorageSync(TOKEN_KEY) || ''
}

function loggedIn() {
  return !!token()
}

function needLogin() {
  return Object.assign(new Error('needLogin'), { status: 401, needLogin: true, data: {} })
}

function apiError(status, data) {
  const msg = (data && data.error) || 'error ' + status
  return Object.assign(new Error(msg), { status, data: data || {} })
}

function raw(method, path, data, tok) {
  return new Promise((resolve, reject) => {
    const header = { 'X-ACT': '1', 'Content-Type': 'application/json' }
    if (tok) header.Authorization = 'Bearer ' + tok
    wx.request({
      url: API_BASE + path,
      method,
      data,
      header,
      success: resolve,
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
    })
  })
}

// login always runs a fresh wx.login. Call it only after the person agreed
// (the login sheet), or to refresh a session they already have.
function login() {
  if (loginInFlight) return loginInFlight
  loginInFlight = new Promise((resolve, reject) => {
    wx.login({ success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login returned no code'))), fail: reject })
  })
    .then((code) => raw('POST', '/api/wx/login', { code, language: 'zh' }))
    .then((res) => {
      if (res.statusCode !== 200) throw apiError(res.statusCode, res.data)
      wx.setStorageSync(TOKEN_KEY, res.data.token)
      wx.setStorageSync(USER_KEY, res.data.user)
      return res.data.token
    })
  const done = () => (loginInFlight = null)
  loginInFlight.then(done, done)
  return loginInFlight
}

function logout() {
  wx.removeStorageSync(TOKEN_KEY)
  wx.removeStorageSync(USER_KEY)
}

// ensureSession: for a signed-in person, make sure WeChat's own session is
// live, so the session_key the server signs payments with is current.
function ensureSession() {
  if (!loggedIn()) return Promise.reject(needLogin())
  return new Promise((resolve) => {
    wx.checkSession({ success: () => resolve(token()), fail: () => resolve(login()) })
  })
}

function shouldRelogin(status, data) {
  return status === 401 || (status === 502 && data && data.error === 'wx_pay_error')
}

function request(method, path, data, retried) {
  const tok = token()
  if (!tok) return Promise.reject(needLogin())
  return raw(method, path, data, tok).then((res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) return res.data
    if (!retried && shouldRelogin(res.statusCode, res.data)) {
      return login().then(() => request(method, path, data, true))
    }
    throw apiError(res.statusCode, res.data)
  })
}

// stream POSTs and delivers server-sent events as they arrive. Resolves when
// the response ends; rejects with {status, data} for a non-200 answer.
function stream(path, body, onEvent, retried) {
  const tok = token()
  if (!tok) return Promise.reject(needLogin())
  return new Promise((resolve, reject) => {
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
      header: { 'X-ACT': '1', 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
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
          return login()
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
}

// upload sends one file to /api/documents (multipart field "file"). WeChat
// names the part after its temp path, so the real name goes alongside.
function upload(filePath, name, retried) {
  const tok = token()
  if (!tok) return Promise.reject(needLogin())
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: API_BASE + '/api/documents',
      filePath,
      name: 'file',
      formData: { name: name || '' },
      header: { 'X-ACT': '1', Authorization: 'Bearer ' + tok },
      success: (res) => {
        let data = {}
        try {
          data = JSON.parse(res.data)
        } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data)
        if (!retried && res.statusCode === 401) {
          return login()
            .then(() => upload(filePath, name, true))
            .then(resolve, reject)
        }
        reject(apiError(res.statusCode, data))
      },
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
    })
  })
}

// transcribe sends a recording to /api/voice/transcribe and resolves with
// the text it heard.
function transcribe(filePath, retried) {
  const tok = token()
  if (!tok) return Promise.reject(needLogin())
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: API_BASE + '/api/voice/transcribe',
      filePath,
      name: 'file',
      header: { 'X-ACT': '1', Authorization: 'Bearer ' + tok },
      success: (res) => {
        let data = {}
        try {
          data = JSON.parse(res.data)
        } catch (e) {}
        if (res.statusCode === 200) return resolve(data.text || '')
        if (!retried && res.statusCode === 401) {
          return login()
            .then(() => transcribe(filePath, true))
            .then(resolve, reject)
        }
        reject(apiError(res.statusCode, data))
      },
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
    })
  })
}

// audio fetches an authenticated GET (a reply read aloud) into a temp file —
// not USER_DATA_PATH, so replies do not pile up in the 10 MB of user files.
function audio(path) {
  const tok = token()
  if (!tok) return Promise.reject(needLogin())
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE + path,
      header: { 'X-ACT': '1', Authorization: 'Bearer ' + tok },
      success: (res) => (res.statusCode === 200 ? resolve(res.tempFilePath) : reject(apiError(res.statusCode, {}))),
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
    })
  })
}

// download saves an authenticated GET to a local temp file (for sharing).
function download(path, fileName) {
  const tok = token()
  if (!tok) return Promise.reject(needLogin())
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: API_BASE + path,
      header: { 'X-ACT': '1', Authorization: 'Bearer ' + tok },
      filePath: wx.env.USER_DATA_PATH + '/' + fileName,
      success: (res) => (res.statusCode === 200 ? resolve(res.filePath) : reject(apiError(res.statusCode, {}))),
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'network error'), { status: 0 })),
    })
  })
}

module.exports = {
  loggedIn,
  login,
  logout,
  ensureSession,
  request,
  stream,
  upload,
  download,
  transcribe,
  audio,
  get: (p) => request('GET', p),
  post: (p, d) => request('POST', p, d || {}),
  put: (p, d) => request('PUT', p, d || {}),
  patch: (p, d) => request('PATCH', p, d || {}),
  del: (p) => request('DELETE', p),
  user: () => wx.getStorageSync(USER_KEY),
}
