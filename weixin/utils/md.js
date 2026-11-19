// Markdown → HTML for <rich-text>, matching what the web app renders with
// marked (gfm, breaks: true). Model output is untrusted: everything is
// escaped first, and only the tags built here are emitted. Styles are inline
// because <rich-text> does not see page classes.

const C = {
  p: 'margin:0 0 0.8em;',
  ul: 'padding-left:1.3em;margin:0 0 0.8em;',
  li: 'margin:0.25em 0;',
  strong: 'font-weight:650;',
  code: 'background:var(--surface-2);padding:1px 6px;border-radius:6px;font-size:0.9em;font-family:Menlo,Consolas,monospace;',
  pre: 'background:var(--surface-2);padding:12px 14px;border-radius:12px;overflow-x:auto;white-space:pre-wrap;font-size:0.9em;font-family:Menlo,Consolas,monospace;margin:0 0 0.8em;',
  quote: 'margin:0 0 0.8em;padding-left:14px;border-left:3px solid var(--ember-400);color:var(--text-2);',
  h: 'font-weight:700;letter-spacing:-0.01em;line-height:1.3;margin:1em 0 0.5em;',
  hr: 'border:0;border-top:1px solid var(--line-strong);margin:1.2em 0;',
  a: 'color:var(--ember-600);text-decoration:underline;',
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s) {
  const codes = []
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => {
    codes.push('<code style="' + C.code + '">' + c + '</code>')
    return '\u0000' + (codes.length - 1) + '\u0000'
  })
  s = s
    .replace(/\*\*(.+?)\*\*/g, '<strong style="' + C.strong + '">$1</strong>')
    .replace(/__(.+?)__/g, '<strong style="' + C.strong + '">$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    // Links cannot be opened from a mini program bubble: show the text.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span style="' + C.a + '">$1</span>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i])
}

function md(text) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let para = []
  let list = null // { tag, items }
  const flushPara = () => {
    if (para.length) out.push('<p style="' + C.p + '">' + para.map(inline).join('<br/>') + '</p>')
    para = []
  }
  const flushList = () => {
    if (list) {
      out.push('<' + list.tag + ' style="' + C.ul + '">' + list.items.map((x) => '<li style="' + C.li + '">' + inline(x) + '</li>').join('') + '</' + list.tag + '>')
    }
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flushPara()
      flushList()
      const body = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      out.push('<pre style="' + C.pre + '">' + esc(body.join('\n')) + '</pre>')
      continue
    }
    let m
    if (!line.trim()) {
      flushPara()
      flushList()
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara()
      flushList()
      const size = ['1.35em', '1.2em', '1.08em', '1em', '1em', '1em'][m[1].length - 1]
      out.push('<p style="' + C.h + 'font-size:' + size + ';">' + inline(m[2]) + '</p>')
    } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushPara()
      flushList()
      out.push('<hr style="' + C.hr + '"/>')
    } else if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara()
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul'
      if (list && list.tag !== tag) flushList()
      if (!list) list = { tag, items: [] }
      list.items.push(m[2])
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flushPara()
      flushList()
      out.push('<p style="' + C.quote + '">' + inline(m[1]) + '</p>')
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()
  return out.join('')
}

module.exports = { md }
