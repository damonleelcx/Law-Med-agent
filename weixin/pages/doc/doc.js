const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const { md } = require('../../utils/md')
const page = require('../../utils/page')

// One document, rendered like the web app's "paper". 下载 on the web becomes
// 复制全文 and 发送到聊天 (a .md file into a WeChat chat) here.
page({
  data: { id: '', d: null, err: '' },

  onLoad(q) {
    this.setData({ id: q.id })
  },
  onShow() {
    if (api.loggedIn() && !this.data.d) this.load()
  },
  onSignedIn() {
    this.load()
  },

  load() {
    api
      .get('/api/documents/' + this.data.id)
      .then((d) => {
        this._content = d.content
        wx.setNavigationBarTitle({ title: d.title.slice(0, 16) })
        this.setData({
          d: {
            title: d.title,
            meta: d.kind + ' · v' + d.version + ' · ' + fmt.time(d.created_at, true),
            html: md(d.content),
            sha: (d.sha256 || '').slice(0, 16),
          },
        })
      })
      .catch((e) => this.setData({ err: e.needLogin ? '' : e.message || S.error }))
  },

  copyAll() {
    wx.setClipboardData({ data: this._content || '', success: () => wx.showToast({ icon: 'none', title: S.docs.saved }) })
  },

  share() {
    const name = this.data.d.title.replace(/[\\/:*?"<>|]/g, '_') + (/\.[a-z0-9]+$/i.test(this.data.d.title) ? '' : '.md')
    const path = wx.env.USER_DATA_PATH + '/' + name
    try {
      wx.getFileSystemManager().writeFileSync(path, this._content || '', 'utf8')
    } catch (e) {
      return wx.showToast({ icon: 'none', title: S.error })
    }
    wx.shareFileMessage({ filePath: path, fileName: name, fail: () => {} })
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },
})
