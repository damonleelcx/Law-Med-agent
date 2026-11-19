// Streaming helpers for wx.request({ enableChunked: true }).
//
// Chunks arrive as ArrayBuffers cut at arbitrary byte offsets, so a Chinese
// character can be split across two chunks. Utf8Stream holds back an
// incomplete trailing sequence until the rest of it arrives. SSEParser then
// turns text into (event, data) pairs.

function Utf8Stream() {
  this.rest = []
}

Utf8Stream.prototype.push = function (buf) {
  const bytes = Array.prototype.slice.call(new Uint8Array(buf))
  const all = this.rest.length ? this.rest.concat(bytes) : bytes
  // Find where the last complete sequence ends.
  let end = all.length
  for (let i = all.length - 1; i >= 0 && i >= all.length - 4; i--) {
    const b = all[i]
    if ((b & 0xc0) === 0x80) continue // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    if (all.length - i < need) end = i
    break
  }
  this.rest = all.slice(end)
  return decode(all, end)
}

function decode(b, end) {
  const out = []
  let i = 0
  while (i < end) {
    const c = b[i]
    let cp
    if (c < 0x80) {
      cp = c
      i += 1
    } else if (c < 0xe0) {
      cp = ((c & 0x1f) << 6) | (b[i + 1] & 0x3f)
      i += 2
    } else if (c < 0xf0) {
      cp = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)
      i += 3
    } else {
      cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f)
      i += 4
    }
    if (cp > 0xffff) {
      cp -= 0x10000
      out.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else {
      out.push(cp)
    }
  }
  let s = ''
  for (let j = 0; j < out.length; j += 4096) {
    s += String.fromCharCode.apply(null, out.slice(j, j + 4096))
  }
  return s
}

function SSEParser(onEvent) {
  this.buf = ''
  this.onEvent = onEvent
}

SSEParser.prototype.push = function (text) {
  this.buf += text.replace(/\r\n/g, '\n')
  let idx
  while ((idx = this.buf.indexOf('\n\n')) >= 0) {
    const block = this.buf.slice(0, idx)
    this.buf = this.buf.slice(idx + 2)
    let event = 'message'
    const data = []
    block.split('\n').forEach((line) => {
      if (!line || line[0] === ':') return
      const k = line.indexOf(':')
      const field = k < 0 ? line : line.slice(0, k)
      const value = k < 0 ? '' : line.slice(k + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    })
    if (!data.length) continue
    let parsed
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch (e) {
      parsed = data.join('\n')
    }
    this.onEvent(event, parsed)
  }
}

module.exports = { Utf8Stream, SSEParser }
