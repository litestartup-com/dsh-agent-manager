// Plain fetch + DOM, matching the rest of the front end: no build step.

import { $, esc } from './ui.js'

const MICRO = 1_000_000

/**
 * Money, with enough decimals to be useful at this scale.
 *
 * Deliberately not ui.js's money(): that one is fixed at four decimals for
 * per-run figures, which would render a month's total as "$12.3400".
 *
 * A run costs fractions of a cent, so the usual two decimals would render a
 * whole day of work as "$0.00" and make the page look broken.
 */
const money = (micro) => {
  const usd = micro / MICRO
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

const tokens = (n) => {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** `"01:00"` UTC rendered in the viewer's own timezone, which is how they schedule. */
const utcToLocal = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setUTCHours(h, m, 0, 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * The total is a floor whenever some rows had no configured rate.
 *
 * Showing a bare number in that case would be a quiet lie: the runs happened
 * and cost real money, manager just cannot say how much. So the figure gets a
 * `≥` and the models responsible are named, which is also the fix.
 */
const renderTotals = (data) => {
  const t = data.totals
  const gap = t.unpriced > 0

  $('total-cost').textContent = `${gap ? '≥ ' : ''}${money(t.costMicroUsd)}`
  $('total-note').textContent = gap
    ? `另有 ${t.unpriced} 条记录的模型未配置单价，未计入`
    : t.runs === 0
      ? '本月还没有运行'
      : ''

  const share = t.costMicroUsd > 0 ? Math.round((t.peakCostMicroUsd / t.costMicroUsd) * 100) : 0
  $('peak-share').textContent = t.costMicroUsd > 0 ? `${share}%` : '—'
  const windows = (data.peakWindowsUtc ?? [])
    .map((w) => `${utcToLocal(w.start)}–${utcToLocal(w.end)}`)
    .join('、')
  $('peak-note').textContent =
    windows === ''
      ? '未配置峰时窗口'
      : share > 0
        ? `峰时单价翻倍 · 本地 ${windows}`
        : `全部在谷时 · 峰时为本地 ${windows}`

  $('total-tokens').textContent = `${tokens(t.inputTokens)} / ${tokens(t.outputTokens)}`
  $('runs-note').textContent = `输入 / 输出 · 共 ${t.runs} 次运行`
}

const renderChart = (days) => {
  const el = $('chart')
  if (days.length === 0) {
    el.innerHTML = '<span class="chart-empty">本月还没有记录</span>'
    return
  }
  const max = Math.max(...days.map((d) => d.costMicroUsd), 1)
  el.innerHTML = days
    .map((d) => {
      const height = Math.max((d.costMicroUsd / max) * 100, d.costMicroUsd > 0 ? 2 : 0)
      const peakPart = d.costMicroUsd > 0 ? (d.peakCostMicroUsd / d.costMicroUsd) * height : 0
      const offPart = height - peakPart
      const title = `${d.day} · ${money(d.costMicroUsd)}${d.peakCostMicroUsd > 0 ? `（峰时 ${money(d.peakCostMicroUsd)}）` : ''}${d.unpriced > 0 ? ` · ${d.unpriced} 条未定价` : ''}`
      // An unpriced-only day would otherwise be an invisible gap, as if nothing
      // ran at all. Draw it flat and grey instead.
      const body =
        d.costMicroUsd === 0 && d.unpriced > 0
          ? '<span class="bar-seg none" style="height:3px"></span>'
          : `<span class="bar-seg on" style="height:${peakPart}%"></span><span class="bar-seg off" style="height:${offPart}%"></span>`
      return `<span class="bar" title="${esc(title)}">${body}</span>`
    })
    .join('')
}

const spendRow = (name, sub, entry) => {
  const gap = entry.unpriced > 0
  const figure = gap && entry.costMicroUsd === 0 ? '未定价' : `${gap ? '≥ ' : ''}${money(entry.costMicroUsd)}`
  return `
    <div class="row">
      <div class="spend-row">
        <span class="name">
          <strong>${esc(name)}</strong>
          ${sub === '' ? '' : `<span class="muted small">${esc(sub)}</span>`}
        </span>
        <span class="figure ${gap && entry.costMicroUsd === 0 ? 'unknown' : ''}">${esc(figure)}</span>
      </div>
      <div class="muted small">
        ${entry.runs} 次 · ${tokens(entry.inputTokens)} in / ${tokens(entry.outputTokens)} out${
          entry.peakCostMicroUsd > 0 ? ` · 峰时 ${money(entry.peakCostMicroUsd)}` : ''
        }
      </div>
    </div>`
}

const renderAgents = (rows) => {
  $('by-agent').innerHTML =
    rows.length === 0
      ? '<div class="row muted small">本月没有运行</div>'
      : rows.map((r) => spendRow(r.name, r.agentId, r)).join('')
}

const renderModels = (rows) => {
  $('by-model').innerHTML =
    rows.length === 0
      ? '<div class="row muted small">本月没有运行</div>'
      : rows
          .map((r) =>
            spendRow(
              r.model ?? '(未知模型)',
              r.rateConfigured ? (r.provider ?? '') : '单价未配置',
              r,
            ),
          )
          .join('')
}

/**
 * Names the models that need a rate, because that is the actionable part.
 *
 * "Some spend is missing" is not something anyone can fix; "deepseek-v4-pro has
 * no rate in manager.config.yaml" is.
 */
const renderBanners = (data) => {
  const missing = data.byModel.filter((m) => !m.rateConfigured && m.runs > 0)
  $('banners').innerHTML =
    missing.length === 0
      ? ''
      : `<div class="banner warn">
           <strong>有 ${missing.length} 个模型没有配置单价</strong>
           <div class="body">${esc(missing.map((m) => m.model ?? '(未知)').join('、'))} 的运行只记录了 token，没有金额。
              在 <code>manager.config.yaml</code> 的 <code>pricing.models</code> 下补上单价后，
              新的运行就会计费（已有记录不会自动回填）。</div>
         </div>`
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

const load = async (month) => {
  const query = month === null || month === undefined ? '' : `?month=${encodeURIComponent(month)}`
  const res = await fetch(`/api/usage${query}`, { credentials: 'same-origin' })
  if (res.status === 401) {
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    $('banners').innerHTML = `<div class="banner bad"><strong>读取花费失败</strong><div class="body">HTTP ${esc(res.status)}</div></div>`
    return
  }
  const data = await res.json()

  const options = data.months.includes(data.month) ? data.months : [data.month, ...data.months]
  $('month').innerHTML = options
    .map((m) => `<option value="${esc(m)}" ${m === data.month ? 'selected' : ''}>${esc(m)}</option>`)
    .join('')

  renderBanners(data)
  renderTotals(data)
  renderChart(data.byDay)
  renderAgents(data.byAgent)
  renderModels(data.byModel)
}

$('month').addEventListener('change', (event) => {
  void load(event.target.value)
})

void load(null)
