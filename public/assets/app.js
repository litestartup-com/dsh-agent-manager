// The home page: the composer, the recent-run list and the endpoint panel.
//
// Plain fetch + DOM. No build step, no framework -- this is pure rendering, so a
// framework would only add tooling with nothing in return.
//
// The sidebar used to live here too. It now lives in shell.js, because it is on
// every page and this file is not.

import { $, bannerHtml as rawBanner, esc, icon, money, setHtml, when } from './ui.js'

// ---------------------------------------------------------------------------
// 蜂群 P3：/app 直通主脑。
//
// 主脑是日常入口，首页的派活 composer 退居次席。配置里有 brain agent
// 时，/app 直接跳到主脑最近一次会话（没有才新建）；没有主脑就保留原
// 来的首页。异步执行：跳转完成前用户看到的是完整首页，而不是白屏。
// ---------------------------------------------------------------------------
void (async () => {
  try {
    const response = await fetch('/api/chats')
    if (!response.ok) return
    const { agents } = await response.json()
    const brain = agents.find((a) => a.id === 'brain')
    if (brain === undefined) return
    const latest = brain.chats?.[0]
    if (latest !== undefined) {
      window.location.replace(`/chat/${encodeURIComponent(latest.id)}`)
      return
    }
    const created = await fetch('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'brain' }),
    })
    if (!created.ok) return
    const { chat } = await created.json()
    window.location.replace(`/chat/${encodeURIComponent(chat.id)}`)
  } catch {
    // 网络失败就当没有主脑，首页照常渲染。
  }
})()

// Deliberately NOT `import { currentStatus } from './shell.js'`: that import
// resolves to a URL without the ?v= stamp, so the browser loaded shell.js a
// second time as a separate module. Every sidebar listener existed twice, and
// each click on the collapse button toggled the rail twice -- a perfect undo.
// The status rides the `shell:status` event plus the window global instead,
// and shell.js stays a single module per page.

// Every banner on this page carries plain text, so it is escaped here rather
// than at each of the seven call sites -- one of which would eventually be
// missed. Pages that need markup in a banner use rawBanner directly.
const bannerHtml = (b) => rawBanner({ ...b, body: esc(b.body) })

// ---------------------------------------------------------------------------
// warnings
// ---------------------------------------------------------------------------

/**
 * Problems worth interrupting for, as banners at the top of the page.
 *
 * These used to be a clause inside a 12px grey line under an endpoint row. "The
 * gateway is not checking its API key" means anything that can reach the port
 * can drive an agent that writes to your files -- that is not a detail to be
 * read past.
 */
const banners = (status) => {
  const out = []

  for (const ep of status.endpoints) {
    if (!ep.reachable) {
      out.push({
        level: 'bad',
        title: `连不上 DSH 端点 ${ep.id}`,
        body: `${ep.url} — ${ep.error ?? '未知错误'}。这个端点下的 agent 都没法干活。`,
      })
      continue
    }
    if (ep.apiKeySet === false) {
      out.push({
        level: 'bad',
        title: `端点 ${ep.id} 的网关没有校验密钥`,
        body: 'gateway 的 apiKeys 是空的，所以它接受任何请求。任何能访问到这个端口的程序都能创建会话并改写你的工作区。请在 gateway 配置里补上 apiKeys。',
      })
    }
    if (ep.enabled === false) {
      out.push({ level: 'warn', title: `端点 ${ep.id} 已停用`, body: '网关明确关闭了转发，派活会失败。' })
    }
  }

  // Boot-time configuration warnings, e.g. several agents sharing one DSH
  // process and therefore one sandbox root.
  for (const text of status.warnings ?? []) {
    out.push({ level: 'warn', title: '配置需要注意', body: text })
  }

  // "This agent is externally callable" is deliberately not a banner. It is a
  // standing fact rather than a problem, it is already shown on the agent row
  // and on the composer, and manager refuses to boot when a public agent shares
  // an endpoint with a private one -- so a banner would be advising something
  // that is already enforced. Permanent un-actionable banners only teach people
  // to ignore the real ones.
  return out
}

// Endpoint health and session counts now live in the sidebar (shell.js) as one
// quiet line each -- standing facts, not home-page furniture. The banners above
// still surface the problems that genuinely need a human right now.

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

const STATE = {
  done: { label: '完成', badge: 'ok', dot: 'ok' },
  failed: { label: '失败', badge: 'bad', dot: 'bad' },
  running: { label: '进行中', badge: 'warn', dot: 'warn' },
  pending: { label: '排队中', badge: '', dot: '' },
  missed: { label: '已错过', badge: 'warn', dot: 'warn' },
}

const TRIGGER_LABEL = { manual: '手动', cron: '定时', api: '接口', capture: '口述' }

const duration = (run) => {
  if (run.endedAt === null) return '进行中'
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

const tokens = (usage) => {
  if (!usage) return '未报告用量'
  const parts = [`入 ${usage.inputTokens}`, `出 ${usage.outputTokens}`]
  if (usage.cacheRead) parts.push(`缓存 ${usage.cacheRead}`)
  return `${parts.join(' · ')} · ${money(usage.cost)}`
}

/**
 * The commit a run produced, or nothing when it changed no files.
 *
 * Worth showing on every row: it is the difference between "the agent said it
 * updated my notes" and "here is the commit that proves it".
 */
const commitTag = (run) =>
  run.commitHash ? `<code class="commit" title="${esc(run.commitHash)}">${esc(run.commitHash.slice(0, 8))}</code>` : ''

const runRow = (run) => {
  const state = STATE[run.state] ?? { label: run.state, badge: '', dot: '' }
  const detail =
    run.state === 'failed' && run.error !== null
      ? `<div class="detail error">${esc(run.error)}</div>`
      : run.resultSummary
        ? `<div class="detail">${esc(run.resultSummary.slice(0, 200))}</div>`
        : ''
  return `<div class="row">
    <div class="row-main">
      <div class="row-title">
        <span class="dot ${state.dot}"></span>
        <strong>${esc(state.label)}</strong>
        <span class="muted small">${esc(TRIGGER_LABEL[run.trigger] ?? run.trigger)} · ${esc(when(run.startedAt))} · ${esc(duration(run))}</span>
      </div>
      <span class="muted small">${commitTag(run)}${esc(tokens(run.usage))}</span>
    </div>
    ${detail}
  </div>`
}

/** What the run actually did to the workspace, with the commit that holds it. */
const changedFilesHtml = (outcome) => {
  const files = outcome.changedFiles ?? []
  if (files.length === 0) return `<div class="muted small">没有改动任何文件</div>`
  const shown = files.slice(0, 8)
  const rest = files.length - shown.length
  return `<div class="muted small">
    改了 ${files.length} 个文件${outcome.commit ? ` · <code class="commit">${esc(outcome.commit.slice(0, 8))}</code>` : ''}
    <div class="files">${shown.map((f) => `<code>${esc(f)}</code>`).join('')}${rest > 0 ? `<span>…还有 ${rest} 个</span>` : ''}</div>
  </div>`
}

/**
 * Says so when the changes were not committed.
 *
 * The composer above promises "每次改动都会自动提交". When that could not happen
 * -- the workspace is not a repo, or git has no identity configured -- staying
 * quiet would leave a promise on screen that the run just broke.
 */
const snapshotWarningHtml = (outcome) =>
  outcome.snapshotSkipped
    ? bannerHtml({
        level: 'warn',
        title: '这次的改动没有被提交',
        body: `${outcome.snapshotSkipped}。文件已经写在工作区里，但没有版本记录，回退不了。`,
      })
    : ''

const emptyRuns = `<div class="empty"><strong>还没有任务</strong>在上面写一句话，交给某个 agent 试试</div>`

let agentIds = []

const loadRuns = async () => {
  if (agentIds.length === 0) {
    setHtml('runs', emptyRuns)
    return
  }
  try {
    const lists = await Promise.all(
      agentIds.map((id) =>
        fetch(`/api/agents/${encodeURIComponent(id)}/runs?limit=10`).then((r) => (r.ok ? r.json() : { runs: [] })),
      ),
    )
    const runs = lists
      .flatMap((l) => l.runs)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 10)
    setHtml('runs', runs.length === 0 ? emptyRuns : runs.map(runRow).join(''))
  } catch {
    setHtml('runs', '<p class="error">读取任务记录失败</p>')
  }
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/** Describes the write boundary of the currently selected agent. */
const updateScopePill = (agents) => {
  const agent = agents.find((a) => a.id === $('run-agent').value)
  const pill = $('run-scope')
  const identity = $('run-identity')
  if (agent === undefined) {
    pill.hidden = true
    if (identity !== null) identity.hidden = true
    return
  }
  pill.hidden = false
  pill.className = `pill ${agent.public ? 'warn' : ''}`
  pill.textContent = agent.public ? '对外可调用 · 只写自己的工作区' : '只写自己的工作区'
  pill.title = agent.workspacePath
  if (identity !== null) {
    identity.hidden = false
    $('run-who').textContent = `发送给 ${agent.name}`
    $('run-path').textContent = agent.workspacePath
    identity.title = agent.workspacePath
  }
}

// ---------------------------------------------------------------------------
// suggestions + quick actions
// ---------------------------------------------------------------------------

/**
 * Ways to use the composer, as tappable cards. Deliberately static and honest:
 * three prompts that are always useful, rather than a model guessing at what
 * you might want tonight. Dismissed for good via the × (remembered locally).
 */
const SUGGEST_KEY = 'manager.home.suggestions.off'
const SUGGESTIONS = [
  { icon: 'chat', name: '记一条工作日志', prompt: '在日志里记一条：今天做了什么，有什么结果。' },
  { icon: 'folder', name: '写本周周报', prompt: '把这周的工作整理成一份周报，写进工作区。' },
  { icon: 'board', name: '更新大盘', prompt: '把最近的进展同步进大盘，更新对应的 board 页。' },
]

const suggestionsOff = () => {
  try {
    return window.localStorage.getItem(SUGGEST_KEY) === '1'
  } catch {
    return false
  }
}

const renderSuggestions = (agents) => {
  const box = $('suggest')
  if (box === null) return
  // No agent, or the user closed them once, and the row goes away entirely.
  if (agents.length === 0 || suggestionsOff()) {
    box.hidden = true
    return
  }
  box.hidden = false
  const target = agents[0]
  setHtml(
    'suggest-grid',
    SUGGESTIONS.map(
      (s) => `<button class="suggest-card" type="button" data-prompt="${esc(s.prompt)}" data-agent="${esc(target.id)}">
        <span class="suggest-icon">${icon(s.icon, 16)}</span>
        <span class="suggest-text">
          <span class="suggest-name">${esc(s.name)}</span>
          <span class="suggest-sub">交给 ${esc(target.name)}</span>
        </span>
      </button>`,
    ).join(''),
  )
}

const renderQuickBoard = (agents) => {
  const link = $('quick-board')
  if (link === null) return
  if (agents.length === 0) {
    link.hidden = true
    return
  }
  link.hidden = false
  link.href = `/board/${encodeURIComponent(agents[0].id)}`
}

let knownAgents = []

/**
 * Renders whatever the shell just fetched.
 *
 * The shell polls /api/status for the agent list anyway. Fetching it again here
 * would double the request rate for identical bytes, and let the sidebar and the
 * composer disagree about which agents exist for up to 15 seconds.
 */
const render = async (status) => {
  knownAgents = status.agents

  setHtml('banners', banners(status).map(bannerHtml).join(''))

  const ids = status.agents.map((a) => a.id)
  // Only rebuild when the set changed, so polling never resets your choice.
  if (ids.join(',') !== agentIds.join(',')) {
    agentIds = ids
    $('run-agent').innerHTML = status.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')
  }
  updateScopePill(status.agents)
  renderSuggestions(status.agents)
  renderQuickBoard(status.agents)
  await loadRuns()
}

// Suggestions are a preference at the frame's level, not the agent's: closing
// them once closes them everywhere.
$('suggest-hide').addEventListener('click', () => {
  try {
    window.localStorage.setItem(SUGGEST_KEY, '1')
  } catch {
    // Private-mode storage failures are not worth a visible error.
  }
  $('suggest').hidden = true
})

$('suggest-grid').addEventListener('click', (event) => {
  const card = event.target.closest('.suggest-card')
  if (card === null) return
  $('run-agent').value = card.dataset.agent
  updateScopePill(knownAgents)
  promptBox.value = card.dataset.prompt
  autosize()
  promptBox.focus()
})

window.addEventListener('shell:status', (event) => void render(event.detail))

// The shell may have finished its first fetch before this module ran, in which
// case the event has already been and gone -- the window global holds the
// latest status either way.
const initial = window.__shellLastStatus ?? null
if (initial !== null) void render(initial)

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------

// Named `promptBox`, not `prompt`, so it does not shadow window.prompt.
const promptBox = $('run-prompt')

// Grows with the text instead of scrolling inside two rows.
const autosize = () => {
  promptBox.style.height = 'auto'
  promptBox.style.height = `${promptBox.scrollHeight}px`
}
promptBox.addEventListener('input', autosize)

// Enter sends, Shift+Enter makes a new line -- the same contract as DSH's own
// composer, so the muscle memory carries over.
promptBox.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return
  // Committing a Chinese IME candidate is also an Enter. `isComposing` covers
  // most browsers; keyCode 229 is the fallback for the Android IMEs that leave
  // it false and would otherwise send a half-typed sentence.
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  $('run-form').requestSubmit()
})

$('run-agent').addEventListener('change', () => updateScopePill(knownAgents))

// The sidebar's 派活 is a link to /app#new, so it works from every page. Here we
// are already on /app, so navigating would reload for nothing.
$('new-task').addEventListener('click', (event) => {
  event.preventDefault()
  promptBox.focus()
  promptBox.scrollIntoView({ block: 'center', behavior: 'smooth' })
})

// Arriving from another page via that link.
if (window.location.hash === '#new') {
  promptBox.focus()
  promptBox.scrollIntoView({ block: 'center' })
}

$('run-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const agentId = $('run-agent').value
  const text = promptBox.value.trim()
  if (agentId === '' || text === '') return

  const submit = $('run-submit')
  const state = $('run-state')
  const result = $('run-result')

  submit.disabled = true
  // A turn can take minutes, so say so rather than looking frozen.
  state.textContent = '正在干活，可能要几分钟…'
  result.innerHTML = ''

  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
    })
    const body = await response.json().catch(() => null)

    if (response.status === 409) {
      result.innerHTML = bannerHtml({
        level: 'warn',
        title: body?.detail ?? '这个 agent 正忙',
        body: '等它做完再派活。一个 agent 同时只接一个任务。',
      })
    } else if (!response.ok) {
      result.innerHTML = bannerHtml({ level: 'bad', title: '派活失败', body: String(body?.detail ?? response.status) })
    } else if (body.state === 'done') {
      result.innerHTML = `<div class="card">
        <div class="row-main">
          <div class="row-title"><span class="dot ok"></span><strong>做完了</strong></div>
          <span class="muted small">${esc(tokens(body.usage === null ? null : { ...body.usage, cost: body.costMicroUsd }))}</span>
        </div>
        <div class="detail">${esc(body.summary || '（没有输出文字）')}</div>
        ${changedFilesHtml(body)}
      </div>${snapshotWarningHtml(body)}`
      promptBox.value = ''
      autosize()
    } else {
      // A failed turn may still have written files, and those are committed too,
      // so the same footer belongs here.
      result.innerHTML =
        bannerHtml({ level: 'bad', title: '没做成', body: String(body.error ?? '未知原因') }) +
        (body.commit ? `<div class="card">${changedFilesHtml(body)}</div>` : '') +
        snapshotWarningHtml(body)
    }
  } catch (error) {
    result.innerHTML = bannerHtml({ level: 'bad', title: '请求中断', body: error.message })
  } finally {
    submit.disabled = false
    state.textContent = ''
    await loadRuns()
  }
})

// Logout, the spend hint and the cron hint all now live in shell.js, along with
// the /api/status poll that drives render() above.
