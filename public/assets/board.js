// Renders a board from the block catalogue in src/board/model.ts.
//
// Every value that reaches the DOM goes through esc(). The data is written by an
// agent that reads mail, web pages and dictation, so a field like a KPI value is
// attacker-influenced text. Unescaped, one crafted note becomes stored XSS on
// manager's own origin -- the origin holding the session cookie.

import { esc, apiFetch } from './ui.js'

/** Tone is a closed set, so it is safe in a class attribute once checked. */
const TONES = new Set(['good', 'warn', 'bad', 'info', 'muted'])
const toneClass = (tone) => (TONES.has(tone) ? ` t-${tone}` : '')

const agentId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '')

const el = {
  title: document.getElementById('board-title'),
  asOf: document.getElementById('board-asof'),
  tabs: document.getElementById('board-tabs'),
  main: document.getElementById('board-main'),
  toast: document.getElementById('board-toast'),
}

let board = null

/**
 * Which page is open, seeded from `?page=`.
 *
 * In the URL because the conversation links straight to a page: a turn that says
 * it updated `board/money.json` renders that path as a link, and the point of
 * the link is to land on the money page rather than on whichever page happens to
 * be first (UI.md §6). An unknown key is not an error -- `renderPage` falls back
 * to the first page -- so a link to a page that has since been deleted still
 * opens the board instead of a blank screen.
 */
let activeKey = new URLSearchParams(window.location.search).get('page')

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

const card = (title, body, extraClass = '') =>
  `<section class="bcard${extraClass}">${
    title ? `<h2>${esc(title)}</h2>` : ''
  }<div class="bcard-body">${body}</div></section>`

const empty = (what) => `<p class="muted small">（${esc(what)}）</p>`

const renderers = {
  kpi: (b) =>
    b.items.length === 0
      ? card(b.title, empty('暂无指标'))
      : card(
          b.title,
          `<div class="kpi-grid">${b.items
            .map(
              (it) => `<div class="kpi${toneClass(it.tone)}">
        <div class="kpi-label">${esc(it.label)}</div>
        <div class="kpi-value">${esc(it.value)}</div>
        ${it.sub ? `<div class="kpi-sub">${esc(it.sub)}</div>` : ''}
      </div>`,
            )
            .join('')}</div>`,
        ),

  metrics: (b) =>
    card(
      b.title,
      b.items.length === 0
        ? empty('暂无数据')
        : `<table class="btable"><thead><tr><th>项目</th><th>当前</th><th>目标</th></tr></thead><tbody>${b.items
            .map(
              (it) => `<tr class="${toneClass(it.tone).trim()}">
          <td>${esc(it.name)}</td>
          <td class="num">${esc(it.value)}</td>
          <td class="num muted">${esc(it.target ?? '—')}</td>
        </tr>`,
            )
            .join('')}</tbody></table>`,
    ),

  list: (b) =>
    card(
      b.title,
      b.items.length === 0
        ? empty('暂无条目')
        : `<ul class="blist">${b.items
            .map(
              (it) => `<li class="${toneClass(it.tone).trim()}">
          <div class="blist-text">${esc(it.text)}${it.tag ? ` <span class="tag">${esc(it.tag)}</span>` : ''}</div>
          ${it.note ? `<div class="blist-note">${esc(it.note)}</div>` : ''}
        </li>`,
            )
            .join('')}</ul>`,
    ),

  table: (b) =>
    card(
      b.title,
      // Wrapped so a wide table scrolls sideways on a phone instead of
      // stretching the whole page.
      `<div class="tscroll"><table class="btable">
        <thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${
          b.rows.length === 0
            ? `<tr><td colspan="${b.columns.length}" class="muted">（暂无数据）</td></tr>`
            : b.rows
                .map((row) => `<tr>${b.columns.map((_, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`)
                .join('')
        }</tbody>
      </table></div>`,
    ),

  progress: (b) =>
    card(
      b.title,
      b.items.length === 0
        ? empty('暂无进度')
        : `<div class="bars">${b.items
            .map((it) => {
              const pct = it.max > 0 ? Math.min(Math.max((it.value / it.max) * 100, 0), 100) : 0
              return `<div class="prog${toneClass(it.tone)}">
          <div class="prog-head"><span>${esc(it.label)}</span><span class="num">${esc(
            it.note ?? `${Math.round(pct)}%`,
          )}</span></div>
          <div class="prog-track"><div class="prog-fill" style="width:${pct.toFixed(2)}%"></div></div>
        </div>`
            })
            .join('')}</div>`,
    ),

  bars: (b) => {
    const values = b.items.map((it) => it.value).filter((v) => typeof v === 'number')
    const peak = Math.max(1, ...values.map((v) => Math.abs(v)))
    return card(
      b.title,
      b.items.length === 0
        ? empty('暂无数据')
        : `<div class="chart">${b.items
            .map((it) => {
              const known = typeof it.value === 'number'
              const height = known ? Math.max((Math.abs(it.value) / peak) * 100, 2) : 2
              const sign = !known ? 'none' : it.value >= 0 ? 'up' : 'down'
              return `<div class="chart-col" title="${esc(it.note ?? it.label)}">
            <div class="chart-bar ${sign}" style="height:${height.toFixed(1)}%"></div>
            <div class="chart-val">${known ? esc(it.value) : '—'}</div>
            <div class="chart-label">${esc(it.label)}</div>
          </div>`
            })
            .join('')}</div>`,
    )
  },

  pie: (b) => {
    const total = b.items.reduce((sum, it) => sum + it.value, 0)
    if (b.items.length === 0 || total <= 0) return card(b.title, empty('暂无配比'))
    const palette = ['#4a7cf7', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']
    let acc = 0
    const stops = b.items.map((it, i) => {
      const start = acc
      acc += (it.value / total) * 100
      return `${palette[i % palette.length]} ${start.toFixed(2)}% ${acc.toFixed(2)}%`
    })
    return card(
      b.title,
      `<div class="pie-wrap">
        <div class="pie" style="background:conic-gradient(${stops.join(',')})"></div>
        <ul class="legend">${b.items
          .map(
            (it, i) => `<li>
            <span class="swatch" style="background:${palette[i % palette.length]}"></span>
            ${esc(it.label)}<span class="num">${((it.value / total) * 100).toFixed(1)}%</span>
          </li>`,
          )
          .join('')}</ul>
      </div>`,
    )
  },

  checklist: (b) =>
    card(
      b.title,
      b.items.length === 0
        ? empty('暂无待办')
        : `<ul class="checks">${b.items
            .map(
              (it) => `<li class="${it.done ? 'done' : ''}">
          <span class="box" aria-hidden="true">${it.done ? '✓' : ''}</span>${esc(it.text)}
        </li>`,
            )
            .join('')}</ul>`,
    ),

  quote: (b) => {
    if (b.items.length === 0) return card(b.title, empty('暂无内容'))
    // Rotates by day so the board is not identical every morning.
    const day = Math.floor(Date.now() / 86_400_000)
    const it = b.items[day % b.items.length]
    return card(
      b.title,
      `<blockquote class="quote">${esc(it.text)}${
        it.source ? `<cite>— ${esc(it.source)}</cite>` : ''
      }</blockquote>`,
    )
  },

  groups: (b) =>
    card(
      b.title,
      b.groups.length === 0
        ? empty('暂无分组')
        : `<div class="groups">${b.groups
            .map(
              (g) => `<div class="group">
          <h3>${esc(g.label)}</h3>
          <ul>${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
        </div>`,
            )
            .join('')}</div>`,
    ),

  note: (b) => card(b.title, `<p class="prose${toneClass(b.tone)}">${esc(b.text)}</p>`),

  // Shown, not hidden. A card that vanishes silently is the worst failure mode:
  // the board looks healthy and the number you came for is simply gone.
  unsupported: (b) =>
    card(b.title ?? '无法显示的内容', `<p class="prose t-bad">${esc(b.reason)}</p>`, ' bcard-bad'),
}

const renderBlock = (block) => {
  const render = renderers[block.type]
  if (render === undefined) return renderers.unsupported({ reason: `未知组件 ${block.type}` })
  try {
    return render(block)
  } catch (error) {
    // A renderer bug must cost one card, not the entire page.
    return renderers.unsupported({ title: block.title, reason: `渲染失败：${error.message}` })
  }
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

const renderTabs = () => {
  if (board.pages.length <= 1) {
    el.tabs.innerHTML = ''
    return
  }
  el.tabs.innerHTML = board.pages
    .map(
      (p) =>
        `<button type="button" class="tab${p.key === activeKey ? ' on' : ''}" data-key="${esc(p.key)}">${esc(
          p.label,
        )}</button>`,
    )
    .join('')
}

const renderProblems = () => {
  if (board.problems.length === 0) return ''
  return `<section class="bcard bcard-bad problems">
    <h2>这些数据 manager 读不了（${board.problems.length}）</h2>
    <div class="bcard-body"><ul class="blist">${board.problems
      .map((p) => `<li><div class="blist-text"><code>${esc(p.file)}</code></div>
        <div class="blist-note">${esc(p.detail)}</div></li>`)
      .join('')}</ul></div>
  </section>`
}

/**
 * Keeps `?page=` on the address bar in step with the open tab.
 *
 * `replaceState`, not `pushState`: flipping between tabs is not navigation, and
 * making it so would mean the back button walks through every tab you glanced at
 * before it leaves the board.
 */
const syncUrl = () => {
  const url = new URL(window.location.href)
  if (url.searchParams.get('page') === activeKey) return
  url.searchParams.set('page', activeKey)
  window.history.replaceState(null, '', url)
}

const renderPage = () => {
  const page = board.pages.find((p) => p.key === activeKey) ?? board.pages[0]
  if (page === undefined) {
    el.main.innerHTML = renderProblems() + emptyBoard()
    return
  }
  activeKey = page.key
  syncUrl()
  renderTabs()
  el.main.innerHTML = renderProblems() + `<div class="blocks">${page.blocks.map(renderBlock).join('')}</div>`
}

const emptyBoard = () => `<div class="blocks"><section class="bcard">
  <h2>大盘还是空的</h2>
  <div class="bcard-body">
    <p class="prose">这个工作区还没有大盘数据。让 agent 更新一次内容，或先执行初始化生成模板：</p>
    <pre class="cmd">npm run init -- ${esc(agentId)}</pre>
  </div>
</section></div>`

const renderError = (message) => {
  el.main.innerHTML = `<div class="blocks"><section class="bcard bcard-bad"><h2>载入失败</h2>
    <div class="bcard-body"><p class="prose t-bad">${esc(message)}</p></div></section></div>`
}

const toast = (text, hold) => {
  el.toast.textContent = text
  el.toast.classList.add('on')
  if (hold !== true) setTimeout(() => el.toast.classList.remove('on'), 2200)
}

const load = async () => {
  let response
  try {
    response = await apiFetch(`/api/board/${encodeURIComponent(agentId)}`, { headers: { accept: 'application/json' } })
  } catch (error) {
    renderError(`连不上 manager：${error.message}`)
    return
  }

  if (response.status === 401) {
    window.location.href = '/login'
    return
  }
  if (!response.ok) {
    renderError(response.status === 404 ? `没有名为 ${agentId} 的 agent` : `服务端返回 ${response.status}`)
    return
  }

  const payload = await response.json()
  board = payload.board
  document.title = `${payload.board.title} · ${payload.agent.name}`
  el.title.textContent = payload.board.title
  el.asOf.textContent = payload.board.asOf ? `更新于 ${payload.board.asOf}` : ''

  if (!payload.initialized) {
    el.tabs.innerHTML = ''
    el.main.innerHTML = emptyBoard()
    return
  }
  renderPage()
}

el.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('.tab')
  if (button === null) return
  activeKey = button.dataset.key
  renderPage()
  el.main.scrollIntoView({ block: 'start' })
})

// ---------------------------------------------------------------------------
// live updates
// ---------------------------------------------------------------------------

// Same connection discipline as the conversation page: HTTP/1.1 gives the whole
// origin six connections, and a stream that outlives the page you left holds one
// of them forever. Six such leaks and every later request -- including the next
// navigation's HTML -- queues behind a socket that never frees.
let source = null
let retryTimer = null
let retryDelay = 3000

const disconnect = () => {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (source !== null) {
    source.close()
    source = null
  }
}

const connect = () => {
  disconnect()
  const es = new EventSource(`/api/board/${encodeURIComponent(agentId)}/events`)
  source = es

  es.addEventListener('message', (event) => {
    let payload
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    if (payload?.kind !== 'changed') return
    toast('数据已更新')
    // Re-fetch rather than reload: the open tab and the scroll position survive.
    void load()
  })

  es.addEventListener('open', () => {
    retryDelay = 3000
  })

  es.addEventListener('error', () => {
    // `es`, not `source`: closing whichever instance happens to be current would
    // leave the failed one retrying by itself, leaking a connection each time.
    es.close()
    if (es !== source) return
    source = null
    // EventSource retries by itself, but not once the server closes the stream
    // outright (a manager restart), so reconnect with a backoff.
    retryTimer = setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30_000)
  })
}

// A phone that has been in a pocket comes back with stale numbers and a dead
// socket. Refresh on return rather than waiting for the next change, and hold no
// connection while away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void load()
    connect()
  } else {
    disconnect()
  }
})

window.addEventListener('pagehide', disconnect)

void load()
connect()
