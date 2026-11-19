// Appearance preferences (Settings → 外观), as the web app applies them:
// theme (system / light / dark), font size, reduced motion. They live on the
// server with the rest of the preferences; this applies them to a page.

function prefs() {
  const app = getApp()
  return (app && app.globalData.prefs) || {}
}

function systemDark() {
  try {
    return (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()).theme === 'dark'
  } catch (e) {
    return false
  }
}

function dark() {
  const t = prefs().theme
  return t === 'dark' || ((!t || t === 'system') && systemDark())
}

// cls is the root class every page puts on its outermost view.
function cls() {
  const p = prefs()
  const out = []
  if (p.theme === 'light' || p.theme === 'dark') out.push('theme-' + p.theme)
  out.push('fs-' + (p.font_size || 'medium'))
  if (p.reduce_motion) out.push('motion-reduce')
  return out.join(' ')
}

// chrome colours the parts outside the page: navigation bar, page
// background and (on tab pages) the tab bar.
function chrome() {
  const d = dark()
  try {
    wx.setNavigationBarColor({ frontColor: d ? '#ffffff' : '#000000', backgroundColor: d ? '#15130f' : '#efe4d2' })
  } catch (e) {}
  try {
    wx.setBackgroundColor({ backgroundColor: d ? '#15130f' : '#efe4d2' })
  } catch (e) {}
  wx.setTabBarStyle({
    color: d ? '#9a8f80' : '#6f675d',
    selectedColor: d ? '#f08a4f' : '#e8662a',
    backgroundColor: d ? '#1b1814' : '#f6eee2',
    borderStyle: d ? 'black' : 'white',
    fail: () => {},
  })
}

module.exports = { cls, chrome, dark }
