// Delete the local test account (if signed in) so a run starts from nothing.
const automator = require('miniprogram-automator')
const http = require('http')
;(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  const t = await mp.evaluate(() => wx.getStorageSync('act_token'))
  if (t) {
    const code = await new Promise((res, rej) => {
      const q = http.request({ host: '127.0.0.1', port: 8080, path: '/api/account/delete', method: 'POST', headers: { Authorization: 'Bearer ' + t, 'X-ACT': '1', 'Content-Type': 'application/json' } }, (r) => { r.resume(); res(r.statusCode) })
      q.on('error', rej); q.end('{"password":""}')
    })
    console.log('delete account:', code)
  }
  await mp.evaluate(() => wx.clearStorageSync())
  mp.disconnect()
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
