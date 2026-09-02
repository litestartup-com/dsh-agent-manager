// Helpers shared by every page.
//
// These existed in four copies, one per page script, which had already drifted:
// two spellings of esc(), two of bannerHtml(), two money formatters. One copy is
// also what makes the page scripts modules -- as classic scripts they shared one
// global scope, so a second `const esc` was a hard SyntaxError.

/**
 * Escapes everything before it reaches the DOM.
 *
 * The data is written by an agent that reads mail, web pages and dictation, so
 * any field is attacker-influenced text. Unescaped, one crafted note becomes
 * stored XSS on manager's own origin -- the origin holding the session cookie.
 */
export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )

export const $ = (id) => document.getElementById(id)

export const icon = (name, size = 14) =>
  `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}" /></svg>`

/**
 * Writes only when the markup actually changed.
 *
 * Most polls change nothing. Rewriting innerHTML anyway would move focus off
 * whatever the user had tabbed to and collapse any open native control, every
 * time the timer fires.
 */
const lastHtml = new Map()
export const setHtml = (id, html) => {
  if (lastHtml.get(id) === html) return
  lastHtml.set(id, html)
  const node = $(id)
  if (node !== null) node.innerHTML = html
}

/** `body` is pre-escaped by the caller, since some banners embed markup. */
export const bannerHtml = (b) => `<div class="banner ${b.level}">
  ${icon('alert', 15)}
  <div><strong>${esc(b.title)}</strong><div class="body">${b.body}</div></div>
</div>`

/** Same call shape as bannerHtml, for the common case of plain text. */
export const banner = (level, title, body) => bannerHtml({ level, title, body: esc(body) })

// Cost arrives as integer micro-USD so no float is ever stored server-side.
export const money = (micro) => (micro === null || micro === undefined ? '—' : `$${(micro / 1e6).toFixed(4)}`)

/**
 * A relative timestamp, for lists where the question is "which one did I touch
 * last", not "what time was it".
 *
 * Falls back to an absolute date beyond a week: "37 天前" is a number nobody
 * converts back into a day.
 */
export const ago = (ms) => {
  if (ms === null || ms === undefined) return ''
  const diff = Date.now() - ms
  // Clock skew, or a row written a moment ago by a server a second ahead.
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(ms).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export const when = (ms) =>
  ms === null || ms === undefined
    ? '—'
    : new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
