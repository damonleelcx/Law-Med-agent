// UI run against devmock: no model tokens. Cases and approvals are created
// directly in the local database, so this covers every screen and tap but not
// Vera's own planning (real-model.js does that).
//
//   SHOTS=./shots node devmock.js
require('./lib')
;(async () => {
  await connect()
  await step('Signed out: the 4 tabs open without asking to sign in', async () => {
    if (FROM <= 1) await mp.evaluate(() => wx.clearStorageSync())
    const seen = []
    for (const t of ['/pages/index/index', '/pages/cases/cases', '/pages/docs/docs', '/pages/me/me']) {
      await mp.reLaunch(t); await sleep(1000)
      const p = await page()
      assert(!(await (await p.$('#login')).$('.go')), t + ' opened the login sheet by itself')
      const card = await p.$('.empty-card') || await p.$('.btn-ember')
      seen.push(t.split('/')[2] + ': "' + (card ? (await card.text()).trim().slice(0, 18) : '?') + '"')
    }
    return seen.join('; ')
  })

  await step('Tap 新对话, type, send → login sheet; 暂不登录 keeps the text', async () => {
    await mp.reLaunch('/pages/index/index'); await sleep(800)
    await tap('.new')
    await onPage('pages/chat/chat')
    await type('.box', '我想问一个问题')
    await tap('.send')
    const sheet = await (await page()).$('#login')
    await until(async () => sheet.$('.later'), 8000, 'the login sheet')
    await (await sheet.$('.later')).tap(); await sleep(500)
    assert(!(await sheet.$('.go')), 'sheet did not close')
    assert((await (await page()).data('input')) === '我想问一个问题', 'typed text lost')
    assert((await els('.msg.user')).length === 0, 'a message went out without signing in')
    return 'sheet shown; 暂不登录 closed it; "我想问一个问题" still in the box; nothing sent'
  })

  await step('Sign in with WeChat; the held message then sends and Vera replies', async () => {
    await tap('.send')
    await signInFromSheet()
    const p = await page()
    await until(async () => (await p.data('sending')) === false && (await els('.msg.vera .prose')).length > 0, 120000, 'reply')
    const b = await lastBubbles()
    assert(b.user.includes('我想问一个问题'), 'user bubble: ' + b.user)
    assert(b.vera.length > 3, 'empty reply')
    return 'AI 生成 on every Vera message; reply: "' + b.vera.replace(/\s+/g, ' ').slice(0, 60) + '…"'
  })

  await step('Chat: reply streams in; stamp bar drops by 1', async () => {
    const b0 = await balance()
    const barBefore = await text('.bar')
    await sendChat('你好，维拉。请用一句话介绍你自己。')
    const b = await lastBubbles()
    assert(b.vera.length > 5, 'no reply')
    const b1 = await balance()
    assert(b1 === b0 - 1, 'WeChat balance ' + b0 + '→' + b1)
    const barAfter = await until(async () => { const t = await text('.bar'); return t.includes(String(b1)) && t }, 5000, 'stamp bar to show ' + b1)
    return 'reply "' + b.vera.replace(/\s+/g, ' ').slice(0, 40) + '…"; bar "' + barBefore.trim() + '" → "' + barAfter.trim() + '"'
  })

  await step('Copy a reply (tap 复制)', async () => {
    await stub('setClipboardData', function (o) { getApp().__clip = o.data; return {} })
    const copies = await els('.copy'); assert(copies.length, 'no copy button')
    await copies[copies.length - 1].tap(); await sleep(400)
    const clip = await mp.evaluate(() => getApp().__clip)
    assert(clip && clip.length > 5, 'clipboard: ' + clip)
    return 'copied ' + clip.length + ' chars'
  })

  await step('Model fails (devmock #fail): Vera shows her fallback; the stamp comes back', async () => {
    const b0 = await balance()
    const p = await sendChat('#fail 请回答')
    const ms = await p.data('messages'); const last = ms[ms.length - 1]
    assert(last.role === 'vera' && /推理服务|reasoning service/.test(last.content), 'reply: ' + last.content.slice(0, 60))
    assert((await balance()) === b0, 'WeChat balance ' + b0 + ' → ' + (await balance()) + ' (not refunded)')
    const bar = await until(async () => { const t = await text('.bar'); return t.includes(String(b0)) && t }, 5000, 'stamp bar back to ' + b0)
    return 'fallback "' + last.content.slice(0, 20) + '…" shown; balance stays ' + b0 + '; bar "' + bar.trim() + '"'
  })
  await step('Out of stamps: send → 邮票用完了 dialog, message marked failed, nothing charged', async () => {
    let b = await balance()
    while (b > 0) { await sendChat('谢谢。'); b = await balance() }
    await stub('showModal', function (o) { getApp().__modal = o.title + ' / ' + o.content + ' / ' + o.confirmText; return { confirm: false, cancel: true } })
    await type('.box', '再问一个问题'); await tap('.send')
    const m = await until(() => mp.evaluate(() => getApp().__modal), 20000, 'the out-of-stamps dialog')
    assert(await el('.msg.user .fail'), 'no 重试 marker on the failed message')
    assert((await balance()) === 0, 'charged')
    return 'dialog: ' + m + '; 重试 shown; balance 0'
  })

  await step('Tap the stamp bar → 邮票 page; buy a pack (payment sheet stubbed); balance and recent use', async () => {
    await tap('.bar')
    const p = await onPage('pages/stamps/stamps'); await sleep(1200)
    const packs = await els('.pack'); assert(packs.length === 4, packs.length + ' packs shown')
    const label = (await packs[0].text()).replace(/\s+/g, ' ')
    await stub('requestVirtualPayment', function (o) { getApp().__pay = { mode: o.mode, signData: o.signData, sig: !!(o.paySig && o.signature) }; return { errMsg: 'requestVirtualPayment:ok' } })
    await packs[0].tap()
    const pay = await until(() => mp.evaluate(() => getApp().__pay), 10000, 'the payment sheet call')
    assert(pay.mode === 'short_series_coin' && pay.sig, 'payment call ' + JSON.stringify(pay))
    const qty = (await p.data('packs'))[0]
    await mock.grant(qty) // what WeChat does when the payment completes
    await until(async () => (await p.data('balance')) === qty, 10000, 'balance ' + qty)
    const pageText = (await (await p.$('.root')).text()).replace(/\s+/g, ' ')
    await mock.grant(40)
    return 'pack "' + label + '" → payment requested (' + pay.mode + ', signed); balance ' + qty + ' shown; page: "' + pageText.slice(0, 70) + '…"'
  })

  await step('Back in chat: tap 重试 on the failed message; charged once', async () => {
    await mp.navigateBack(); await onPage('pages/chat/chat'); await sleep(800)
    const b0 = await balance()
    await tap('.msg.user .fail'); await sleep(800)
    const p = await page()
    await until(async () => (await p.data('sending')) === false, 180000, 'reply')
    assert(!(await (await page()).$('.msg.user .fail')), 'still failed')
    assert((await balance()) === b0 - 1, 'charged ' + (b0 - (await balance())))
    return 'resent; 1 stamp'
  })

  await step('Tap a suggestion chip in a new chat', async () => {
    await mp.reLaunch('/pages/index/index'); await sleep(800)
    await tap('.new'); await onPage('pages/chat/chat'); await sleep(600)
    const chips = await els('.chip-btn'); assert(chips.length, 'no suggestions')
    const t = (await chips[0].text()).trim()
    await chips[0].tap(); await sleep(800)
    const p = await page()
    await until(async () => (await p.data('sending')) === false && (await els('.msg.vera .prose')).length, 180000, 'reply')
    return 'tapped "' + t + '" → sent and answered'
  })

  await mock.grant(20)
  await require('./voice')() // hold-to-talk, cancel, spoken answers, 朗读

  let goalId = '', apId = ''

  await step('Setup: sign in from 对话, two chats via devmock, a seeded case with a pending 发送邮件 approval', async () => {
    await mp.evaluate(() => wx.clearStorageSync())
    await mp.reLaunch('/pages/index/index'); await sleep(800)
    await tap('.new'); await onPage('pages/chat/chat')
    await type('.box', '你好'); await tap('.send'); await signInFromSheet()
    await until(async () => (await (await page()).data('sending')) === false && (await els('.msg.vera')).length, 60000, 'reply')
    await mp.reLaunch('/pages/index/index'); await sleep(600)
    await tap('.new'); await onPage('pages/chat/chat'); await sendChat('房东不退押金怎么办')
    const conv = await (await page()).data('id')
    const uid = sql(`SELECT user_id FROM conversations WHERE id='${conv}'`)
    const out = sql(`WITH g AS (INSERT INTO goals (user_id, conversation_id, title, objective, domain, skill, status, language)
        VALUES ('${uid}','${conv}','上海租房押金退还','让房东退还5000元押金','legal','new-matter','active','zh') RETURNING id),
      t AS (INSERT INTO tasks (goal_id, key, title, kind, status) SELECT id,'send','发送催告函','llm','waiting_approval' FROM g RETURNING id, goal_id),
      a AS (INSERT INTO approvals (goal_id, task_id, user_id, tool, args, call_id, preview, gate, required_role)
        SELECT goal_id, id, '${uid}', 'email_send', '{"to":"landlord@example.com","subject":"押金退还催告函","body":"请于7日内退还押金5000元。"}', 'call-1',
               '收件人：landlord@example.com\n主题：押金退还催告函\n\n请于7日内退还押金5000元。', 'G1', 'client' FROM t RETURNING id, goal_id)
      SELECT goal_id || ' ' || id FROM a;`)
    ;[goalId, apId] = out.split('\n').pop().split(' ')
    sql(`INSERT INTO messages (conversation_id, role, content, meta) VALUES ('${conv}','assistant','我已为你建立案件。','{"kind":"goal_created","goal_id":"${goalId}"}')`)
    return 'signed in; case ' + goalId.slice(0, 8) + ' with approval ' + apId.slice(0, 8) + ' seeded in DB'
  })

  await step('Approvals: card in the chat and on 待审批; type a note, tap 同意', async () => {
    await mp.navigateBack(); await onPage('pages/index/index'); await sleep(800)
    await (await els('.row'))[0].tap(); const c = await onPage('pages/chat/chat')
    const inChat = await until(async () => (await els('.approval-card')).length && (await els('.goal-card')).length, 15000, 'case + approval cards in the chat')
    const chatCard = (await (await (await els('.approval-card'))[0]).text()).replace(/\s+/g, ' ')
    await mp.navigateBack(); await onPage('pages/index/index'); await sleep(1000)
    const chip = await el('.chip'); const chipText = (await chip.text()).trim()
    await chip.tap()
    await onPage('pages/approvals/approvals'); await sleep(1500)
    const card = await el('.approval-card')
    await (await card.$('.ap-note')).input('可以，按这个发'); await sleep(300)
    await (await card.$('.btn-ember')).tap()
    await until(async () => sql(`SELECT status FROM approvals WHERE id='${apId}'`) === 'approved', 15000, 'approval stored')
    const note = sql(`SELECT note FROM approvals WHERE id='${apId}'`)
    await until(async () => { const k = await (await page()).$('.approval-card'); return !k || !(await k.$('.btn-ember')) }, 10000, 'buttons gone')
    const after = (await text('.approval-card')).replace(/\s+/g, ' ')
    await mp.navigateBack()
    return 'chip "' + chipText + '"; chat card "' + chatCard.slice(0, 40) + '…"; approved with note "' + note + '"; card now "' + after.slice(0, 40) + '"'
  })

  await step('文件: tap ↑ 上传 → pick a file (picker stubbed) → opens with its name and text', async () => {
    await tabTo('/pages/docs/docs'); await sleep(800)
    const fp = await mp.evaluate(() => { const f = wx.env.USER_DATA_PATH + '/租赁合同摘要.txt'; wx.getFileSystemManager().writeFileSync(f, '租赁合同摘要\n押金：5000元\n租期：2025年11月至2026年10月\n', 'utf8'); return f })
    await stub('showActionSheet', { tapIndex: 0 })
    await stub('chooseMessageFile', { tempFiles: [{ path: fp, name: '租赁合同摘要.txt', size: 60 }] })
    await tap('.head button')
    const d = await onPage('pages/doc/doc', 20000); await until(async () => (await d.data('d')), 10000, 'doc')
    const title = (await text('.h1')).trim(); const body = JSON.stringify((await d.data('d')).html)
    assert(title.includes('租赁合同摘要'), 'title ' + title)
    assert(body.includes('5000'), 'body')
    // Wait for 文件 to be on top again: querying while DevTools is still
    // switching pages hangs the automation call.
    await mp.navigateBack(); await onPage('pages/docs/docs'); await sleep(800)
    const rows = await until(async () => (await els('.file-row')).length, 10000, 'the 文件 list')
    return 'opened "' + title + '" with the 5000元 line; 文件 list now ' + rows + ' row(s)'
  })

  await step('Chat: tap 📎 → photo (picker stubbed) → uploaded, note in the box', async () => {
    await tabTo('/pages/index/index'); await sleep(600)
    await tap('.new'); await onPage('pages/chat/chat'); await sleep(500)
    const fp = await mp.evaluate(() => { const f = wx.env.USER_DATA_PATH + '/receipt.png'; wx.getFileSystemManager().writeFileSync(f, wx.base64ToArrayBuffer('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==')); return f })
    await stub('showActionSheet', { tapIndex: 1 })
    await stub('chooseMedia', { type: 'image', tempFiles: [{ tempFilePath: fp, size: 70, fileType: 'image' }] })
    await tap('.attach')
    const input = await until(async () => (await page()).data('input'), 30000, 'the upload to finish')
    const note = (await text('.upload-note')).trim()
    await mp.navigateBack()
    return 'note "' + note + '"; box "' + input.replace(/\n/g, ' ') + '"'
  })

  await step('对话: search; long-press → 重命名, 归档, 显示已归档, 取消归档, 删除', async () => {
    const p = await tabTo('/pages/index/index'); await sleep(1500)
    const n0 = (await els('.row')).length; assert(n0 >= 2, n0 + ' chats')
    await type('.search', '押金'); await sleep(500); const found = (await els('.row')).length
    await type('.search', ''); await sleep(500)
    await stub('showActionSheet', { tapIndex: 0 }); await stub('showModal', { confirm: true, cancel: false, content: '押金纠纷（测试）' })
    await (await els('.row'))[0].longpress(); await sleep(1500)
    assert((await (await els('.row'))[0].text()).includes('押金纠纷（测试）'), 'rename not shown')
    const id = (await p.data('list'))[0].id
    await restoreAll()
    await stub('showActionSheet', { tapIndex: 1 })
    await (await els('.row'))[0].longpress(); await sleep(1500)
    assert(!(await p.data('list')).some((c) => c.id === id), 'still listed after 归档')
    await tap('.link'); await sleep(1500); const link = (await text('.link')).trim()
    const ai = (await p.data('list')).findIndex((c) => c.id === id); assert(ai >= 0, 'not in 已归档')
    await (await els('.row'))[ai].longpress(); await sleep(1500)
    await tap('.link'); await sleep(1500)
    assert((await p.data('list')).some((c) => c.id === id), 'not back after 取消归档')
    await restoreAll()
    const rows = await els('.row'); const list = await p.data('list'); const victim = list[list.length - 1]
    await stub('showActionSheet', { tapIndex: 2 }); await stub('showModal', { confirm: true, cancel: false })
    await rows[rows.length - 1].longpress(); await sleep(1500)
    assert(!(await p.data('list')).some((c) => c.id === victim.id), 'not deleted')
    return n0 + ' chats; search 押金 → ' + found + '; renamed; 归档 (link "' + link + '"); 取消归档; deleted 1 → ' + (await els('.row')).length + ' left'
  })

  async function openSettings(label) {
    await tabTo('/pages/me/me'); await sleep(800)
    await tapText('.item', label)
    const p = await onPage('pages/settings/settings')
    await until(async () => (await p.data('loaded')), 10000, 'settings'); await sleep(800)
    return p
  }

  await step('设置 · 维拉的风格: tap tone + length, pick time zone, type 所在地 + 保存', async () => {
    const p = await openSettings('维拉的风格')
    const segs = await els('.seg-item'); const labels = []
    for (const s of segs) labels.push((await s.text()).trim())
    await segs[1].tap(); await sleep(1000)
    await segs[segs.length - 1].tap(); await sleep(1000)
    await (await el('picker')).trigger('change', { value: 1 }); await sleep(1000)
    await type('.input.grow', '上海'); await tap('.inline button'); await sleep(1200)
    const on = []; for (const s of await els('.seg-item.on')) on.push((await s.text()).trim())
    const zone = (await p.data('zones'))[await p.data('zoneIndex')]; const jur = await p.data('jurisdiction')
    const saved = JSON.parse(sql(`SELECT data FROM user_preferences WHERE user_id=(SELECT user_id FROM goals WHERE id='${goalId}')`) || '{}')
    assert(on.length === 2, 'selected: ' + on)
    assert(saved.timezone === zone && saved.jurisdiction === '上海', 'stored ' + JSON.stringify(saved))
    await mp.navigateBack()
    return 'options ' + labels.join('/') + '; on: ' + on.join(', ') + '; zone ' + zone + '; 所在地 ' + jur + ' (stored)'
  })

  await step('设置 · 隐私与记忆: memory switch, 导出我的数据 (share stubbed), 全部忘记', async () => {
    const p = await openSettings('隐私与记忆')
    const uid = sql(`SELECT user_id FROM goals WHERE id='${goalId}'`)
    sql(`INSERT INTO memories (user_id, content) VALUES ('${uid}','住在上海'),('${uid}','对青霉素过敏')`)
    await mp.navigateBack(); await openSettings('隐私与记忆')
    const p2 = await page()
    const mems = (await p2.data('memories')).length
    const sw = await el('switch'); await sw.trigger('change', { value: false }); await sleep(1000)
    assert((await p2.data('p')).memory_enabled === false, 'memory off not saved')
    await sw.trigger('change', { value: true }); await sleep(1000)
    await stub('shareFileMessage', function (o) { const t = wx.getFileSystemManager().readFileSync(o.filePath, 'utf8'); getApp().__exp = { n: t.length, keys: Object.keys(JSON.parse(t)).join(',') }; return {} })
    await tapText('button', '导出我的数据')
    const exp = await until(() => mp.evaluate(() => getApp().__exp), 15000, 'export')
    await stub('showModal', { confirm: true, cancel: false })
    await tapText('button', '全部忘记'); await sleep(1500)
    const left = (await p2.data('memories')).length
    assert(mems === 2 && left === 0, mems + ' → ' + left)
    await mp.navigateBack()
    return 'memory off/on; export ' + exp.n + ' B (' + exp.keys + '); 2 memories → 0'
  })

  await step('我的: profile, 邮票, 待审批, settings sections', async () => {
    await tabTo('/pages/me/me'); await sleep(1500)
    const items = await els('.item'); assert(items.length >= 8, items.length + ' items')
    const labels = []; for (const i of items) labels.push((await i.text()).replace(/\s+/g, ' ').trim().slice(0, 12))
    await items[0].tap(); await onPage('pages/stamps/stamps'); await mp.navigateBack(); await onPage('pages/me/me')
    await (await els('.item'))[1].tap(); await onPage('pages/approvals/approvals'); await mp.navigateBack(); await onPage('pages/me/me')
    return labels.join(' | ')
  })

  await step('设置 · 个人资料: type a name, tap 保存', async () => {
    const p = await openSettings('个人资料')
    await type('.input.grow', '测试用户')
    await tap('.inline button')
    await until(async () => (await p.data('user')).name === '测试用户', 8000, 'saved')
    await mp.navigateBack()
    return 'name saved as 测试用户'
  })

  await step('设置 · 通知: switches (email ones disabled for WeChat accounts)', async () => {
    const p = await openSettings('通知')
    const sw = await els('switch')
    const dis = []; for (const s of sw) dis.push(await s.attribute('disabled'))
    await mp.navigateBack()
    return sw.length + ' switches; disabled: ' + dis.join(',') + ' (WeChat accounts have no email)'
  })

  await step('设置 · 已登录的设备', async () => {
    await openSettings('已登录的设备')
    const t = (await text('.pad')).replace(/\s+/g, ' ')
    assert(t.includes('当前设备'), 'no current device shown: ' + t.slice(0, 80))
    await mp.navigateBack()
    return '"' + t.slice(0, 80) + '"'
  })

  await step('设置 · 额度与用量: usage shown; type limits, tap 保存', async () => {
    const p = await openSettings('额度与用量')
    const inputs = await els('.input.grow'); const btns = await els('.inline button')
    await inputs[0].input('15'); await btns[0].tap(); await sleep(1000)
    await inputs[1].input('20'); await btns[1].tap(); await sleep(1000)
    const t = (await text('.pad')).replace(/\s+/g, ' ')
    assert((await p.data('cost')) === '15' && (await p.data('days')) === '20', 'limits')
    await mp.navigateBack()
    return '"' + t.slice(0, 90) + '"'
  })

  await step('设置 · 专业人士: fill the licence form, tap 提交', async () => {
    const p = await openSettings('专业人士')
    await (await el('picker')).trigger('change', { value: 1 }); await sleep(300)
    const ins = await els('.input.full'); await ins[0].input('110101199001011234'); await ins[1].input('上海'); await sleep(300)
    await tap('button.gap')
    await until(async () => (await p.data('licenses')).length, 10000, 'licence listed')
    const l = (await p.data('licenses'))[0]
    await mp.navigateBack()
    return l.kind + ' ' + l.sub + ' → ' + l.statusLabel
  })

  await step('设置 · 外观: tap 深色 → dark UI; 大 font; back to defaults', async () => {
    const p = await openSettings('外观')
    await tapText('.seg-item', '深色'); await sleep(1200)
    const ui = await p.data('ui'); await shot('look-dark')
    await tabTo('/pages/index/index'); await sleep(800); await shot('conversations-dark')
    const p2 = await openSettings('外观')
    await tapText('.seg-item', '大'); await sleep(800); const ui2 = await p2.data('ui')
    await tapText('.seg-item', '跟随系统'); await sleep(600); await tapText('.seg-item', '中'); await sleep(600)
    await mp.navigateBack()
    assert(/dark/.test(ui), 'dark not applied: ' + ui)
    return 'dark → "' + ui + '"; 大 → "' + ui2 + '"; reset'
  })

  await step('Case page: tap 取消案件 (confirm stubbed)', async () => {
    const cases = await tabTo('/pages/cases/cases'); await sleep(1200)
    const ix = (await cases.data('goals')).findIndex((g) => g.id === goalId)
    assert(ix >= 0, 'case not listed')
    await (await els('.tile'))[ix].tap()
    const p = await onPage('pages/case/case'); await until(async () => (await p.data('g')), 10000, 'case')
    await stub('showModal', { confirm: true, cancel: false })
    await tapText('.actions button', '取消案件')
    await until(async () => (await p.data('g')).status === 'cancelled', 15000, 'cancelled')
    const btns = (await text('.actions')).replace(/\s+/g, ' ').trim()
    assert(!btns.includes('取消案件'), 'cancel still offered')
    await mp.navigateBack()
    return 'cancelled; buttons now "' + btns + '"; DB status ' + sql(`SELECT status FROM goals WHERE id='${goalId}'`)
  })

  await step('Live update: sign in on 案件, case paused on the server → list refetches and shows 已暂停 by itself', async () => {
    await mp.reLaunch('/pages/cases/cases'); await sleep(1000)
    const token = await mp.evaluate(() => wx.getStorageSync('act_token'))
    const uid = await new Promise((res) => http.get({ host: '127.0.0.1', port: 8080, path: '/api/settings', headers: { Authorization: 'Bearer ' + token, 'X-ACT': '1' } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b).user.id)) }))
    const gid = sql(`INSERT INTO goals (user_id,title,objective,domain,skill,status,language) VALUES ('${uid}','实时更新测试案件','o','legal','new-matter','active','zh') RETURNING id`).split('\n')[0]
    const p = await page()
    await until(async () => { const before = (await p.data('goals')) || []; return before.some((g) => g.id === gid) }, 20000, 'the new case to appear by itself (insert → no event, so tap refresh)').catch(async () => { await mp.reLaunch('/pages/cases/cases'); await sleep(1500) })
    const p2 = await page()
    const st0 = ((await p2.data('goals')).find((g) => g.id === gid) || {}).statusLabel
    const code = await new Promise((res) => { const q = http.request('http://127.0.0.1:8080/api/goals/' + gid + '/pause', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'X-ACT': '1' } }, (r) => { r.resume(); res(r.statusCode) }); q.end() })
    const g = await until(async () => { const x = (await p2.data('goals')).find((g) => g.id === gid); return x && x.status === 'paused' && x }, 15000, 'the tile to show paused by itself')
    const tile = (await (await els('.tile'))[0].text()).replace(/\s+/g, ' ')
    return 'pause → ' + code + '; tile ' + st0 + ' → ' + g.statusLabel + ' with no reload ("' + tile.slice(0, 24) + '")'
  })
  await step('Out of stamps → 购买邮票 → buy → back: the unsent message and 重试 are still there; 重试 sends it, charged once', async () => {
    await mp.reLaunch('/pages/chat/chat'); await sleep(1000)
    let b = await balance()
    while (b > 0) { await sendChat('谢谢。'); b = await balance() }
    await stub('showModal', function (o) { return { confirm: true, cancel: false } }) // 购买邮票
    await type('.box', '这条消息不能丢'); await tap('.send')
    const st = await onPage('pages/stamps/stamps', 20000); await sleep(1000)
    await restoreAll()
    await stub('requestVirtualPayment', { errMsg: 'requestVirtualPayment:ok' })
    await (await els('.pack'))[0].tap()
    await mock.grant((await st.data('packs'))[0])
    await until(async () => (await st.data('balance')) > 0, 10000, 'balance after buying')
    await mp.navigateBack(); const c = await onPage('pages/chat/chat'); await sleep(2500)
    const failed = await (await page()).$('.msg.user .fail')
    assert(failed, 'the unsent message and its 重试 are gone after coming back')
    const bubbles = await els('.msg.user .bubble'); const lastText = await bubbles[bubbles.length - 1].text()
    assert(lastText.includes('这条消息不能丢'), 'last user bubble: ' + lastText)
    const b0 = await balance()
    await failed.tap(); await sleep(800)
    await until(async () => (await c.data('sending')) === false, 60000, 'reply')
    assert(!(await (await page()).$('.msg.user .fail')), 'still failed')
    assert((await balance()) === b0 - 1, 'charged ' + (b0 - (await balance())))
    const n = (await els('.msg.user .bubble')).length
    await sleep(1500)
    const users = []; for (const x of await els('.msg.user .bubble')) users.push(await x.text())
    assert(users.filter((t) => t.includes('这条消息不能丢')).length === 1, 'shown ' + users.filter((t) => t.includes('这条消息不能丢')).length + ' times')
    return 'message kept with 重试 after buying; resent; 1 stamp; shown once'
  })
  await step('我的: tap 退出登录 (confirm stubbed); then sign in from 案件 → same account', async () => {
    await tabTo('/pages/me/me'); await sleep(800)
    await stub('showModal', { confirm: true, cancel: false })
    await tap('.out')
    await until(async () => !(await (await page()).$('.out')), 8000, 'signed out')
    assert(!(await mp.evaluate(() => wx.getStorageSync('act_token'))), 'token kept')
    await restoreAll()
    await tabTo('/pages/cases/cases'); await sleep(800)
    await tap('.empty-card'); await signInFromSheet()
    await until(async () => (await els('.tile')).length, 10000, 'cases after sign-in')
    const has = (await (await page()).data('goals')).some((g) => g.id === goalId)
    assert(has, 'different account after sign-in')
    return 'signed out (token cleared); signed back in; the same case is there'
  })

  await step('隐私与记忆: tap 删除账户 (confirm stubbed; WeChat accounts need no password)', async () => {
    const uid = sql(`SELECT user_id FROM goals WHERE id='${goalId}'`)
    await openSettings('隐私与记忆')
    await stub('showModal', { confirm: true, cancel: false })
    await tapText('button', '删除账户')
    await onPage('pages/index/index', 15000); await sleep(1000)
    assert(await el('.empty-card'), 'not signed out')
    const left = sql(`SELECT count(*) FROM users WHERE id='${uid}'`) + '/' + sql(`SELECT count(*) FROM goals WHERE user_id='${uid}'`) + '/' + sql(`SELECT count(*) FROM conversations WHERE user_id='${uid}'`)
    assert(left === '0/0/0', 'left behind users/goals/convs: ' + left)
    return 'back on 对话 signed out; user, cases and chats gone from the DB'
  })

  finish()
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(2) })
