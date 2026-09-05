// The archived conversations page.
//
// Archiving is a soft delete, and a soft delete nobody can see into is
// indistinguishable from a real one. This page is what makes 「归档」 an honest
// word: everything hidden from the sidebar is listed here, with the way back.

import { $, ago, banner, bannerHtml, esc, setHtml, when, apiFetch } from './ui.js'

const notice = (level, title, body) => {
  $('archive-notice').innerHTML = banner(level, title, body)
}

/** Same, for the one notice that carries a link. `body` must be pre-escaped. */
const noticeHtml = (level, title, body) => {
  $('archive-notice').innerHTML = bannerHtml({ level, title, body })
}

const row = (chat) => {
  const title = chat.title === null || chat.title === '' ? '新会话' : chat.title
  const turns = chat.turns > 0 ? `${chat.turns} 轮` : '没有回合'
  // The agent is named on every row: after a few weeks the useful question is
  // not "when" but "whose workspace was this writing to".
  const meta = [esc(chat.agentName), turns, `最后活动 ${esc(ago(chat.lastActiveAt))}`, `归档于 ${esc(when(chat.removedAt))}`]
  return `<div class="arch-row" data-id="${esc(chat.id)}">
      <div class="arch-main">
        <div class="arch-title">${esc(title)}</div>
        <div class="arch-meta">${meta.join(' · ')}</div>
      </div>
      ${
        chat.agentGone
          ? '<span class="pill warn" title="配置里已经没有这个 agent 了，恢复后不会出现在任何 agent 下">agent 已移除</span>'
          : '<button class="btn-quiet btn-sm" type="button" data-restore="1">恢复</button>'
      }
    </div>`
}

const load = async () => {
  try {
    const response = await apiFetch('/api/chats/archived')
    if (!response.ok) {
      notice('bad', '读不到归档列表', `服务端返回 ${response.status}`)
      return
    }
    const { chats } = await response.json()
    $('archive-count').textContent = chats.length === 0 ? '' : `${chats.length} 条`
    setHtml(
      'archive-list',
      chats.length === 0 ? '<p class="muted small">还没有归档过任何会话。</p>' : chats.map(row).join(''),
    )
  } catch (error) {
    notice('bad', '读不到归档列表', error.message)
  }
}

// Delegated: the list is rewritten wholesale after every restore, so per-row
// listeners would be bound to nodes that no longer exist.
$('archive-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-restore]')
  if (button === null) return
  const id = button.closest('.arch-row').dataset.id
  button.disabled = true
  try {
    const response = await apiFetch(`/api/chats/${encodeURIComponent(id)}/restore`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      button.disabled = false
      notice('bad', '恢复失败', body.detail ?? `服务端返回 ${response.status}`)
      return
    }
    // A link rather than a redirect: the session may come back `cold` or `lost`,
    // and opening it is the user's call, not a side effect of tidying up.
    noticeHtml('ok', '已恢复', `<a href="/chat/${encodeURIComponent(id)}">打开这个会话</a>`)
    await load()
  } catch (error) {
    button.disabled = false
    notice('bad', '恢复失败', error.message)
  }
})

void load()
