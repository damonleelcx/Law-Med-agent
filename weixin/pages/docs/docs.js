const api = require('../../utils/api')
const fmt = require('../../utils/fmt')
const S = require('../../utils/strings')
const page = require('../../utils/page')

const ACCEPT = ['pdf', 'docx', 'txt', 'md', 'csv', 'eml', 'png', 'jpg', 'jpeg', 'webp', 'gif']

// The web app's Documents list, with upload.
page({
  data: { docs: null, msg: '' },

  onShow() {
    if (api.loggedIn()) this.load()
  },
  onLive() {
    this.load()
  },
  onSignedIn() {
    this.load()
  },
  onPullDownRefresh() {
    ;(api.loggedIn() ? this.load() : Promise.resolve()).then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api
      .get('/api/documents')
      .then((ds) =>
        this.setData({
          docs: ds.map((d) => ({
            id: d.id,
            title: d.title,
            from: d.goal_title || '',
            sub: d.kind + ' · v' + d.version + ' · ' + fmt.time(d.created_at, true),
          })),
        })
      )
      .catch((e) => {
        if (e.needLogin) this.setData({ signedIn: false })
        this.setData({ docs: [] })
      })
  },

  open(e) {
    wx.navigateTo({ url: '/pages/doc/doc?id=' + e.currentTarget.dataset.id })
  },

  upload() {
    this.requireLogin()
      .then(
        () =>
          new Promise((resolve, reject) => {
            wx.showActionSheet({ itemList: S.attachFrom, success: (r) => resolve(r.tapIndex), fail: () => reject({ cancelled: true }) })
          })
      )
      .then((i) => (i === 0 ? pickFile() : pickImage()))
      .then((f) => {
        this.setData({ msg: S.uploading })
        return api.upload(f.path, f.name)
      })
      .then((r) => {
        this.setData({ msg: '' })
        wx.navigateTo({ url: '/pages/doc/doc?id=' + r.id })
      })
      .catch((e) => {
        if (e && e.cancelled) return
        this.setData({ msg: (e && e.message) || S.error })
      })
  },

  signIn() {
    this.requireLogin().catch(() => {})
  },
})

function pickFile() {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ACCEPT,
      success: (r) => resolve({ path: r.tempFiles[0].path, name: r.tempFiles[0].name }),
      fail: () => reject({ cancelled: true }),
    })
  })
}

function pickImage() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (r) => {
        const p = r.tempFiles[0].tempFilePath
        const ext = (p.split('.').pop() || 'jpg').toLowerCase()
        resolve({ path: p, name: '图片_' + new Date().toISOString().slice(0, 10) + '.' + ext })
      },
      fail: () => reject({ cancelled: true }),
    })
  })
}
