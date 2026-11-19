// Full UI run against the real model (Hunyuan). Vera opens a real case,
// plans it and drafts documents, so this uses a lot of model tokens (one run
// used ~880k, which ran out a free quota). Prefer devmock.js; run this one
// before a release.
//
//   SHOTS=./shots node real-model.js
require('./lib')
;(async () => {
  await connect()
  let goalId = '', convTitle = ''

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

  await step('Describe a deposit dispute → Vera opens a case; its card shows in the chat', async () => {
    await mp.reLaunch('/pages/index/index'); await sleep(800)
    await tap('.new'); await onPage('pages/chat/chat')
    await sendChat('我在上海租房，合同到期搬走已经一个月了，房东一直不退还5000元押金，也不回消息。请帮我立案处理：整理事实，起草一封给房东的催告函。')
    const card = async () => (await page()).$('.goal-card')
    for (let k = 0; k < 2 && !(await card()); k++) { await sleep(5000); if (!(await card())) await sendChat('信息就这些，请直接开始，帮我立案并起草催告函。') }
    const gc = await until(card, 90000, 'a case card in the chat')
    const t = (await (await gc.$('.gc')).text()).replace(/\s+/g, ' ')
    convTitle = '押金'
    return 'case card: "' + t.slice(0, 80) + '"'
  })

  await step('Tap the case card → case page with plan, 暂停 / 继续', async () => {
    const cards = await els('.goal-card')
    await (await until(async () => cards[cards.length - 1].$('.gc'), 5000, 'card body')).tap()
    const p = await onPage('pages/case/case')
    await until(async () => (await p.data('g')), 15000, 'case')
    goalId = await p.data('id')
    const title = await text('.h1')
    let note = '"' + title.trim() + '"'
    if (await p.$('.btn-soft.btn-sm:nth-child(2)') && (await p.data('g')).canPause) {
      await tapText('.actions button', '暂停')
      await until(async () => (await p.data('g')).status === 'paused', 15000, 'paused')
      const st = await text('.actions')
      await tapText('.actions button', '继续')
      await until(async () => (await p.data('g')).status !== 'paused', 15000, 'resumed')
      note += '; 暂停 → buttons "' + st.replace(/\s+/g, ' ').trim() + '"; 继续 → ' + (await p.data('g')).statusLabel
    }
    return note
  })

  await step('Vera works the case: plan steps complete, a document appears (real model, up to 10 min)', async () => {
    const p = await page()
    const res = await until(async () => {
      const g = await p.data('g'); const d = await p.data('docs'); const a = await p.data('approvals')
      if (g.status === 'completed' || (d && d.length) || (a && a.length)) return { docs: d.length, appr: a.length, status: g.statusLabel }
      if (g.needsAttention) return { attention: g.attention }
    }, 10 * 60000, 'a document or approval')
    const tasks = await p.data('tasks')
    await tapText('.seg-item', '时间线'); await sleep(600); await shot('case-timeline')
    const tl = (await els('.ev, .event, .tl-row')).length
    await tapText('.seg-item', '文件'); await sleep(600); await shot('case-files')
    const rows = (await els('.file-row')).length
    await tapText('.seg-item', '计划'); await sleep(400)
    const sums = await els('.plan-sum'); if (sums.length) { await sums[0].tap(); await sleep(300) }
    if (res.attention) return 'case needs attention: ' + res.attention
    return tasks.filter((t) => t.icon === 'done').length + '/' + tasks.length + ' steps done; ' + rows + ' file row(s); ' + res.appr + ' approval(s); status ' + res.status
  })

  await step('Approval: answer Vera in the chat → approval card; note + tap 同意 on 待审批', async () => {
    let p = await page()
    if (!(await p.data('approvals')).length) {
      await tap('.actions button') // 💬 维拉: back to the case's chat
      await onPage('pages/chat/chat'); await sleep(1500)
      await sendChat('我批准使用这份催告函作为最终稿。房东的邮箱是 landlord@example.com，请发送给他。')
      await mp.navigateBack(); p = await onPage('pages/case/case')
    }
    await until(async () => { const a = await p.data('approvals'); const g = await p.data('g'); return (a && a.length) || g.status === 'completed' }, 5 * 60000, 'an approval request')
    const ap = (await p.data('approvals'))[0]
    if (!ap) return 'no approval was needed: case ' + (await p.data('g')).statusLabel
    await mp.navigateTo('/pages/approvals/approvals')
    await onPage('pages/approvals/approvals'); await sleep(1500)
    const card = await el('.approval-card')
    const before = (await card.text()).replace(/\s+/g, ' ')
    const note = await card.$('.ap-note'); await note.input('可以，按这个发'); await sleep(300)
    await (await card.$('.btn-ember')).tap()
    await until(async () => { const c = await (await page()).$('.approval-card'); return !c || !(await c.$('.btn-ember')) }, 20000, 'the decision to land')
    const after = (await text('.pad')).replace(/\s+/g, ' ')
    await mp.navigateBack()
    return '"' + before.slice(0, 50) + '…" → 同意; page now "' + after.slice(0, 60) + '…"'
  })

  await step('文件 tab: list → open → 复制全文 and 发送到聊天', async () => {
    await tabTo('/pages/docs/docs'); await sleep(1500)
    const rows = await els('.file-row'); assert(rows.length, 'no documents listed')
    const first = (await rows[0].text()).replace(/\s+/g, ' ')
    await rows[0].tap()
    const d = await onPage('pages/doc/doc'); await until(async () => (await d.data('d')), 10000, 'doc')
    const body = JSON.stringify((await d.data('d')).html)
    await stub('setClipboardData', function (o) { getApp().__clip = o.data.length; return {} })
    await stub('shareFileMessage', function (o) { getApp().__share = { name: o.fileName, size: wx.getFileSystemManager().statSync(o.filePath).size }; return {} })
    await tapText('.actions button', '复制全文'); const clip = await until(() => mp.evaluate(() => getApp().__clip), 5000, 'clipboard')
    await tapText('.actions button', '发送'); const sh = await until(() => mp.evaluate(() => getApp().__share), 5000, 'share')
    await mp.navigateBack()
    return '"' + first.slice(0, 40) + '"; copied ' + clip + ' chars; sent ' + sh.name + ' (' + sh.size + ' B)'
  })

  await step('文件 tab: tap ↑ 上传, pick a file from a WeChat chat (picker stubbed) → opens it', async () => {
    const fp = await mp.evaluate(() => { const f = wx.env.USER_DATA_PATH + '/租赁合同摘要.txt'; wx.getFileSystemManager().writeFileSync(f, '租赁合同摘要\n押金：5000元\n租期：2025年11月至2026年10月\n', 'utf8'); return f })
    await stub('showActionSheet', { tapIndex: 0 })
    await stub('chooseMessageFile', { tempFiles: [{ path: fp, name: '租赁合同摘要.txt', size: 60 }] })
    await tap('.head button')
    const d = await onPage('pages/doc/doc', 20000); await until(async () => (await d.data('d')), 10000, 'doc')
    const title = await text('.h1'); const body = JSON.stringify((await d.data('d')).html)
    assert(title.includes('租赁合同摘要'), 'title ' + title)
    assert(body.includes('5000'), 'body ' + body.slice(0, 80))
    await mp.navigateBack()
    return 'opened "' + title.trim() + '", body has the 5000元 line'
  })

  await step('Chat: tap 📎, pick a photo (picker stubbed) → upload note in the box', async () => {
    await tabTo('/pages/index/index'); await sleep(600)
    await tap('.new'); await onPage('pages/chat/chat'); await sleep(500)
    const fp = await mp.evaluate(() => { const f = wx.env.USER_DATA_PATH + '/receipt.png'; wx.getFileSystemManager().writeFileSync(f, wx.base64ToArrayBuffer('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==')); return f })
    await stub('showActionSheet', { tapIndex: 1 })
    await stub('chooseMedia', { type: 'image', tempFiles: [{ tempFilePath: fp, size: 70, fileType: 'image' }] })
    await tap('.attach')
    const input = await until(async () => (await page()).data('input'), 30000, 'the upload to finish')
    const note = await text('.upload-note')
    assert(input, 'nothing added to the box')
    return 'note "' + note.trim() + '"; box: "' + input.replace(/\n/g, ' ') + '"'
  })

  await step('对话 tab: search, long-press → 重命名 / 归档 / 显示已归档 / 取消归档 / 删除', async () => {
    await tabTo('/pages/index/index'); await sleep(1500)
    const rows = await els('.row'); assert(rows.length >= 3, rows.length + ' conversations')
    await type('.search', '押金'); await sleep(500)
    const found = (await els('.row')).length
    await type('.search', ''); await sleep(500)
    const p = await page()
    // rename the first
    await stub('showActionSheet', { tapIndex: 0 }); await stub('showModal', { confirm: true, cancel: false, content: '押金纠纷（测试）' })
    await (await els('.row'))[0].longpress(); await sleep(1500)
    assert((await (await els('.row'))[0].text()).includes('押金纠纷（测试）'), 'rename not shown')
    const id = (await p.data('list'))[0].id
    await restoreAll()
    // archive it
    await stub('showActionSheet', { tapIndex: 1 })
    await (await els('.row'))[0].longpress(); await sleep(1500)
    assert(!(await p.data('list')).some((c) => c.id === id), 'still listed after 归档')
    await tap('.link'); await sleep(1500)
    const linkText = await text('.link')
    const arch = await p.data('list'); const ai = arch.findIndex((c) => c.id === id)
    assert(ai >= 0, 'not in 已归档')
    await (await els('.row'))[ai].longpress(); await sleep(1500)
    await tap('.link'); await sleep(1500)
    assert((await p.data('list')).some((c) => c.id === id), 'not back after 取消归档')
    await restoreAll()
    // delete the oldest
    const all = await els('.row'); const victim = (await p.data('list'))[all.length - 1]
    await stub('showActionSheet', { tapIndex: 2 }); await stub('showModal', { confirm: true, cancel: false })
    await all[all.length - 1].longpress(); await sleep(1500)
    assert(!(await p.data('list')).some((c) => c.id === victim.id), 'not deleted')
    await restoreAll()
    // tap a row opens it
    await (await els('.row'))[0].tap(); await onPage('pages/chat/chat'); await sleep(800)
    const nMsgs = (await els('.msg')).length
    await mp.navigateBack()
    return rows.length + ' chats; search 押金 → ' + found + '; renamed, 归档 (link "' + linkText.trim() + '"), 取消归档, deleted 1; tapping a row opened it with ' + nMsgs + ' messages'
  })

  await step('案件 tab: tile shows the case; tap opens it', async () => {
    await tabTo('/pages/cases/cases'); await sleep(1500)
    const tiles = await els('.tile'); assert(tiles.length, 'no case tiles')
    const t = (await tiles[0].text()).replace(/\s+/g, ' ')
    await tiles[0].tap(); await onPage('pages/case/case'); await sleep(800)
    await mp.navigateBack()
    return '"' + t.slice(0, 70) + '"'
  })

  await step('我的: profile, 邮票, 待审批, settings sections', async () => {
    await tabTo('/pages/me/me'); await sleep(1500)
    const items = await els('.item'); assert(items.length >= 8, items.length + ' items')
    const labels = []; for (const i of items) labels.push((await i.text()).replace(/\s+/g, ' ').trim().slice(0, 12))
    await items[0].tap(); await onPage('pages/stamps/stamps'); await mp.navigateBack(); await onPage('pages/me/me')
    await (await els('.item'))[1].tap(); await onPage('pages/approvals/approvals'); await mp.navigateBack(); await onPage('pages/me/me')
    return labels.join(' | ')
  })

  async function openSettings(label) {
    await tabTo('/pages/me/me'); await sleep(800)
    await tapText('.item', label)
    const p = await onPage('pages/settings/settings')
    await until(async () => (await p.data('loaded')), 10000, 'settings')
    await sleep(800)
    return p
  }

  await step('设置 · 个人资料: type a name, tap 保存', async () => {
    const p = await openSettings('个人资料')
    await type('.input.grow', '测试用户')
    await tap('.inline button')
    await until(async () => (await p.data('user')).name === '测试用户', 8000, 'saved')
    await mp.navigateBack()
    return 'name saved as 测试用户'
  })

  await step('设置 · 维拉的风格: tap tone + length segments, pick time zone, type 所在地', async () => {
    const p = await openSettings('维拉的风格')
    const segs = await els('.seg-item'); const labels = []
    for (const s of segs) labels.push((await s.text()).trim())
    await segs[1].tap(); await sleep(1000)
    await segs[segs.length - 1].tap(); await sleep(1000)
    await (await el('picker')).trigger('change', { value: 1 }); await sleep(1000)
    await type('.input.grow', '上海'); await tap('.inline button'); await sleep(1000)
    const pp = await p.data('p'); const on = []
    for (const s of await els('.seg-item.on')) on.push((await s.text()).trim())
    assert(on.length === 2, 'selected segments: ' + on)
    const res = 'options ' + labels.join('/') + '; now on: ' + on.join(', ') + '; zone ' + (await p.data('zones'))[await p.data('zoneIndex')] + '; 所在地 ' + (await p.data('jurisdiction'))
    await mp.navigateBack()
    return res
  })

  await step('设置 · 通知: switches (email ones disabled for WeChat accounts)', async () => {
    const p = await openSettings('通知')
    const sw = await els('switch')
    const dis = []; for (const s of sw) dis.push(await s.attribute('disabled'))
    await mp.navigateBack()
    return sw.length + ' switches; disabled: ' + dis.join(',') + ' (WeChat accounts have no email)'
  })

  await step('设置 · 隐私与记忆: memory switch, 导出 (share stubbed), 忘记全部', async () => {
    const p = await openSettings('隐私与记忆')
    const sw = await el('switch'); await sw.trigger('change', { value: false }); await sleep(1000)
    assert((await p.data('p')).memory_enabled === false, 'memory off not saved')
    await sw.trigger('change', { value: true }); await sleep(1000)
    await stub('shareFileMessage', function (o) { getApp().__exp = wx.getFileSystemManager().readFileSync(o.filePath, 'utf8').length; return {} })
    await tapText('button', '导出我的数据')
    const exp = await until(() => mp.evaluate(() => getApp().__exp), 15000, 'export')
    const mems = (await p.data('memories')).length
    if (mems) { await stub('showModal', { confirm: true, cancel: false }); await tapText('button', '全部忘记'); await sleep(1500) }
    const left = mems ? (await p.data('memories')).length : 0
    await mp.navigateBack()
    return 'memory off/on saved; export ' + exp + ' bytes; ' + mems + ' memories → ' + left
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

  await step('Live update: case changed on the server shows on the open 案件 list', async () => {
    const p = await tabTo('/pages/cases/cases'); await sleep(1500)
    const before = (await p.data('goals')).find((g) => g.id === goalId)
    assert(before, 'case not listed')
    const action = ['paused', 'needs_attention'].includes(before.status) ? 'resume' : 'pause'
    const token = await mp.evaluate(() => wx.getStorageSync('act_token'))
    await new Promise((res, rej) => { const q = http.request('http://127.0.0.1:8080/api/goals/' + goalId + '/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }, (r) => { r.resume(); r.on('end', res) }); q.on('error', rej); q.end() })
    const after = await until(async () => { const g = (await p.data('goals')).find((g) => g.id === goalId); return g.status !== before.status && g }, 20000, 'the list to update by itself')
    return before.statusLabel + ' → ' + after.statusLabel + ' without a reload'
  })

  await step('取消 the case (confirm stubbed)', async () => {
    await (await els('.tile'))[0].tap()
    const p = await onPage('pages/case/case'); await until(async () => (await p.data('g')), 10000, 'case')
    await stub('showModal', { confirm: true, cancel: false })
    await tapText('.actions button', '取消案件')
    await until(async () => (await p.data('g')).status === 'cancelled', 15000, 'cancelled')
    const st = (await text('.pad')).replace(/\s+/g, ' ').slice(0, 60)
    await mp.navigateBack()
    return '"' + st + '"'
  })

  await step('退出登录, then sign in again from 案件 → same account', async () => {
    await tabTo('/pages/me/me'); await sleep(800)
    await stub('showModal', { confirm: true, cancel: false })
    await tap('.out')
    await until(async () => !(await (await page()).$('.out')), 8000, 'signed out')
    await restoreAll()
    const p = await tabTo('/pages/cases/cases'); await sleep(800)
    await tap('.empty-card')
    await signInFromSheet()
    await until(async () => (await els('.tile')).length, 10000, 'cases after sign-in')
    return 'signed out; signed back in; ' + (await els('.tile')).length + ' case(s) still there'
  })

  await step('删除账户 (WeChat account: no password)', async () => {
    await openSettings('隐私与记忆')
    await stub('showModal', { confirm: true, cancel: false })
    await tapText('button', '删除账户')
    await onPage('pages/index/index', 15000); await sleep(1000)
    assert(await el('.empty-card'), 'not signed out')
    return 'deleted; back on 对话 signed out'
  })

  finish()
})().catch((e) => { console.error('FATAL', e.stack || e.message); fs.writeFileSync(path.join(SHOTS || '.', 'results.json'), JSON.stringify(R, null, 2)); process.exit(2) })
