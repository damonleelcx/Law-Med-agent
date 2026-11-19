// Shared helpers for the mini program UI tests (WeChat DevTools automation).
// Everything a person does goes through rendered elements: tap, long-press,
// typed input. WeChat's native system UI (action sheet, confirm dialog,
// file/photo picker, payment sheet, clipboard, share) cannot be driven by
// automation and is stubbed with mockWxMethod at exactly those calls.
//
// The helpers are put on `global` so a suite reads like a script.
const automator = require('miniprogram-automator')
const http = require('http')
const fs = require('fs')
const path = require('path')

const SHOTS = process.env.SHOTS || ''
const FROM = Number(process.env.FROM || 0)
const R = []
const errors = []
let mp

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function req(url, method = 'GET') {
  return new Promise((res, rej) => {
    const q = http.request(url, { method }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { res(b) } }) })
    q.on('error', rej); q.end()
  })
}
const mock = { state: () => req('http://127.0.0.1:8090/mock/state'), grant: (n) => req('http://127.0.0.1:8090/mock/grant?n=' + n, 'POST') }
const balance = async () => (await mock.state()).balance

function assert(c, msg) { if (!c) throw new Error(msg) }
async function until(fn, ms, what) {
  const t0 = Date.now(); let last
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last } catch (e) { last = e } await sleep(1200) }
  throw new Error('timed out waiting for ' + what + (last instanceof Error ? ' (' + last.message + ')' : ''))
}
let n = 0
async function step(name, fn) {
  n++
  if (n < FROM) return
  const e0 = errors.length, t0 = Date.now()
  let r
  try { const note = await fn(); r = { n, name, ok: true, note: note || '' } } catch (e) { r = { n, name, ok: false, note: e.message } }
  const errs = errors.slice(e0)
  if (errs.length) { r.ok = false; r.note += ' | page errors: ' + errs.join(' ; ') }
  r.s = ((Date.now() - t0) / 1000).toFixed(1)
  R.push(r)
  await shot(String(n).padStart(2, '0') + '-' + (r.ok ? 'ok' : 'FAIL'))
  console.log((r.ok ? 'PASS ' : 'FAIL ') + n + ' ' + name + ' (' + r.s + 's) ' + r.note)
  await restoreAll()
}
async function shot(name) { if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {}) }

// --- UI helpers: everything goes through the rendered page ---
const page = () => mp.currentPage()
async function onPage(route, ms = 15000) { return until(async () => { const p = await page(); return p.path === route && p }, ms, 'page ' + route) }
async function el(sel, ms = 10000) { return until(async () => (await page()).$(sel), ms, 'element ' + sel) }
async function els(sel) { return (await page()).$$(sel) }
async function tap(sel) { const e = await el(sel); await e.tap(); await sleep(400); return e }
async function tapText(sel, text, ms = 10000) {
  const e = await until(async () => { for (const x of await els(sel)) if ((await x.text()).includes(text)) return x }, ms, sel + ' "' + text + '"')
  await e.tap(); await sleep(400); return e
}
async function type(sel, text) { const e = await el(sel); await e.input(text); await sleep(300); return e }
async function text(sel) { const e = await (await page()).$(sel); return e ? e.text() : '' }
async function tabTo(route) { await mp.switchTab(route); return onPage(route.slice(1)) } // the tab bar is native chrome
const mocked = new Set()
async function stub(method, result) { mocked.add(method); await mp.mockWxMethod(method, result) }
async function restoreAll() { for (const m of mocked) await mp.restoreWxMethod(m).catch(() => {}); mocked.clear() }
async function signInFromSheet() {
  const p = await page()
  const sheet = await p.$('#login')
  const go = await until(async () => sheet.$('.go'), 8000, 'the login sheet')
  await shot('login-sheet')
  await go.tap()
  await until(async () => (await (await page()).data('signedIn')) === true, 15000, 'signed in')
}
async function sendChat(msg) {
  await type('.box', msg)
  await tap('.send')
  await sleep(800)
  const p = await page()
  await until(async () => (await p.data('sending')) === false, 180000, 'Vera to finish replying')
  return p
}
async function lastBubbles() {
  const users = await els('.msg.user .bubble'); const ms = await (await page()).data('messages')
  const v = ms.filter((m) => m.role === 'vera')
  assert((await els('.msg.vera .prose')).length === v.length, 'rendered Vera bubbles ≠ messages')
  const tags = await els('.msg.vera .ai-tag')
  assert(tags.length === v.length, tags.length + ' AI labels for ' + v.length + ' Vera messages')
  for (const tg of tags) assert((await tg.text()).trim() === 'AI 生成', 'label text: ' + (await tg.text()))
  return { user: users.length ? await users[users.length - 1].text() : '', vera: v.length ? v[v.length - 1].content : '', nUser: users.length, nVera: v.length }
}


async function connect() {
  mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:' + (process.env.AUTO_PORT || 9420) })
  global.mp = mp
  mp.on('exception', (e) => errors.push('exception: ' + (e.message || JSON.stringify(e)).slice(0, 200)))
  mp.on('console', (m) => { if (m.type === 'error') errors.push('console.error: ' + JSON.stringify(m.args).slice(0, 200)) })
  return mp
}

// The local database (the act-pg container that scripts/wx-dev.ps1 starts).
function sql(q) {
  return require('child_process').execFileSync('docker', ['exec', '-i', 'act-pg', 'psql', '-U', 'act', '-d', 'act_wxdev', '-tA', '-v', 'ON_ERROR_STOP=1'], { input: q }).toString().trim()
}

function finish() {
  const ok = R.filter((r) => r.ok).length
  console.log('\n=== ' + ok + '/' + R.length + ' passed ===')
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(R, null, 2))
  mp.disconnect()
  process.exitCode = ok === R.length ? 0 : 1
}

Object.assign(global, { automator, http, fs, path, SHOTS, FROM, R, errors, sleep, req, mock, balance, assert, until, step, shot,
  page, onPage, el, els, tap, tapText, type, text, tabTo, stub, restoreAll, signInFromSheet, sendChat, lastBubbles,
  connect, sql, finish })
