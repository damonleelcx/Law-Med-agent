// Voice in the chat, through the rendered page: hold the mic, slide up to
// cancel, release to transcribe; a spoken question is answered aloud; 朗读
// reads any reply. Runs against devmock (scripts/wx-dev.ps1).
//
// WeChat's recorder and microphone permission are native and are stubbed: the
// stub recorder "records" devmock's sample MP3. Everything after that — the
// upload, the server fetching the clip, speech recognition, the text in the
// box, synthesis, playback — is real.
//
//   SHOTS=./shots node voice.js            (signs in on its own)
require('./lib')

const SAMPLE = require('fs').readFileSync(require('path').join(__dirname, '../../cmd/devmock/testdata/vera.mp3')).toString('base64')

async function stubVoice() {
  await stub('getSetting', { authSetting: { 'scope.record': true } })
  // One fake recorder per run (the real one is a singleton). stop() hands back
  // the sample MP3 as the recording.
  await mp.evaluate((b64) => {
    const fsm = wx.getFileSystemManager()
    const path = wx.env.USER_DATA_PATH + '/rec-sample.mp3'
    fsm.writeFileSync(path, wx.base64ToArrayBuffer(b64))
    getApp().__rec = {
      started: 0,
      start() { this.started++; this.t0 = Date.now() },
      stop() { setTimeout(() => this._stop && this._stop({ tempFilePath: path, duration: Math.max(1500, Date.now() - this.t0) }), 30) },
      onStop(fn) { this._stop = fn },
      onError(fn) { this._err = fn },
    }
  }, SAMPLE)
  await stub('getRecorderManager', function () { return getApp().__rec })
}

function serverLog(since) {
  const r = require('child_process').spawnSync('docker', ['logs', '--since', since, 'act-wx-server'])
  return String(r.stdout || '') + String(r.stderr || '')
}
const touch = (y) => ({ touches: [{ identifier: 0, pageX: 300, pageY: y, clientX: 300, clientY: y }], changedTouches: [{ identifier: 0, pageX: 300, pageY: y, clientX: 300, clientY: y }] })

async function voiceSteps() {
  await step('Voice: empty box shows the mic; typing swaps it for send', async () => {
    await mp.reLaunch('/pages/index/index'); await sleep(800)
    await tap('.new'); await onPage('pages/chat/chat'); await sleep(1200)
    assert(await el('.send.mic'), 'no mic with an empty box')
    await type('.box', '你好')
    assert(!(await (await page()).$('.send.mic')), 'mic still shown with text in the box')
    await type('.box', '')
    assert(await el('.send.mic'), 'mic did not come back when the box was cleared')
    return 'mic ⇄ send as the box empties and fills'
  })

  await step('Voice: hold the mic → listening card → release → the words land in the box', async () => {
    await stubVoice()
    const mic = await el('.send.mic')
    await mic.touchstart(touch(700))
    const card = await until(async () => (await page()).$('.voice-card'), 5000, 'the listening card')
    const shown = (await card.text()).replace(/\s+/g, ' ').trim()
    await shot('voice-listening')
    await sleep(1600)
    const since = new Date().toISOString()
    await mic.touchend(touch(700))
    const input = await until(async () => (await page()).data('input'), 15000, 'the transcription in the box')
    assert(input === '房东不退押金怎么办', 'box: ' + input)
    assert(!(await (await page()).$('.voice-card')), 'listening card still shown')
    const log = serverLog(since)
    assert(/POST","path":"\/api\/voice\/transcribe","status":200/.test(log), 'no successful transcribe request')
    assert(/GET","path":"\/api\/voice\/clip\/[0-9a-f]{48}\.mp3","status":200/.test(log), 'speech service did not fetch the clip')
    return 'card "' + shown + '"; box now "' + input + '"; clip fetched by the speech service'
  })

  await step('Voice: slide up while holding → 松开手指，取消 → nothing transcribed', async () => {
    await stubVoice()
    await type('.box', '')
    const mic = await el('.send.mic')
    const since = new Date().toISOString()
    await mic.touchstart(touch(700))
    await until(async () => (await page()).$('.voice-card'), 5000, 'the listening card')
    await mic.touchmove(touch(560))
    const cancelCard = await until(async () => (await page()).$('.voice-card.cancel'), 3000, 'the cancel state')
    const t = (await cancelCard.text()).replace(/\s+/g, ' ').trim()
    await shot('voice-cancel')
    await sleep(900)
    await mic.touchend(touch(560))
    await sleep(1500)
    assert(!(await (await page()).data('input')), 'cancelled recording still filled the box')
    assert(!/api\/voice\/transcribe/.test(serverLog(since)), 'cancelled recording was uploaded')
    return 'card "' + t + '"; nothing uploaded'
  })

  await step('Voice: a spoken question is answered aloud (auto-play)', async () => {
    await stubVoice()
    const mic = await el('.send.mic')
    await mic.touchstart(touch(700)); await sleep(1600); await mic.touchend(touch(700))
    await until(async () => (await page()).data('input'), 15000, 'the transcription')
    await stub('createInnerAudioContext', function () {
      const a = { src: '', play() { getApp().__played = (getApp().__played || []).concat(this.src); setTimeout(() => this._end && this._end(), 400) }, stop() {}, destroy() {}, onEnded(f) { this._end = f }, onError() {} }
      return a
    })
    const since = new Date().toISOString()
    await tap('.send')
    const p = await page()
    await until(async () => (await p.data('sending')) === false, 60000, 'the reply')
    const played = await until(() => mp.evaluate(() => getApp().__played), 15000, 'the reply to be played')
    const log = serverLog(since)
    const m = log.match(/GET","path":"\/api\/messages\/(\d+)\/speech","status":200/)
    assert(m, 'no speech request for the reply')
    const ms = await p.data('messages'); const last = [...ms].reverse().find((x) => x.role === 'vera')
    assert(String(last.id) === m[1], 'read message ' + m[1] + ', last reply is ' + last.id)
    return 'reply ' + last.id + ' fetched as speech and played (' + played.length + ' clip)'
  })

  await step('Voice: tap 朗读 on a reply → 停止 while playing → back to 朗读', async () => {
    await mp.evaluate(() => { getApp().__played = [] })
    await stub('createInnerAudioContext', function () {
      return { src: '', play() { getApp().__played.push(this.src) }, stop() { getApp().__stopped = true }, destroy() {}, onEnded(f) { this._end = f }, onError() {} }
    })
    // A fresh page so the stubbed player is the one it creates.
    const id = await (await page()).data('id')
    await mp.redirectTo('/pages/chat/chat?id=' + id); const p = await onPage('pages/chat/chat'); await sleep(1500)
    const speaks = await els('.speak')
    assert(speaks.length >= 1, 'no 朗读 button')
    const first = speaks[0]
    assert((await first.text()).trim() === '朗读', 'label ' + (await first.text()))
    await first.tap()
    await until(async () => (await mp.evaluate(() => getApp().__played.length)) > 0, 10000, 'playback')
    const on = await until(async () => (await p.$('.speak.on')), 3000, 'the 停止 state')
    const onText = (await on.text()).trim()
    await shot('voice-playing')
    await on.tap(); await sleep(400)
    assert(!(await p.$('.speak.on')), 'still playing after 停止')
    assert(await mp.evaluate(() => getApp().__stopped), 'player was not stopped')
    return speaks.length + ' replies with 朗读; playing shows "' + onText + '"; 停止 stops it'
  })
}

module.exports = voiceSteps

if (require.main === module) {
  ;(async () => {
    await connect()
    await mp.evaluate(() => wx.clearStorageSync())
    await mp.reLaunch('/pages/index/index'); await sleep(800)
    await tap('.new'); await onPage('pages/chat/chat')
    await type('.box', '你好'); await tap('.send'); await signInFromSheet()
    await until(async () => (await (await page()).data('sending')) === false, 60000, 'first reply')
    await mock.grant(20)
    await voiceSteps()
    finish()
  })().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(2) })
}
