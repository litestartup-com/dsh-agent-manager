// 蜂群 P5.2：技能清单（v1 只读）。
//
// 技能真相源 = 各 agent 工作区的 .skills/<name>/SKILL.md；版本 = 工作区 git
// HEAD（与运行审计同源）。启停/分发是 P5.5 配置写回的事——本页不放假按钮。
import { $, esc, setHtml } from './ui.js'

const versionChip = (v) =>
  v === null ? '<span class="pill-mini muted">无 git 版本</span>' : `<span class="pill-mini">@${esc(v.slice(0, 7))}</span>`

const agentGroup = (a) => {
  const rows =
    a.skills.length === 0
      ? '<p class="muted small">这个 agent 没有自己的技能（.skills/ 为空）——它用的是 DSH preset 自带的标准技能。</p>'
      : a.skills
          .map(
            (s) => `<div class="node-row">
              <div class="node-main">
                <div class="node-title">${esc(s.name)}</div>
                ${s.description !== '' ? `<div class="node-detail">${esc(s.description)}</div>` : ''}
                <div class="node-meta"><code>${esc(s.file)}</code></div>
              </div>
            </div>`,
          )
          .join('')
  return `<div class="skills-agent">
    <div class="skills-agent-head">
      <strong>${esc(a.agentName)}</strong>
      <span class="muted small"><code>${esc(a.workspacePath)}</code></span>
      ${versionChip(a.version)}
    </div>
    <div class="nodes-list">${rows}</div>
  </div>`
}

const load = async () => {
  try {
    const response = await fetch('/api/skills')
    if (!response.ok) return
    const data = await response.json()

    setHtml(
      'repo-note',
      data.repo === null
        ? '<strong>技能仓库未创建。</strong> 约定位置 <code>' +
            esc('~/.dsh-ohdsh/skills') +
            '</code>——将来技能的分发/同步以它为源（git 工作流）。当前技能文件各自留在工作区的 .skills/ 下，改文件即改技能，改动随工作区 git 留痕。'
        : `<strong>技能仓库</strong> <code>${esc(data.repo.path)}</code> ${versionChip(data.repo.version)} · 技能的分发与同步以它为源`,
    )

    setHtml('skills-list', data.agents.map(agentGroup).join(''))
    $('skills-refresh').textContent = `刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  } catch {
    // 保留上一帧
  }
}

void load()
setInterval(() => void load(), 30_000)
