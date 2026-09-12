// 债务 F1:chat.js 拆分第四步——composer 层(发送/停止/排队/模型/权限/上下文渲染)。
//
// 纯函数(modelKey/shortPath/accessOptions/sendPolicy)独立单测;
// makeComposer 工厂注入 el/refs/deps,与 render/wire 层对称。

import { esc, icon, apiFetch } from './ui.js'

/** provider/model 的合成键(与 wire.loadModels 的 choices 键同一拼法)。 */
export const modelKey = (selection) => `${selection.provider}\u0000${selection.model}`

/**
 * Windows 长路径的中间省略：保留盘符开头与尾部（工作区名），掐掉最无信息量
 * 的中段。完整路径始终在 title 里（hover 可见）。
 */
export const shortPath = (path) => {
  const s = String(path ?? '')
  if (s.length <= 52) return s
  return `${s.slice(0, 16)}…${s.slice(-32)}`
}

/** 第三档选项随节点开锁状态变化：开锁 = 可选；未开锁 = 展示但锁定并说明。 */
export const accessOptions = (caps) =>
  caps.fullAccess === true
    ? [
        { value: 'read-only', label: '只读' },
        { value: 'workspace-write', label: '工作区可写' },
        { value: 'danger-full-access', label: '全量访问', danger: true },
      ]
    : [
        { value: 'read-only', label: '只读' },
        { value: 'workspace-write', label: '工作区可写' },
        { value: 'danger-full-access', label: '全量访问 · 节点未开启', danger: true, locked: true },
      ]

/**
 * 发送前置判断(纯函数):空文本/发送中/无状态一律不发。
 * @param {{ text: string; sending: boolean; state: unknown }} input
 * @returns {{ kind: 'ok'; text: string } | { kind: 'empty' | 'busy' | 'no_state' }}
 */
export const sendPolicy = ({ text, sending, state }) => {
  if (sending) return { kind: 'busy' }
  if (state === null) return { kind: 'no_state' }
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  return { kind: 'ok', text: trimmed }
}

// 全量访问的确认文案按部署形态区分（爆炸半径不同，2026-09-11 拍板）。
const FULL_WARNINGS = {
  container: '容器内全量访问：agent 可读写容器内所有文件与工作区挂载。仅在完全信任该 agent 时开启。确定开启？',
  'bare-metal': '整台机器的全量访问：agent 可读写本机所有文件，包括本 manager 的密钥文件（.env）。仅在完全信任该 agent 时开启。确定开启？',
}

/**
 * @param {{
 *   state: { value: any };
 *   queuedItems: { value: any[] };
 *   pendingUserTexts: { value: any[] };
 *   sending: { value: boolean };
 *   turnStartedAt: { value: number | null };
 *   modelChoices: { value: Map<string, any> };
 *   effortSignature: { value: string | null };
 * }} refs
 * @param {{
 *   chatId: string;
 *   el: Record<string, any>;
 *   toast: (text: string) => void;
 *   render: () => void;
 *   reload: () => Promise<any>;
 *   grow: () => void;
 *   dropdownState: Map<any, any>;
 *   setDropdownLabel: (button: any, label: string) => void;
 * }} deps
 */
export const makeComposer = (refs, deps) => {
  const { chatId, el } = deps

  const syncEffort = () => {
    if (el.effort === null) return
    const selection = refs.state.value?.composer?.model
    const choice = selection === null || selection === undefined ? undefined : refs.modelChoices.value.get(modelKey(selection))
    const reasoning = choice?.reasoning
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    const value = selection?.reasoningEffort ?? reasoning?.defaultEffort ?? ''
    const signature = JSON.stringify([modelKey(selection ?? { provider: '', model: '' }), value, efforts])
    if (signature === refs.effortSignature.value) return
    refs.effortSignature.value = signature
    if (efforts.length === 0) {
      el.effort.hidden = true
      return
    }
    el.effort.hidden = false
    const options = [
      { value: '', label: '默认推理' },
      ...efforts.filter((effort) => typeof effort?.id === 'string' && typeof effort?.name === 'string').map((effort) => ({ value: effort.id, label: effort.name })),
    ]
    const entry = deps.dropdownState.get(el.effort)
    if (entry !== undefined) {
      entry.options = options
      entry.value = value
      deps.setDropdownLabel(el.effort, (options.find((o) => o.value === value) ?? options[0]).label)
    }
  }

  const renderContext = (context) => {
    if (el.contextWrap === null || el.context === null) return
    el.contextWrap.hidden = context === null
    if (context === null) {
      if (el.contextPopover !== null) el.contextPopover.hidden = true
      return
    }
    el.context.textContent = `${context.percent}%`
    el.context.style.setProperty('--context-ratio', String(context.percent / 100))
    el.context.title = `上下文约 ${context.usedTokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens`
    el.context.setAttribute('aria-label', el.context.title)
    if (el.contextSummary !== null) el.contextSummary.textContent = `约 ${context.usedTokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens`
    const breakdown = context.breakdown
    if (el.contextBreakdown !== null) {
      el.contextBreakdown.hidden = breakdown === null || breakdown === undefined
      if (breakdown !== null && breakdown !== undefined) {
        el.contextBreakdown.textContent = `系统 ${breakdown.systemTokens.toLocaleString()} · 工具 ${breakdown.toolsTokens.toLocaleString()} · 对话 ${breakdown.messageTokens.toLocaleString()}`
      }
    }
    const total = breakdown === null || breakdown === undefined ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    const widths = total > 0
      ? [breakdown.systemTokens, breakdown.toolsTokens, breakdown.messageTokens].map((value) => `${context.percent * value / total}%`)
      : [`${context.percent}%`, '0%', '0%']
    for (const [node, width] of [[el.contextSystem, widths[0]], [el.contextTools, widths[1]], [el.contextMessages, widths[2]]]) {
      if (node !== null) node.style.width = width
    }
  }

  const syncAccessOptions = () => {
    if (el.access === null) return
    const entry = deps.dropdownState.get(el.access)
    if (entry === undefined) return
    const caps = refs.state.value?.composer?.capabilities ?? {}
    entry.options = accessOptions(caps)
  }

  const renderComposer = () => {
    if (refs.state.value === null) return
    const state = refs.state.value
    // The agent pill carries the name; the full path is one hover away.
    el.agent.textContent = state.agent.name
    el.agent.title = state.agent.workspacePath ?? ''
    el.path.textContent = shortPath(state.agent.workspacePath)
    el.path.title = state.agent.workspacePath ?? ''

    const composer = state.composer ?? { capabilities: {}, model: null, context: null, accessMode: null }
    const capabilities = composer.capabilities ?? {}
    const lost = state.sessionState === 'lost'
    // 会话尚未绑定（还没发过第一条消息）：切权限/选模型服务端必然 409 no_session，
    // 控件直接禁用并说明原因，而不是「点了弹个 409」。
    const fresh = state.sessionState === 'fresh'
    // 蜂群 P5.4：跨会话不再互锁，composer 永不因别的会话而禁用；同会话的
    // 新消息在上一回合跑完前由服务端排队，dock 可见可删。
    const locked = lost || refs.sending.value
    const turnRunning = state.turns.some((t) => t.state === 'running')

    el.input.disabled = lost
    if (el.modes !== null) el.modes.hidden = capabilities.accessMode !== true
    if (el.settings !== null) {
      el.settings.hidden = capabilities.accessMode !== true && capabilities.modelSelection !== true && composer.context === null
    }
    if (el.access !== null) {
      el.access.disabled = lost || fresh || refs.sending.value || turnRunning || capabilities.accessMode !== true
      el.access.title = fresh ? '发送第一条消息后即可切换访问模式' : turnRunning ? '当前回合结束后可切换' : ''
      syncAccessOptions()
      if (composer.accessMode !== null) {
        const entry = deps.dropdownState.get(el.access)
        if (entry !== undefined) {
          entry.value = composer.accessMode
          deps.setDropdownLabel(el.access, composer.accessMode === 'workspace-write' ? '工作区可写' : composer.accessMode === 'danger-full-access' ? '全量访问' : '只读')
        }
      }
    }
    if (el.model !== null) {
      if (el.model.parentElement !== null) el.model.parentElement.hidden = capabilities.modelSelection !== true
      el.model.disabled = lost || fresh || refs.sending.value || turnRunning || capabilities.modelSelection !== true || refs.modelChoices.value.size === 0
      el.model.title = fresh ? '发送第一条消息后即可选择模型' : turnRunning ? '当前回合结束后可切换' : ''
    }
    if (el.effort !== null) el.effort.disabled = lost || refs.sending.value || turnRunning || capabilities.modelSelection !== true
    syncEffort()
    renderContext(composer.context)
    el.send.disabled = locked || el.input.value.trim() === ''
    // 方案 C（2026-09-11）：发送/停止同槽变身——busy 时槽里只有停止方块，
    // 空闲时只有发送箭头，主 CTA 位置永不跳动。排队发送是回合运行中输入非空
    // 才浮现的 ghost 小按钮（P5.4 排队能力保留）。
    const busy = refs.sending.value || turnRunning
    el.send.hidden = busy
    el.stop.hidden = !busy
    el.queue.hidden = !(turnRunning && !lost && el.input.value.trim() !== '')

    el.input.placeholder = lost
      ? '这个会话已无法继续'
      : turnRunning && !refs.sending.value
        ? '正在跑上一回合 · 新消息会自动排队'
        : refs.sending.value
          ? '正在等它回答…'
          : '说点什么…'

    // The hint only names the available interruption gesture beside the input.
    el.hint.textContent = refs.sending.value ? '按 Esc 或点「停止」可以中断' : ''
  }

  const send = async () => {
    const policy = sendPolicy({ text: el.input.value, sending: refs.sending.value, state: refs.state.value })
    if (policy.kind !== 'ok') return
    const text = policy.text

    // Cleared before the request, not after: leaving the text in the box while a
    // turn runs invites a second send, and a second send is a 409.
    el.input.value = ''
    deps.grow()
    refs.sending.value = true
    // Set here rather than on `turn_start`: the gateway can take seconds to send
    // that frame, and those seconds are precisely the ones that feel like a hang.
    refs.turnStartedAt.value = Date.now()
    deps.render()

    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        refs.sending.value = false
        // The text goes back in the box: it was never delivered, and retyping it
        // is the last thing anyone wants after being told the agent was busy.
        el.input.value = text
        deps.grow()
        deps.toast(body.detail ?? `发送失败（${response.status}）`)
        void deps.reload()
        return
      }

      // Read the result first: an accepted turn may need the local bubble (its
      // message can still be missing from the history on the reload below), while
      // a queued one must NOT appear in the log yet — it lives in the dock until
      // its turn actually starts.
      const result = await response.json().catch(() => ({}))
      if (result.queued !== true) refs.pendingUserTexts.value.push({ text, at: Date.now() })
      refs.sending.value = false
      // The turn's own frames drove the transcript; this reload is for the run row
      // and for a title the server may have derived. It is also the fallback when
      // the relay dropped and `turn_done` never arrived.
      await deps.reload()
      if (result.queued === true) {
        deps.toast(`已排队（第 ${result.position} 位），前一个任务完成后自动开始`)
      }
    } catch (error) {
      refs.sending.value = false
      el.input.value = text
      deps.grow()
      deps.toast(`发送失败：${error.message}`)
      deps.render()
    }
  }

  const cancel = async () => {
    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/cancel`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      deps.toast(response.ok ? '已请求停止' : (body.detail ?? '停止失败'))
    } catch (error) {
      deps.toast(`停止失败：${error.message}`)
    }
  }

  const selectModel = async (selection) => {
    if (el.model !== null) el.model.disabled = true
    if (el.effort !== null) el.effort.disabled = true
    try {
      const response = await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(selection),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        deps.toast(body.detail ?? `模型切换失败（${response.status}）`)
        return
      }
      refs.state.value.composer = { ...(refs.state.value.composer ?? {}), model: body.model }
      refs.effortSignature.value = null
      deps.toast('模型已更新，将在下一回合生效')
    } catch (error) {
      deps.toast(`模型切换失败：${error.message}`)
    }
    deps.render()
  }

  const cancelQueued = async (row, action) => {
    const id = row.dataset.id
    const item = refs.queuedItems.value.find((q) => q.id === id)
    if (item === undefined) return
    const index = refs.queuedItems.value.indexOf(item)
    try {
      await apiFetch(`/api/chats/${encodeURIComponent(chatId)}/queued/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
    } catch {
      // The row stays if the server cannot be reached; the user can try again.
      return
    }
    refs.queuedItems.value.splice(index, 1)
    if (action === 'edit') {
      el.input.value = item.text
      deps.grow()
      el.input.focus()
      deps.toast('已撤销，改完再发即可')
    }
    deps.render()
  }

  return { renderComposer, syncAccessOptions, send, cancel, selectModel, cancelQueued, syncEffort, renderContext, FULL_WARNINGS }
}

export const fullAccessWarning = (form) => FULL_WARNINGS[form] ?? FULL_WARNINGS['bare-metal']
