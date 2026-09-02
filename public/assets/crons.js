import { $, bannerHtml, esc } from './ui.js'

/** Whole cents: this is a budget ceiling, not a per-run figure. */
const money = (micro) => `$${(micro / 1e6).toFixed(2)}`

/** Shorter than ui.js's when(): these are schedule times, always this year. */
const when = (ms) => {
  if (ms === null || ms === undefined) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Beijing hours billed at the peak rate, derived from the UTC windows in
 * manager.config.yaml (01:00-04:00 and 06:00-10:00 UTC).
 */
const PEAK_HOURS_BEIJING = [9, 10, 11, 14, 15, 16, 17]

/**
 * Warns when a schedule fires during peak pricing, at the moment it is being
 * written.
 *
 * Peak is exactly double, and a schedule set once runs for months -- so a
 * careless 15:30 is not a one-off mistake, it is a standing 2x surcharge nobody
 * will revisit. The hour is the only thing worth checking and the only thing
 * cheap to check.
 *
 * Deliberately silent rather than guessing when it cannot be sure: a `*` or
 * stepped hour field, or any timezone other than the one the windows were
 * derived for. A wrong warning here would teach you to ignore the right one.
 */
const peakWarning = (schedule, timezone) => {
  if (timezone !== 'Asia/Shanghai') return null
  const fields = schedule.trim().split(/\s+/)
  if (fields.length < 5) return null
  const hourField = fields[1]
  if (!/^\d+(,\d+)*$/.test(hourField)) return null
  const hits = hourField
    .split(',')
    .map(Number)
    .filter((h) => PEAK_HOURS_BEIJING.includes(h))
  if (hits.length === 0) return null
  return (
    `${hits.map((h) => `${h}:00`).join('、')} 落在峰时，单价是谷时的两倍。` +
    '峰时为北京时间 09:00–12:00 和 14:00–18:00；挪出这两段即可省一半。'
  )
}

const STATE_LABEL = { done: '成功', failed: '失败', missed: '没跑' }
const STATE_DOT = { done: 'ok', failed: 'bad', missed: 'warn' }

let agents = []
let crons = []
/** Overwritten from /api/crons so the UI quotes the configured ceiling. */
let maxFailures = 3

// --- rendering ---------------------------------------------------------------

const cronCard = (c) => {
  const dot = c.enabled ? (STATE_DOT[c.lastState] ?? '') : ''
  const rows = []

  if (c.problem !== null) {
    // Not schedulable at all. Loudest state on the page, because the row looks
    // perfectly healthy otherwise and simply never fires.
    rows.push(
      `<div class="cron-note bad"><strong>无法调度</strong>${esc(c.problem)}。改一下时间表，它现在不会运行。</div>`,
    )
  }
  if (c.disabledReason !== null) {
    // The one thing that must not be ambiguous: this was not your doing.
    rows.push(`<div class="cron-note bad"><strong>被系统自动停用</strong>${esc(c.disabledReason)}</div>`)
  } else if (!c.enabled) {
    rows.push(`<div class="cron-note muted">你把它关了。打开后会按时间表继续。</div>`)
  }
  if (c.enabled && c.lastState === 'failed' && c.lastError !== null) {
    rows.push(
      `<div class="cron-note warn"><strong>上次失败（${c.consecutiveFailures}/${maxFailures}）</strong>${esc(c.lastError)}</div>`,
    )
  }
  if (c.enabled && c.lastState === 'missed' && c.lastError !== null) {
    rows.push(`<div class="cron-note warn"><strong>上次没跑</strong>${esc(c.lastError)}</div>`)
  }
  const peak = peakWarning(c.schedule, c.timezone)
  if (peak !== null && c.enabled) {
    rows.push(`<div class="cron-note warn"><strong>在峰时运行</strong>${esc(peak)}</div>`)
  }

  return `<div class="card cron-card${c.enabled ? '' : ' off'}">
    <div class="cron-head">
      <div class="cron-title">
        <span class="dot ${dot}"></span>
        <strong>${esc(c.name)}</strong>
        <span class="muted small">${esc(c.agentName)}</span>
      </div>
      <div class="cron-actions">
        <button class="btn-quiet btn-sm" data-act="run" data-id="${esc(c.id)}" title="立即跑一次">
          <svg width="14" height="14"><use href="#i-play" /></svg>
        </button>
        <button class="btn-quiet btn-sm" data-act="edit" data-id="${esc(c.id)}">改</button>
        <button class="btn-quiet btn-sm" data-act="toggle" data-id="${esc(c.id)}">${c.enabled ? '停用' : '启用'}</button>
        <button class="btn-quiet btn-sm danger" data-act="delete" data-id="${esc(c.id)}">删除</button>
      </div>
    </div>
    <div class="cron-meta muted small">
      <code>${esc(c.schedule)}</code>
      <span>${esc(c.timezone)}</span>
      <span>下次 ${esc(c.enabled ? when(c.nextRunAt) : '—')}</span>
      <span>上次 ${esc(when(c.lastRunAt))}${c.lastState ? ` · ${esc(STATE_LABEL[c.lastState] ?? c.lastState)}` : ''}</span>
    </div>
    <div class="cron-prompt">${esc(c.prompt)}</div>
    ${rows.join('')}
    <div class="cron-result" id="result-${esc(c.id)}"></div>
  </div>`
}

const emptyList = `<div class="empty"><strong>还没有定时任务</strong>点右上角新建一个，它会按时间自己跑</div>`

const render = () => {
  $('list').innerHTML = crons.length === 0 ? emptyList : crons.map(cronCard).join('')
}

// --- loading -----------------------------------------------------------------

const load = async () => {
  const [cronRes, statusRes] = await Promise.all([fetch('/api/crons'), fetch('/api/status')])
  if (!cronRes.ok) {
    $('banners').innerHTML = bannerHtml({ level: 'bad', title: '读取失败', body: `HTTP ${cronRes.status}` })
    return
  }
  const data = await cronRes.json()
  crons = data.crons
  maxFailures = data.maxConsecutiveFailures

  if (statusRes.ok) {
    const status = await statusRes.json()
    agents = status.agents ?? []
  }
  const sel = $('f-agent')
  sel.innerHTML = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')

  // The budget is the only thing standing between a schedule and an open tab on
  // your account, so its absence is stated rather than left blank.
  $('budget-note').innerHTML =
    data.dailyBudgetMicroUsd === null
      ? '没有设置日预算 · 连续失败会自动停用，但「一直成功但很贵」不会被拦住'
      : `日预算 ${esc(money(data.dailyBudgetMicroUsd))} · 超出后定时任务停到明天，手动运行不受限`
  render()
}

// --- editor ------------------------------------------------------------------

const PRESETS = [
  { label: '每天 8:00', value: '0 8 * * *' },
  { label: '每周一 8:00', value: '0 8 * * 1' },
  { label: '每月 1 号 8:00', value: '0 8 1 * *' },
  { label: '每天 20:30', value: '30 20 * * *' },
]

$('preset-hints').innerHTML = PRESETS.map(
  (p) => `<button type="button" class="chip" data-preset="${esc(p.value)}">${esc(p.label)}</button>`,
).join('')

const openEditor = (cron) => {
  $('f-id').value = cron?.id ?? ''
  $('f-name').value = cron?.name ?? ''
  $('f-schedule').value = cron?.schedule ?? '0 8 * * *'
  $('f-timezone').value = cron?.timezone ?? 'Asia/Shanghai'
  $('f-prompt').value = cron?.prompt ?? ''
  if (cron !== null && cron !== undefined) $('f-agent').value = cron.agentId
  $('f-save').textContent = cron ? '保存' : '创建'
  $('editor').hidden = false
  refreshWarn()
  $('f-name').focus()
}

const closeEditor = () => {
  $('editor').hidden = true
  $('f-warn').innerHTML = ''
}

const refreshWarn = () => {
  const peak = peakWarning($('f-schedule').value, $('f-timezone').value)
  $('f-warn').innerHTML =
    peak === null ? '' : bannerHtml({ level: 'warn', title: '这个时间落在峰时', body: esc(peak) })
}

$('f-schedule').addEventListener('input', refreshWarn)
$('f-timezone').addEventListener('input', refreshWarn)
$('new-cron').addEventListener('click', () => openEditor(null))
$('f-cancel').addEventListener('click', closeEditor)

$('preset-hints').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-preset]')
  if (chip === null) return
  $('f-schedule').value = chip.dataset.preset
  refreshWarn()
})

$('cron-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const id = $('f-id').value
  const body = {
    name: $('f-name').value.trim(),
    schedule: $('f-schedule').value.trim(),
    timezone: $('f-timezone').value.trim(),
    prompt: $('f-prompt').value.trim(),
  }
  if (body.name === '' || body.schedule === '' || body.prompt === '') {
    $('f-warn').innerHTML = bannerHtml({ level: 'bad', title: '还差点东西', body: '名称、时间表、指令都要填' })
    return
  }
  $('f-save').disabled = true
  try {
    const response =
      id === ''
        ? await fetch('/api/crons', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agentId: $('f-agent').value, ...body }),
          })
        : await fetch(`/api/crons/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      $('f-warn').innerHTML = bannerHtml({
        level: 'bad',
        title: '没保存成功',
        body: esc(String(err.detail ?? err.error ?? response.status)),
      })
      return
    }
    closeEditor()
    await load()
  } finally {
    $('f-save').disabled = false
  }
})

// --- row actions -------------------------------------------------------------

$('list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]')
  if (button === null) return
  const { act, id } = button.dataset
  const cron = crons.find((c) => c.id === id)
  if (cron === undefined) return

  if (act === 'edit') {
    openEditor(cron)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }

  if (act === 'toggle') {
    await fetch(`/api/crons/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !cron.enabled }),
    })
    await load()
    return
  }

  if (act === 'delete') {
    // The prompt is the thing worth losing, so it is named in the question.
    if (!window.confirm(`删除「${cron.name}」？运行记录和花费会保留，只是不再自动运行。`)) return
    await fetch(`/api/crons/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
    return
  }

  if (act === 'run') {
    const box = $(`result-${id}`)
    button.disabled = true
    box.innerHTML = '<span class="muted small">正在跑，可能要几分钟…</span>'
    try {
      const response = await fetch(`/api/crons/${encodeURIComponent(id)}/run`, { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        box.innerHTML = bannerHtml({ level: 'bad', title: '没跑起来', body: esc(String(result.error ?? response.status)) })
      } else if (result.ran && result.state === 'done') {
        box.innerHTML = bannerHtml({ level: 'ok', title: '跑完了', body: '结果在任务记录里' })
      } else {
        box.innerHTML = bannerHtml({
          level: 'bad',
          title: result.ran ? '跑了但失败了' : '没有运行',
          body: esc(String(result.message ?? '未知原因')),
        })
      }
    } finally {
      button.disabled = false
      await load()
    }
  }
})

void load()
