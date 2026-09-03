// The conversation page.
//
// One reducer builds the transcript, and both the replayed history and the live
// stream go through it. That is deliberate: the two used to be the classic place
// for a UI to disagree with itself, where a turn looks one way while it streams
// and another way after a refresh. Here there is only one way to draw a turn.
//
// The frame contract is the gateway's, relayed verbatim by manager, plus two
// frames manager adds of its own (`user` and `turn_done`). Verified against
// dsh-api-gateway/src/events.ts:
//
//   user        { text }                    (manager's echo; the gateway's own
//                                            copy is dropped server-side so the
//                                            bubble is not drawn twice)
//   turn_start  { turn }
//   chunk       { chunk: { type, text } }   text-delta / reasoning-delta
//   message     { text, reasoning, usage }
//   tool_call   { name, arguments }         arguments is a JSON *string*
//   tool_result { isError, text }
//   turn_end    { turn, reason, detail }
//   turn_done   { runId, state, error }     (manager's)

import { md } from './md.js'
import { $, esc, icon, money } from './ui.js'

const el = {
  notices: $('chat-notices'),
  queueDock: $('queue-dock'),
  delegations: $('chat-delegations'),
  log: $('chat-log'),
  composer: $('chat-composer'),
  identity: $('composer-identity'),
  agent: $('composer-agent'),
  path: $('composer-path'),
  input: $('chat-input'),
  send: $('chat-send'),
  stop: $('chat-stop'),
  hint: $('composer-hint'),
  toast: $('chat-toast'),
}

const segments = window.location.pathname.split('/').filter(Boolean)
const chatId = segments[0] === 'chat' && segments[1] !== undefined ? decodeURIComponent(segments[1]) : null

/** Everything the last GET told us. Null until it answers. */
let state = null

// 本会话排队/刚发送、可能尚未进入 DSH 历史的消息：reload 重建列表时补画。
// 每页只对应一个 chat（chatId 来自 URL），所以页面级状态即可。
let pendingUserTexts = []
// 本会话正在排队的消息（composer 上方的队列 dock，一行一条）。
// turn_queued 帧入队、turn_start 帧出队；刷新页面即重置。
let queuedItems = []
/** Blocks built by the reducer, in transcript order. */
let blocks = []
/** True while a turn we started is still streaming. */
let sending = false
/**
 * When the live turn began, for the elapsed clock. Null when nothing is running.
 *
 * Read back from the run row on load rather than only set on send, so a refresh
 * mid-turn shows the real elapsed time instead of restarting the count -- a clock
 * that resets on F5 is worse than no clock, because it says the wait just began.
 */
let turnStartedAt = null

const toast = (text) => {
  el.toast.textContent = text
  el.toast.classList.add('on')
  setTimeout(() => el.toast.classList.remove('on'), 2600)
}

// ---------------------------------------------------------------------------
// the reducer
// ---------------------------------------------------------------------------

const newAgentBlock = () => ({
  role: 'agent',
  /** Set by `message` frames, which are authoritative. */
  text: '',
  /** Built from `chunk` frames, shown only until a message replaces it. */
  streamed: '',
  streaming: false,
  reasoning: '',
  tools: [],
  usage: null,
  /** turn_end reason, once the turn is over. */
  reason: null,
  error: null,
  runId: null,
  runState: null,
  /**
   * The permission prompt this turn is stopped on, or null.
   *
   * Worth its own field rather than a tool flag: while this is set the turn is
   * not working at all, and the waiting indicator would otherwise keep claiming
   * it is "正在用 write_file" -- the exact reading that makes someone hit refresh
   * on a turn that was never going to move on its own.
   */
  awaiting: null,
})

/**
 * Adds one usage object into another.
 *
 * A turn can emit several `message` frames and each carries its own usage, so
 * the footer has to sum them. `chunk` frames are skipped entirely: their usage
 * is a running total, and counting it would inflate every turn (UI.md §5).
 */
const addUsage = (into, usage) => {
  if (usage === null || usage === undefined) return into
  const base = into ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  return {
    inputTokens: base.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: base.outputTokens + (usage.outputTokens ?? 0),
    reasoningTokens: base.reasoningTokens + (usage.reasoningTokens ?? 0),
  }
}

/**
 * Pulls a file path out of a tool call's arguments.
 *
 * The tool names come from DSH, not from manager or the gateway -- neither repo
 * declares them -- so this reads the argument shape instead of matching a name
 * list that would silently stop matching after an upstream rename. Several
 * spellings are accepted for the same reason.
 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'filename']

const toolPath = (args) => {
  if (args === null || typeof args !== 'object') return null
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * Whether a tool call changed the workspace.
 *
 * A name heuristic, and knowingly one: the real tool list lives in DSH. It errs
 * towards showing the row, because a write that is not announced is the failure
 * that matters here -- a read shown as a write is merely noise.
 */
const WRITE_HINT = /write|edit|create|save|append|patch|replace|update|insert|move|rename|mkdir|delete|remove/i

const isWrite = (name) => WRITE_HINT.test(name)

const parseArgs = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    // Arguments arrive as a provider-produced string and can be truncated
    // mid-stream. An unparseable one costs the path, not the row.
    return null
  }
}

/**
 * Whether a `user` event is context DSH injected rather than something typed.
 *
 * Two signals, because one is not enough. Verified against a real transcript
 * (`GET /sessions/:id/history`): of five user events in one session, two were
 * wrapped in `<system-reminder>` -- and a third, "Current runtime context. This
 * snapshot supersedes...", carried no marker at all. Matching the tag alone
 * would have folded two thirds of the noise and left the rest.
 *
 * So the second signal is structural: within a turn the user speaks once, and
 * any further user event before the agent answers came from the harness. That
 * survives an upstream change of wording, which a prefix match would not.
 * manager's own live echo is always the first, so it is never folded.
 *
 * Being wrong here is cheap in one direction only: a folded message is one click
 * away, while an unfolded reminder buries the conversation. Hence erring toward
 * folding.
 */
const WRAPPED_REMINDER = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/

const isInjected = (text, previous) => {
  if (WRAPPED_REMINDER.test(text)) return true
  return previous !== undefined && previous.role === 'user'
}

/**
 * Folds one frame into the block list.
 *
 * `open` is the agent block currently being written to. A turn without a
 * `turn_start` still gets one, because the first `chunk` or `message` opens it:
 * the gateway does not promise `turn_start` on a resumed session.
 */
const reduce = (list, frame) => {
  const last = list[list.length - 1]
  const open = last !== undefined && last.role === 'agent' && last.reason === null ? last : null
  const agent = () => {
    if (open !== null) return open
    const created = newAgentBlock()
    list.push(created)
    return created
  }

  switch (frame.kind) {
    case 'user': {
      const text = typeof frame.text === 'string' ? frame.text : ''
      list.push({
        role: 'user',
        text,
        injected: isInjected(text, last),
        at: frame.at ?? null,
      })
      return list
    }

    case 'turn_start':
      agent()
      return list

    case 'chunk': {
      const chunk = frame.chunk
      if (chunk === null || typeof chunk !== 'object') return list
      const block = agent()
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      if (chunk.type === 'text-delta') {
        block.streamed += text
        block.streaming = true
      } else if (chunk.type === 'reasoning-delta') {
        block.reasoning += text
      }
      return list
    }

    case 'message': {
      const block = agent()
      const text = typeof frame.text === 'string' ? frame.text : ''
      // The message frame is the authority; the streamed text was a preview of
      // this same content and is dropped rather than appended to.
      if (text !== '') block.text = block.text === '' ? text : `${block.text}${text}`
      block.streamed = ''
      block.streaming = false
      if (typeof frame.reasoning === 'string' && frame.reasoning !== '') block.reasoning = frame.reasoning
      block.usage = addUsage(block.usage, frame.usage)
      return list
    }

    // The turn has stopped on a permission decision nobody can make from here
    // (answering approvals over the API is not built yet). Recorded so the wait
    // says so, instead of looking like slow work.
    case 'approval_asked': {
      const block = agent()
      block.awaiting = {
        toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
        reason: typeof frame.reason === 'string' ? frame.reason : '',
      }
      return list
    }

    // Decided, one way or another -- including the fail-closed 'unavailable' of a
    // deployment with no answerer. Either way the turn is moving again, so the
    // wait goes back to describing work.
    case 'approval_decided': {
      const block = agent()
      block.awaiting = null
      return list
    }

    case 'tool_call': {
      const block = agent()
      const name = typeof frame.name === 'string' ? frame.name : ''
      const args = parseArgs(frame.arguments)
      block.tools.push({
        name,
        args,
        raw: typeof frame.arguments === 'string' ? frame.arguments : '',
        path: toolPath(args),
        write: isWrite(name),
        failed: false,
        done: false,
      })
      return list
    }

    case 'tool_result': {
      const block = agent()
      // Results arrive in call order, so the newest unresolved call is this one.
      const pending = [...block.tools].reverse().find((t) => !t.done)
      if (pending !== undefined) {
        pending.done = true
        pending.failed = frame.isError === true
      }
      return list
    }

    case 'turn_end': {
      const block = agent()
      block.reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
      block.streaming = false
      const detail = frame.detail ?? null
      if (block.reason === 'error') block.error = detail?.message ?? '这个回合以错误结束'
      if (block.reason === 'aborted') block.error = detail?.cause === 'user_cancelled' ? '已取消' : '回合被中断'
      return list
    }

    case 'turn_done': {
      // manager's own frame, carrying what the run row will say. It can arrive
      // for a turn that never produced a turn_end (a timeout, a dropped stream),
      // so it opens a block if there is none.
      const block = agent()
      block.runId = frame.runId ?? null
      block.runState = frame.state ?? null
      if (block.reason === null) block.reason = frame.state === 'done' ? 'completed' : 'error'
      block.streaming = false
      if (typeof frame.error === 'string' && frame.error !== '') block.error = frame.error
      return list
    }

    default:
      return list
  }
}

/**
 * Attaches cost and duration from the run rows.
 *
 * Matched by position, and only when the counts agree. A conversation records
 * exactly one run per message, so the Nth agent block is the Nth run -- but a
 * turn that failed before emitting anything leaves a run row with no block, and
 * then every later pairing would be off by one. Attributing one turn's cost to
 * another is worse than leaving the footer without a price, so a mismatch drops
 * the money rather than guessing.
 */
const attachRuns = (list, turns) => {
  const agentBlocks = list.filter((b) => b.role === 'agent')
  if (turns.length !== agentBlocks.length) return list
  agentBlocks.forEach((block, index) => {
    const run = turns[index]
    block.run = run
    if (block.runId === null) block.runId = run.id
    if (block.runState === null) block.runState = run.state
    if (block.error === null && run.error !== null) block.error = run.error
  })
  return list
}

/** The transcript as the server last described it. */
const build = (events, turns) => {
  let list = []
  for (const frame of events) list = reduce(list, frame)
  return attachRuns(list, turns)
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * A board file, as a link to the page it feeds.
 *
 * Only `board/*.json` becomes a link. The mapping needs no guessing -- the board
 * takes a page's key from the file's basename -- and every other path stays
 * plain text, because a local file has no view to open and a link that goes
 * nowhere is worse than no link (UI.md §5).
 */
const boardHref = (path) => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const match = /^board\/([^/]+)\.json$/.exec(normalized)
  if (match === null || state === null) return null
  return `/board/${encodeURIComponent(state.agent.id)}?page=${encodeURIComponent(match[1])}`
}

const writeRow = (tool) => {
  const href = boardHref(tool.path)
  const label = esc(tool.path)
  const inner = href === null ? label : `<a href="${esc(href)}">${label}</a>`
  return `<div class="write-row">
    <span class="pen" aria-hidden="true">✎</span>
    <span>已更新 ${inner}</span>
  </div>`
}

/**
 * Which tool folds the user opened, by turn index.
 *
 * Held outside the markup because the transcript is re-rendered from data on
 * every frame: without this, a fold you opened would snap shut on the next
 * chunk, which during a long turn is several times a second.
 */
const openTools = new Set()

const toolsBlock = (tools, index) => {
  if (tools.length === 0) return ''
  const failed = tools.filter((t) => t.failed).length
  const summary = failed > 0 ? `工具调用 ×${tools.length} · ${failed} 个失败` : `工具调用 ×${tools.length}`
  const rows = tools
    .map((tool) => {
      // The raw argument string, trimmed. Enough to tell two calls to the same
      // tool apart, which is what this fold is for.
      const detail = tool.path !== null ? tool.path : tool.raw.slice(0, 120)
      return `<div class="tool-row${tool.failed ? ' failed' : ''}">
        <span class="name">${esc(tool.name === '' ? '(未命名工具)' : tool.name)}</span>
        <span class="args">${esc(detail)}</span>
      </div>`
    })
    .join('')
  return `<details class="tools" data-fold="${index}"${openTools.has(index) ? ' open' : ''}>
    <summary><span class="chev">${icon('chev', 11)}</span>${esc(summary)}</summary>
    ${rows}
  </details>`
}

// ---------------------------------------------------------------------------
// reply feedback (copy / up / down)
// ---------------------------------------------------------------------------

// Local for now: a tap is remembered per turn id so the thumbs stay honest
// across reloads. No server API exists yet, so nothing pretends the feedback
// travelled further than this browser.
const FB_KEY = 'manager.chat.feedback'

const readFeedback = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FB_KEY) ?? '{}')
    return raw !== null && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

const setFeedback = (turnId, value) => {
  const fb = readFeedback()
  if (value === null) delete fb[turnId]
  else fb[turnId] = value
  try {
    window.localStorage.setItem(FB_KEY, JSON.stringify(fb))
  } catch {
    // Private-mode storage failures are not worth a visible error: the tap
    // still registers for this page.
  }
}

const feedbackOf = (turnId) => (turnId === null || turnId === '' ? '' : readFeedback()[turnId] ?? '')

const tokens = (usage) => {
  if (usage === null || usage === undefined) return null
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return `${k(usage.inputTokens)} in · ${k(usage.outputTokens)} out`
}

/**
 * One reply's closing line, shown once per reply (never per tool call): when it
 * ended, how long it took, throughput, cost -- and the three actions. `show` is
 * true only on the last agent block of a run, which is what keeps a multi-step
 * reply from printing this row several times.
 */
const footer = (block, index, show) => {
  if (block.error !== null) {
    return `<div class="turn-foot failed">${icon('alert', 12)}<span>${esc(block.error)}</span></div>`
  }
  if (!show || block.streaming) return ''

  const run = block.run
  const durationSec =
    run !== undefined && run !== null && run.endedAt !== null
      ? Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))
      : 0

  const parts = []
  if (run !== undefined && run !== null && run.endedAt !== null) {
    parts.push(new Date(run.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
  }
  if (durationSec > 0) parts.push(`${durationSec}s`)
  const usage = block.usage
  if (usage !== null && usage !== undefined && usage.outputTokens > 0 && durationSec > 0) {
    parts.push(`${Math.round(usage.outputTokens / durationSec)} tok/s`)
  }
  const t = tokens(usage)
  if (t !== null) parts.push(esc(t))
  if (run !== undefined && run !== null && run.usage !== null && run.usage.cost !== null) {
    parts.push(esc(money(run.usage.cost)))
  }

  const turnId = run !== undefined && run !== null && run.id !== undefined ? String(run.id) : ''
  const fb = feedbackOf(turnId)
  return `<div class="turn-foot">
    ${parts.length === 0 ? '' : `<span class="turn-meta">${parts.join(' · ')}</span>`}
    <span class="grow"></span>
    <div class="turn-actions">
      <button class="turn-act" type="button" data-act="copy" data-copy="${index}" aria-label="复制回答" title="复制">
        ${icon('copy', 14)}
      </button>
      <button class="turn-act${fb === 'up' ? ' on' : ''}" type="button" data-act="up" data-turn="${esc(turnId)}" aria-label="点赞" title="有帮助">
        ${icon('thumb-up', 14)}
      </button>
      <button class="turn-act${fb === 'down' ? ' on' : ''}" type="button" data-act="down" data-turn="${esc(turnId)}" aria-label="反对" title="没帮助">
        ${icon('thumb-down', 14)}
      </button>
    </div>
  </div>`
}

// ---------------------------------------------------------------------------
// rendered markdown
// ---------------------------------------------------------------------------

/**
 * Markdown, parsed once per distinct string.
 *
 * `renderLog` rebuilds the whole transcript on every animation frame, so without
 * this a long chat would re-parse every finished reply dozens of times a second
 * to redraw text that cannot have changed. Only the streaming block misses.
 *
 * Keyed by the text itself, which is what makes it safe: a hit is only possible
 * when the input is identical. Bounded because a long stream produces one key per
 * frame, and an unbounded cache of every intermediate state is a leak.
 */
const mdCache = new Map()
const MD_CACHE_MAX = 240

const mdOnce = (text) => {
  const hit = mdCache.get(text)
  if (hit !== undefined) return hit
  const html = md(text)
  if (mdCache.size >= MD_CACHE_MAX) {
    // Insertion-ordered, so the oldest key is the first one. Dropping a batch
    // rather than one keeps this from running on nearly every frame.
    for (const key of [...mdCache.keys()].slice(0, MD_CACHE_MAX / 2)) mdCache.delete(key)
  }
  mdCache.set(text, html)
  return html
}

const agentTurn = (block, index, showFoot) => {
  const name = state === null ? 'agent' : state.agent.name
  // Streamed text is shown only until the message frame lands, and the two are
  // never concatenated: they are the same content twice.
  const body = block.text !== '' ? block.text : block.streamed
  const writes = block.tools.filter((t) => t.write && t.path !== null)
  return `<div class="turn from-agent">
    <div class="turn-who"><span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span><span>${esc(name)}</span></div>
    ${body === '' && !block.streaming ? '' : `<div class="bubble prose${block.streaming ? ' streaming' : ''}">${mdOnce(body)}</div>`}
    ${toolsBlock(block.tools, index)}
    ${writes.length === 0 ? '' : `<div class="writes">${writes.map(writeRow).join('')}</div>`}
    ${footer(block, index, showFoot)}
  </div>`
}

// The user's own words stay plain text on purpose: rendering their Markdown
// would show them something other than what they typed, and a stray asterisk is
// not a formatting request. No name row either -- alignment and the blue bubble
// are the identity, exactly as DSH renders its user messages.
const userTurn = (block) => `<div class="turn from-user">
    <div class="bubble">${esc(block.text)}</div>
  </div>`

/**
 * Which injected-context folds the user opened, by block index.
 *
 * Same reason as `openTools`: the transcript is rebuilt from data on every
 * frame, so an open fold has to live outside the markup or it snaps shut.
 */
const openContext = new Set()

/**
 * A run of injected user events, as one collapsed fold.
 *
 * Collapsed by default because this is context the harness gave the agent, not
 * part of the conversation -- one real transcript had 3.6KB of it against 46
 * bytes of actual question. It is shown rather than dropped because it is what
 * the agent was actually told, and a transcript that hides that is a transcript
 * that cannot explain the reply.
 */
const contextFold = (group, index) => {
  const bodies = group
    .map((block) => {
      // The wrapper adds nothing once the fold is labelled, so it is peeled off
      // to leave the instructions themselves readable.
      const inner = block.text.replace(/^\s*<system-reminder>/, '').replace(/<\/system-reminder>\s*$/, '')
      return `<div class="context-item prose">${mdOnce(inner.trim())}</div>`
    })
    .join('')
  const label = group.length === 1 ? '系统注入的上下文' : `系统注入的上下文 ×${group.length}`
  return `<details class="context" data-context="${index}"${openContext.has(index) ? ' open' : ''}>
    <summary><span class="chev">${icon('chev', 11)}</span>${esc(label)}</summary>
    ${bodies}
  </details>`
}

const EMPTY_FRESH = `<div class="chat-empty">
    <span class="chat-empty-icon">${icon('chat', 20)}</span>
    <strong>还没有消息</strong>
    <p>说一句就开始。</p>
    <p class="small">这个 agent 会在它自己的工作区里读写文件，所以先确认下面那行写的是你想要的那个。</p>
  </div>`

/**
 * True when the transcript is scrolled to the bottom, within a few pixels.
 *
 * Checked before a redraw and restored after: a stream that always jumped to the
 * end would yank the page away from someone reading further up, and one that
 * never did would leave the text they are waiting for off screen.
 */
const atBottom = () => el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 48

// ---------------------------------------------------------------------------
// the waiting indicator
// ---------------------------------------------------------------------------

/**
 * The turn currently being written to, if any.
 */
const liveBlock = () => {
  const last = blocks[blocks.length - 1]
  return last !== undefined && last.role === 'agent' && last.reason === null ? last : null
}

/**
 * Whether this page is waiting on a turn of its own.
 *
 * Deliberately not "is the last block unfinished": a dropped relay leaves a
 * block whose `turn_end` never came, and an indicator that spins forever teaches
 * you to ignore it. `sending` is this tab's own POST; `busyRunId` is the server's
 * account of what is running, and it is checked against this chat's runs so a
 * turn in another thread does not animate here -- the busy notice covers that.
 */
const runningHere = () => {
  if (sending) return true
  if (state === null || state.busyRunId === null) return false
  return state.turns.some((t) => t.id === state.busyRunId)
}

/**
 * What it is doing, from the last frame that said anything.
 *
 * The point is not precision, it is that the words change: a label that moves
 * from 思考 to 正在用 read to 正在回答 is evidence of progress, while one frozen
 * string is indistinguishable from a hang no matter what it says.
 */
const waitLabel = (block) => {
  // Checked before anything else, and before the block: these are the states
  // where the turn is stopped rather than slow, and any other label here is a
  // lie the clock keeps telling once a second.
  if (asks.size > 0) return asks.size === 1 ? '在等你回答上面那张卡' : `在等你回答上面 ${asks.size} 张卡`
  if (block === null) return '正在唤起它'
  // No card, but the audit trail says it asked: the prompt went to whoever the
  // deployment answers with, which is not this screen.
  if (block.awaiting !== null) {
    const tool = block.awaiting.toolName === '' ? '一个操作' : block.awaiting.toolName
    return `在等授权：${tool}（卡片没到这里，得去 DSH 批）`
  }
  const tool = [...block.tools].reverse().find((t) => !t.done)
  if (tool !== undefined) return `正在用 ${tool.name === '' ? '工具' : tool.name}`
  if (block.streaming || block.streamed !== '' || block.text !== '') return '正在回答'
  if (block.reasoning !== '') return '正在思考'
  return '已收到，正在起草'
}

const elapsedText = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, '0')} 秒`
}

/* Past this, the wait stops being ordinary and the note about stopping earns its
   place. Long turns are normal here -- an agent that reads twenty files before
   answering is working, not stuck -- so the wording reassures rather than warns. */
const SLOW_AFTER_MS = 45_000

// A persistent node rather than part of the transcript markup: the clock ticks
// every second, and rebuilding the transcript that often would drop any text the
// user had selected while reading back through it.
const waitNode = document.createElement('div')
waitNode.className = 'turn from-agent waiting'
waitNode.innerHTML = `<div class="turn-who"><span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span></div>
  <div class="wait-row">
    <span class="wait-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="wait-what" role="status"></span>
    <span class="wait-time" aria-hidden="true"></span>
    <span class="wait-note" aria-hidden="true"></span>
  </div>`

const waitParts = {
  who: waitNode.querySelector('.turn-who'),
  what: waitNode.querySelector('.wait-what'),
  time: waitNode.querySelector('.wait-time'),
  note: waitNode.querySelector('.wait-note'),
}

const paintWait = () => {
  const ms = Date.now() - (turnStartedAt ?? Date.now())
  const slow = ms >= SLOW_AFTER_MS
  const block = liveBlock()
  // Named only when it is not already answering: once a bubble is on screen it
  // carries the name, and repeating it would label the same speaker twice.
  const who = block !== null ? '' : state === null ? 'agent' : state.agent.name
  if (waitParts.who.dataset.name !== who) {
    waitParts.who.dataset.name = who
    // innerHTML, not textContent: the mark must survive the name changes.
    waitParts.who.innerHTML =
      who === ''
        ? `<span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span>`
        : `<span class="who-avatar" aria-hidden="true">${icon('bot', 14)}</span><span>${esc(who)}</span>`
  }
  // Assigned only on change: this runs every second, and rewriting the text of a
  // node inside `role="status"` re-announces it to a screen reader each time.
  const what = waitLabel(block)
  if (waitParts.what.textContent !== what) waitParts.what.textContent = what
  waitParts.time.textContent = elapsedText(ms)
  waitParts.note.textContent = slow ? '长回合很正常 · Esc 可以停下' : ''
  waitNode.classList.toggle('slow', slow)
}

let waitTimer = null

// ---------------------------------------------------------------------------
// the asks: questions and permission prompts waiting on this person
// ---------------------------------------------------------------------------

/**
 * What the agent is blocked on, by id, in arrival order.
 *
 * Kept outside `blocks` because these are not transcript: they are live state
 * the gateway opens and closes, and the reducer rebuilds `blocks` from scratch
 * on every frame. Cards live in their own persistent node for the same reason
 * the waiting indicator does -- a redraw mid-answer must not swallow the text
 * someone is typing into one.
 */
const asks = new Map()

/** Only rebuild the cards when the set of asks actually changes. */
const asksSignature = () => Array.from(asks.keys()).join('|')
let paintedAsks = null

/**
 * Open and close cards from the gateway's own frames.
 *
 * Closing is driven by `question_resolved` / `approval_resolved` rather than by
 * the click that sent the answer, so a card that someone else answered first --
 * another tab, or the turn being cancelled -- disappears here too.
 */
const trackAsks = (frame) => {
  switch (frame.kind) {
    case 'question_asked':
      if (typeof frame.questionId === 'string' && Array.isArray(frame.questions)) {
        asks.set(frame.questionId, { kind: 'question', id: frame.questionId, questions: frame.questions })
      }
      return
    case 'approval_pending':
      if (typeof frame.decisionId === 'string') {
        asks.set(frame.decisionId, {
          kind: 'approval',
          id: frame.decisionId,
          approvalId: typeof frame.approvalId === 'string' ? frame.approvalId : null,
          toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
          reason: typeof frame.reason === 'string' ? frame.reason : null,
        })
      }
      return
    case 'question_resolved':
      asks.delete(frame.questionId)
      return
    case 'approval_resolved':
      if (typeof frame.decisionId === 'string') {
        asks.delete(frame.decisionId)
      } else if (typeof frame.approvalId === 'string') {
        // The resolved frame names the approvalId, not the original rpcId; a
        // fresh mux connection may not have seen the request, so fall back to
        // scanning cards by approvalId.
        for (const [key, value] of asks) {
          if (value.kind === 'approval' && value.approvalId === frame.approvalId) asks.delete(key)
        }
      }
      return
    case 'turn_end':
    case 'turn_done':
      // Nothing can be answered once the turn is over, and a card left behind
      // would take an answer nobody is waiting for.
      asks.clear()
      return
    default:
      return
  }
}

const askNode = document.createElement('div')
askNode.className = 'asks'

const optionRow = (qid, option) => `<button type="button" class="ask-opt" data-q="${esc(qid)}" data-label="${esc(option.label)}">
    <span class="ask-opt-label">${esc(option.label)}</span>
    ${option.description === undefined ? '' : `<span class="ask-opt-desc">${esc(option.description)}</span>`}
  </button>`

const questionCard = (ask) => {
  const bodies = ask.questions.map((q) => `<div class="ask-q" data-q="${esc(q.id)}">
      ${q.header === undefined ? '' : `<div class="ask-q-head">${esc(q.header)}</div>`}
      <div class="ask-q-text">${esc(q.question)}</div>
      ${q.detail === undefined ? '' : `<div class="ask-q-detail prose">${mdOnce(q.detail)}</div>`}
      ${(q.options ?? []).length === 0 ? '' : `<div class="ask-opts${q.multiSelect === true ? ' multi' : ''}">${q.options.map((o) => optionRow(q.id, o)).join('')}</div>`}
      <input class="ask-custom" data-q="${esc(q.id)}" type="text" placeholder="${(q.options ?? []).length === 0 ? '写下你的回答' : '或者自己写一个'}">
    </div>`).join('')
  // DSH's decision-card grammar: amber strip on top, white card, body, and the
  // actions pinned to the bottom-right of the card.
  return `<div class="ask" data-ask="${esc(ask.id)}">
    <div class="ask-strip"><span class="ask-dot" aria-hidden="true"></span>它在等你回答</div>
    <div class="ask-body">${bodies}</div>
    <div class="ask-actions">
      <span class="ask-error"></span>
      <button type="button" class="ask-skip" data-ask="${esc(ask.id)}">不答，让它自己定</button>
      <button type="button" class="ask-send" data-ask="${esc(ask.id)}">回答</button>
    </div>
  </div>`
}

const approvalCard = (ask) => {
  const toolName = ask.toolName === '' ? '一个工具' : ask.toolName
  return `<div class="ask approval" data-ask="${esc(ask.id)}">
    <div class="ask-strip"><span class="ask-dot" aria-hidden="true"></span>等待授权</div>
    <div class="ask-body">
      <div class="ask-headline">它要用「${esc(toolName)}」做一件事，需要你批准</div>
      ${ask.reason === null || ask.reason === '' ? '' : `<div class="ask-q-detail">${esc(ask.reason)}</div>`}
    </div>
    <div class="ask-actions">
      <span class="ask-error"></span>
      <button type="button" class="ask-reject" data-ask="${esc(ask.id)}">不允许</button>
      <button type="button" class="ask-allow" data-ask="${esc(ask.id)}">允许这一次</button>
    </div>
  </div>`
}

/**
 * Attaches the cards, rebuilding them only when the asks changed.
 *
 * The guard is what makes a half-typed answer safe: without it every arriving
 * frame would replace the input the person is using.
 */
const syncAsks = () => {
  if (asks.size === 0) {
    askNode.remove()
    askNode.innerHTML = ''
    paintedAsks = null
    return
  }
  const signature = asksSignature()
  if (signature !== paintedAsks) {
    askNode.innerHTML = Array.from(asks.values()).map((ask) => (ask.kind === 'approval' ? approvalCard(ask) : questionCard(ask))).join('')
    paintedAsks = signature
  }
  el.log.append(askNode)
}

/** Collect one card's answers, or the reason it cannot be sent yet. */
const gatherAnswers = (card, ask) => {
  const answers = []
  for (const question of ask.questions) {
    const scope = card.querySelector(`.ask-q[data-q="${CSS.escape(question.id)}"]`)
    if (scope === null) return { error: '这张卡片已经不在了，刷新一下' }
    const selected = Array.from(scope.querySelectorAll('.ask-opt.on')).map((node) => node.dataset.label)
    const custom = scope.querySelector('.ask-custom').value.trim()
    if (selected.length === 0 && custom === '') {
      return { error: (question.options ?? []).length === 0 ? '写一句就行' : '选一个，或者自己写一个' }
    }
    answers.push({ id: question.id, selected, ...(custom === '' ? {} : { custom }) })
  }
  return { answers }
}

const postAsk = async (card, path, body) => {
  const error = card.querySelector('.ask-error')
  const buttons = Array.from(card.querySelectorAll('button'))
  for (const button of buttons) button.disabled = true
  error.textContent = ''
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      // Re-enabled rather than removed: the answer was refused, so the card is
      // still the thing that has to be corrected and sent again.
      for (const button of buttons) button.disabled = false
      error.textContent = payload.detail ?? `没发出去（${response.status}）`
      return
    }
    // The card is removed by the gateway's own `question_resolved` /
    // `approval_resolved` frame, not here: it is the gateway that decides the
    // ask is closed, and it also closes it when someone else answers first.
    card.classList.add('sent')
  } catch (failure) {
    for (const button of buttons) button.disabled = false
    error.textContent = `没发出去：${failure.message}`
  }
}

askNode.addEventListener('click', (event) => {
  const target = event.target.closest === undefined ? null : event.target
  if (target === null) return

  const option = target.closest('.ask-opt')
  if (option !== null) {
    const group = option.parentElement
    // Single-select behaves like radios; multi-select toggles. Enforced here as
    // well as in the gateway, so the shape of the card matches what it accepts.
    if (!group.classList.contains('multi')) {
      for (const sibling of group.querySelectorAll('.ask-opt.on')) if (sibling !== option) sibling.classList.remove('on')
    }
    option.classList.toggle('on')
    return
  }

  const button = target.closest('.ask-send, .ask-skip, .ask-allow, .ask-reject')
  if (button === null) return
  const ask = asks.get(button.dataset.ask)
  const card = button.closest('.ask')
  if (ask === undefined || card === null) return

  if (button.classList.contains('ask-allow') || button.classList.contains('ask-reject')) {
    const outcome = button.classList.contains('ask-allow') ? 'allowed-once' : 'rejected'
    void postAsk(card, `/api/chats/${encodeURIComponent(chatId)}/approvals/${encodeURIComponent(ask.id)}`, {
      outcome,
      approvalId: ask.approvalId ?? undefined,
    })
    return
  }
  if (button.classList.contains('ask-skip')) {
    void postAsk(card, `/api/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(ask.id)}`, { decline: true })
    return
  }
  const gathered = gatherAnswers(card, ask)
  if (gathered.error !== undefined) {
    card.querySelector('.ask-error').textContent = gathered.error
    return
  }
  void postAsk(card, `/api/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(ask.id)}`, { answers: gathered.answers })
})

/**
 * Attaches or detaches the indicator, and runs the clock only while it is shown.
 *
 * Called from `renderLog`, which has just replaced the log's contents, so the
 * node has to be re-attached rather than assumed present.
 */
const syncWait = () => {
  if (!runningHere()) {
    if (waitTimer !== null) {
      clearInterval(waitTimer)
      waitTimer = null
    }
    waitNode.remove()
    return
  }
  paintWait()
  el.log.append(waitNode)
  if (waitTimer === null) {
    waitTimer = setInterval(() => {
      if (!runningHere()) {
        syncWait()
        return
      }
      // Only the clock's own text changes, so the transcript above it is left
      // exactly as it was -- scroll position, selection and open folds included.
      paintWait()
    }, 1000)
  }
}

// ---------------------------------------------------------------------------
// scroll-to-bottom control
// ---------------------------------------------------------------------------
//
// DSH's ChatView toBottom, adapted: a persistent node (like askNode) because
// renderLog replaces the transcript's innerHTML on every frame. Sticky to the
// log's bottom edge, hidden while the end is already in view.
const toBottomSlot = document.createElement('div')
toBottomSlot.className = 'to-bottom-slot'
toBottomSlot.hidden = true
toBottomSlot.innerHTML = `<button type="button" class="to-bottom" aria-label="回到底部" title="回到底部">${icon('down', 16)}</button>`

const syncToBottom = () => {
  const overflow = el.log.scrollHeight - el.log.clientHeight
  toBottomSlot.hidden = overflow <= 8 || atBottom()
}

/** Re-attach after a rebuild and recompute visibility. */
const reattachToBottom = () => {
  el.log.append(toBottomSlot)
  syncToBottom()
}

toBottomSlot.querySelector('button').addEventListener('click', () => {
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.log.scrollTo({ top: el.log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
})

el.log.addEventListener('scroll', syncToBottom)
window.addEventListener('resize', syncToBottom)

const renderLog = () => {
  const pinned = atBottom()
  // A turn can be running before its first frame has arrived, and "还没有消息"
  // under a message you just sent is the exact false impression this whole
  // indicator exists to prevent.
  if (blocks.length === 0 && !runningHere()) {
    el.log.innerHTML = EMPTY_FRESH
    // Still synced: the innerHTML above detached the card node, and a card that
    // is open has to come back even on an otherwise empty screen.
    syncAsks()
    reattachToBottom()
    return
  }
  if (blocks.length === 0) {
    el.log.innerHTML = ''
    syncAsks()
    syncWait()
    el.log.scrollTop = el.log.scrollHeight
    reattachToBottom()
    return
  }

  // Consecutive injected blocks become one fold rather than one each: the
  // harness sends them in runs, and three folds in a row is the same wall of
  // text with more clicks.
  const html = []
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (block.role === 'user' && block.injected === true) {
      const group = []
      const start = i
      while (i < blocks.length && blocks[i].role === 'user' && blocks[i].injected === true) {
        group.push(blocks[i])
        i += 1
      }
      i -= 1
      html.push(contextFold(group, start))
      continue
    }
    // The closing line (stats + copy/feedback) belongs to the reply, not to
    // every intermediate agent block of a multi-step run: only the last agent
    // block before a user message -- or the end of the transcript -- gets it.
    const nextIsAgent = i + 1 < blocks.length && blocks[i + 1].role === 'agent'
    html.push(block.role === 'user' ? userTurn(block) : agentTurn(block, i, !nextIsAgent))
  }

  el.log.innerHTML = html.join('')
  // Before the waiting indicator: the card is the thing to act on, the clock
  // below it is only commentary.
  syncAsks()
  syncWait()
  reattachToBottom()
  if (pinned) el.log.scrollTop = el.log.scrollHeight
}

/**
 * Coalesces redraws into one per animation frame.
 *
 * `chunk` frames arrive far faster than the screen refreshes, so rendering each
 * one would rebuild the transcript dozens of times per second to show text the
 * eye cannot follow anyway.
 */
let pending = false
const render = () => {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    renderHead()
    renderNotices()
    renderLog()
    renderComposer()
  })
}

// Remembered on toggle, since the next redraw builds the fold from data.
//
// Captured rather than bubbled: `toggle` does not bubble, so a delegated
// listener on the container only ever sees it during the capture phase.
el.log.addEventListener(
  'toggle',
  (event) => {
    const target = event.target
    if (target.closest === undefined) return

    const tools = target.closest('.tools')
    if (tools !== null) {
      const index = Number(tools.dataset.fold)
      if (tools.open) openTools.add(index)
      else openTools.delete(index)
      return
    }

    const context = target.closest('.context')
    if (context !== null) {
      const index = Number(context.dataset.context)
      if (context.open) openContext.add(index)
      else openContext.delete(index)
    }
  },
  { capture: true },
)

// Reply actions (copy / up / down), delegated: the transcript is rebuilt from
// data on every frame, so a listener on a per-turn control would be attached to
// a node that no longer exists.
el.log.addEventListener('click', (event) => {
  const act = event.target.closest('.turn-act')
  if (act === null) return

  if (act.dataset.act === 'copy') {
    const block = blocks[Number(act.dataset.copy)]
    const text = block === undefined ? '' : block.text !== '' ? block.text : block.streamed
    if (text !== '') {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast('已复制'))
        .catch(() => toast('复制失败'))
    }
    return
  }

  const turnId = act.dataset.turn ?? ''
  if (turnId === '') return
  const kind = act.dataset.act
  const next = readFeedback()[turnId] === kind ? null : kind
  setFeedback(turnId, next)
  toast(next === null ? '已撤销' : kind === 'up' ? '已点赞，谢谢' : '已反对')
  render()
})

// ---------------------------------------------------------------------------
// header, notices, composer
// ---------------------------------------------------------------------------

const chatTitle = () => {
  if (state === null) return '对话'
  const t = state.chat.title
  return t === null || t === '' ? '新会话' : t
}

const renderHead = () => {
  if (state === null) return
  // No header element on this page any more (DSH's own view leads with the
  // transcript); the title still belongs in the tab and in the narrow-screen
  // app bar, which is the only place a title appears there.
  const title = chatTitle()
  document.title = `${title} · ${state.agent.name} · Oh! dsh`
  window.dispatchEvent(new CustomEvent('shell:title', { detail: title }))
}

/**
 * The other chat holding this agent, if any.
 *
 * `busyRunId` says the agent is occupied but not by which thread, so the chat is
 * found through the sidebar's own list. Returning null means "busy, but we
 * cannot say where" -- the composer still locks, it just cannot offer the link.
 */
let siblingChats = []

const busyElsewhere = () => {
  if (state === null || state.busyRunId === null) return null
  if (sending) return null
  const mine = state.turns.some((t) => t.id === state.busyRunId)
  if (mine) return null
  return siblingChats.find((c) => c.id !== state.chat.id) ?? null
}

const strip = (level, html) => `<div class="state-strip ${level}">${icon('alert', 13)}<span>${html}</span></div>`

/**
 * The queued-turn dock above the composer (DSH-style): one row per queued
 * message, single-line ellipsis, newest at the bottom of the list.
 */
const renderQueueDock = () => {
  if (queuedItems.length === 0) {
    el.queueDock.hidden = true
    el.queueDock.innerHTML = ''
    return
  }
  el.queueDock.hidden = false
  el.queueDock.innerHTML = queuedItems
    .map(
      (item) =>
        `<div class="queue-row" data-id="${esc(item.id)}">` +
        `<span class="queue-badge">排队中</span>` +
        `<span class="queue-text" title="${esc(item.text)}">${esc(item.text)}</span>` +
        `<button type="button" class="queue-act" data-action="edit" title="撤销并回填输入框">${icon('pencil', 13)}</button>` +
        `<button type="button" class="queue-act" data-action="delete" title="删除这条排队消息">${icon('trash', 13)}</button>` +
        `</div>`,
    )
    .join('')
}

/**
 * Edit pulls the queued text back into the composer (undo); delete drops it.
 * Both call the same idempotent cancel endpoint and remove the row locally.
 */
const cancelQueued = async (row, action) => {
  const id = row.dataset.id
  const item = queuedItems.find((q) => q.id === id)
  if (item === undefined) return
  const index = queuedItems.indexOf(item)
  try {
    await fetch(`/api/chats/${encodeURIComponent(chatId)}/queued/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  } catch {
    // The row stays if the server cannot be reached; the user can try again.
    return
  }
  queuedItems.splice(index, 1)
  if (action === 'edit') {
    el.input.value = item.text
    grow()
    el.input.focus()
    toast('已撤销，改完再发即可')
  }
  render()
}

const renderNotices = () => {
  if (state === null) return
  const out = []

  // `cold` is deliberately NOT a strip any more: it is a normal state that
  // costs the reader nothing until they are about to type. It lives in the
  // composer's hint line instead -- the place the action actually happens.
  if (state.sessionState === 'lost') {
    out.push(strip('bad', '这个会话已无法继续，历史仅供查阅'))
  }

  // Busy is reported whenever the agent is held by work this page did not start,
  // even when the offending thread cannot be named: the composer locks either
  // way, so an unexplained lock would be the worse outcome (UI.md §4).
  if (state.busyRunId !== null && !sending) {
    const busy = busyElsewhere()
    const where =
      busy === null
        ? '另一个会话'
        : `会话「<a href="/chat/${encodeURIComponent(busy.id)}">${esc(busy.title ?? '新会话')}</a>」`
    out.push(strip('warn', `${esc(state.agent.name)} 正忙于${where} · 新消息会自动排队，前一个完成后接着跑`))
  }

  el.notices.innerHTML = out.join('')
  renderQueueDock()
}

const renderComposer = () => {
  if (state === null) return
  // The agent pill carries the name; the full path is one hover away.
  el.agent.textContent = state.agent.name
  el.agent.title = state.agent.workspacePath ?? ''
  el.path.textContent = state.agent.workspacePath ?? ''
  el.path.title = state.agent.workspacePath ?? ''

  const lost = state.sessionState === 'lost'
  const busy = state.busyRunId !== null && !sending
  const cold = state.sessionState === 'cold'
  // Busy no longer locks the composer: a message sent while the agent runs is
  // queued server-side and starts automatically when the run finishes.
  const locked = lost || sending

  el.input.disabled = lost
  el.send.disabled = locked || el.input.value.trim() === ''
  // The stop button shows while this chat has a running turn — the POST itself
  // returns immediately now, so `sending` alone no longer covers the run.
  const turnRunning = state.turns.some((t) => t.state === 'running')
  el.stop.hidden = !(sending || turnRunning)
  el.send.hidden = sending

  el.input.placeholder = lost
    ? '这个会话已无法继续'
    : busy
      ? `${state.agent.name} 正在忙，新消息会自动排队`
      : sending
        ? '正在等它回答…'
        : '说点什么…'

  // The hint is the quiet channel: how to interrupt while sending, and the
  // dormancy note when there is one -- next to the input, where it is acted on,
  // not as a banner over the history.
  el.hint.textContent = sending ? '按 Esc 或点「停止」可以中断' : cold ? '已休眠 · 下一条消息会唤回它' : ''
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

/**
 * Frames that arrived while a full load was in flight.
 *
 * A reload reads the history server-side, so a frame delivered during the fetch
 * may or may not already be in the response. Dropping them all loses a turn that
 * another tab is streaming right now; applying them all renders the same text
 * twice. They are held here and reconciled against the history instead.
 */
let buffered = []
let loading = false

/**
 * Whether the loaded history already contains this frame.
 *
 * Gateway frames carry `seq`, which is exactly the discriminator needed: the
 * history's own events carry it too, so anything at or below the highest seq in
 * the history is a frame we have just been given a second time.
 *
 * manager's two own frames have no seq. `turn_done` only sets fields and is safe
 * to apply twice. Its `user` echo is compared by text against the newest user
 * block, because the gateway records the message as an event of its own, so the
 * history usually already holds it.
 */
const alreadyLoaded = (frame, maxSeq, list) => {
  if (typeof frame.seq === 'number') return frame.seq <= maxSeq
  if (frame.kind !== 'user') return false
  const lastUser = [...list].reverse().find((b) => b.role === 'user')
  return lastUser !== undefined && lastUser.text === frame.text
}

const fatal = (message) => {
  el.log.innerHTML = `<div class="chat-empty"><p>${esc(message)}</p></div>`
  reattachToBottom()
  el.input.disabled = true
  el.send.disabled = true
}

/**
 * 蜂群 P2/P3：主脑派工记录（delegation 帧）。
 *
 * 与 transcript 分开的独立区块：帧数据来自 run 表（source_chat_id），不是
 * 会话历史；按时间与消息流精确交错代价高、收益小，MVP 先平铺在转录上方。
 * 实时更新 = relay 上的 delegation_done 帧 → 重新拉取。
 */
const DELEGATION_ICON = { done: '✓', failed: '✕', running: '…', pending: '…' }
const DELEGATION_CLASS = { done: 'ok', failed: 'bad', running: 'warn', pending: 'warn' }

const renderDelegations = (list) => {
  if (el.delegations === null) return
  if (list.length === 0) {
    el.delegations.hidden = true
    el.delegations.innerHTML = ''
    return
  }
  el.delegations.hidden = false
  el.delegations.innerHTML = list
    .map((d) => {
      const icon = DELEGATION_ICON[d.state] ?? '…'
      const cls = DELEGATION_CLASS[d.state] ?? 'muted'
      const summary = typeof d.summary === 'string' && d.summary !== '' ? d.summary : (typeof d.error === 'string' && d.error !== '' ? d.error : '')
      const detail = summary !== '' ? `<span class="delegation-body">${esc(summary)}</span>` : ''
      return `<div class="delegation ${cls}">
        <span class="delegation-icon" aria-hidden="true">${icon}</span>
        <span class="delegation-main">
          <span class="delegation-head">已派给 ${esc(d.agentName ?? d.agentId)} · ${esc(d.state)}</span>
          ${detail}
        </span>
      </div>`
    })
    .join('')
}

const loadDelegations = async () => {
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/delegations`)
    if (!response.ok) return
    const body = await response.json()
    renderDelegations(Array.isArray(body.delegations) ? body.delegations : [])
  } catch {
    // 非主脑会话本就没有派工记录；接口异常也不值得打断对话。
  }
}

const load = async () => {
  // Set before the request, so frames delivered during it are buffered rather
  // than applied to a transcript that is about to be replaced.
  loading = true
  buffered = []
  let response
  try {
    response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, { headers: { accept: 'application/json' } })
  } catch (error) {
    loading = false
    fatal(`连不上 manager：${error.message}`)
    return
  }

  if (response.status === 401) {
    window.location.href = '/login'
    return
  }
  if (!response.ok) {
    loading = false
    const body = await response.json().catch(() => ({}))
    // 409 and 502 carry a `detail` written for a person; 404 does not.
    fatal(
      response.status === 404
        ? '没有这个会话，或者它已被移除'
        : (body.detail ?? `服务端返回 ${response.status}`),
    )
    return
  }

  state = await response.json()
  // The run row is the authority on when the live turn began, and it is the only
  // source that survives a refresh: without this, F5 during a long turn would
  // restart the clock at zero and claim the wait had only just started.
  const runningRun = state.busyRunId === null ? undefined : state.turns.find((t) => t.id === state.busyRunId)
  if (runningRun !== undefined && typeof runningRun.startedAt === 'number') turnStartedAt = runningRun.startedAt
  else if (!sending) turnStartedAt = null
  const maxSeq = state.events.reduce((max, e) => (typeof e.seq === 'number' && e.seq > max ? e.seq : max), -1)
  const rebuilt = build(state.events, state.turns)
  // Queued (or just-sent) messages are not in the DSH history yet — draw them
  // locally until the history contains them, the same way DSH keeps a queued
  // bubble visible above the composer.
  const stillPending = []
  for (const p of pendingUserTexts) {
    if (rebuilt.some((b) => b.role === 'user' && b.text === p.text)) continue
    rebuilt.push({ role: 'user', text: p.text, injected: false, at: p.at })
    stillPending.push(p)
  }
  pendingUserTexts = stillPending
  // Anything that arrived mid-fetch and is not in the history yet still belongs
  // on screen, so it is replayed on top rather than thrown away.
  const pendingFrames = buffered.filter((f) => !alreadyLoaded(f, maxSeq, rebuilt))
  for (const f of pendingFrames) {
    if (f.kind === 'turn_queued') queuedItems.push({ id: typeof f.id === 'string' ? f.id : '', text: typeof f.text === 'string' ? f.text : '', at: Date.now() })
    if (f.kind === 'turn_start' && queuedItems.length > 0) {
      const started = queuedItems.shift()
      pendingUserTexts.push(started)
    }
  }
  blocks = pendingFrames.filter((f) => f.kind !== 'turn_queued').reduce((list, frame) => reduce(list, frame), rebuilt)
  // Replayed through the ask tracker too: a question that opened while the
  // history was loading is the one most likely to be waiting right now.
  for (const frame of pendingFrames) trackAsks(frame)
  buffered = []
  loading = false
  render()
  void loadDelegations()
}

/**
 * Loads, one at a time.
 *
 * A finished turn triggers a reload from two places at once -- the POST resolving
 * and `turn_done` arriving -- and two overlapping loads would have the second
 * clear the first one's buffer, dropping frames it had already set aside.
 */
let chain = Promise.resolve()
const reload = () => {
  chain = chain.then(load, load)
  return chain
}

/** The agent's other chats, for naming the thread that is holding it. */
const loadSiblings = async () => {
  try {
    const response = await fetch('/api/chats')
    if (!response.ok) return
    const { agents } = await response.json()
    const mine = agents.find((a) => state !== null && a.id === state.agent.id)
    siblingChats = mine === undefined ? [] : mine.chats
    render()
  } catch {
    // Only costs the link inside the busy notice.
  }
}

// ---------------------------------------------------------------------------
// live stream
// ---------------------------------------------------------------------------

// One stream, and only while this page is actually on screen.
//
// HTTP/1.1 gives the *whole origin* six connections, and a stream holds one of
// them for as long as it is open. A page that keeps streaming after you have
// navigated away -- and Chrome keeps the old document alive in its back/forward
// cache -- is one connection fewer for everything that comes after, including
// the navigation itself. Six of those and the site stops answering: every
// request, even the HTML document, sits queued behind a socket that will never
// free up. So this is not battery hygiene, it is the difference between working
// and hanging.
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
  // Never two streams for one page: a second one costs a second connection and
  // delivers every frame twice.
  disconnect()
  const es = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/events`)
  source = es

  es.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object') return
    // `hello` only says the relay is open. History came from the GET, and the
    // relay deliberately carries no replay.
    if (frame.kind === 'hello') return
    // 蜂群 P2：派工结束帧——不是转录帧，刷新派工记录即可。
    if (frame.kind === 'delegation_done') {
      void loadDelegations()
      return
    }

    if (frame.kind === 'turn_queued') {
      if (loading) {
        buffered.push(frame)
        return
      }
      queuedItems.push({ id: typeof frame.id === 'string' ? frame.id : '', text: typeof frame.text === 'string' ? frame.text : '', at: Date.now() })
      render()
      return
    }
    if (loading) {
      buffered.push(frame)
      return
    }

    // The queued message whose turn now starts is no longer queued: it moves
    // from the dock into the log (via the pending bubble, until the history
    // contains it).
    if (frame.kind === 'turn_start' && queuedItems.length > 0) {
      const started = queuedItems.shift()
      pendingUserTexts.push(started)
    }

    blocks = reduce(blocks, frame)
    trackAsks(frame)

    // A turn another tab started, or one begun before this page opened.
    if (frame.kind === 'turn_start' && turnStartedAt === null) turnStartedAt = Date.now()

    if (frame.kind === 'turn_done') {
      sending = false
      turnStartedAt = null
      // Reloaded because the run row is what carries the price and the duration,
      // and because a first turn has just bound a gateway session, which changes
      // sessionState from `fresh` to `live`.
      void reload()
      void loadSiblings()
      return
    }
    render()
  })

  es.addEventListener('open', () => {
    retryDelay = 3000
  })

  es.addEventListener('error', () => {
    // `es`, not `source`: this handler outlives its own instance, and closing
    // whatever happens to be current would leave the failed one retrying on its
    // own -- a leaked connection every time.
    es.close()
    if (es !== source) return
    source = null
    // EventSource retries on its own, but not once the server closes the stream
    // outright (a manager restart), so reconnect with a backoff.
    retryTimer = setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30_000)
  })
}

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------

const grow = () => {
  el.input.style.height = 'auto'
  el.input.style.height = `${el.input.scrollHeight}px`
}

const send = async () => {
  const text = el.input.value.trim()
  if (text === '' || sending || state === null) return

  // Cleared before the request, not after: leaving the text in the box while a
  // turn runs invites a second send, and a second send is a 409.
  el.input.value = ''
  grow()
  sending = true
  // Set here rather than on `turn_start`: the gateway can take seconds to send
  // that frame, and those seconds are precisely the ones that feel like a hang.
  turnStartedAt = Date.now()
  render()

  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      sending = false
      // The text goes back in the box: it was never delivered, and retyping it
      // is the last thing anyone wants after being told the agent was busy.
      el.input.value = text
      grow()
      toast(body.detail ?? `发送失败（${response.status}）`)
      void reload()
      return
    }

    // Read the result first: an accepted turn may need the local bubble (its
    // message can still be missing from the history on the reload below), while
    // a queued one must NOT appear in the log yet — it lives in the dock until
    // its turn actually starts.
    const result = await response.json().catch(() => ({}))
    if (result.queued !== true) pendingUserTexts.push({ text, at: Date.now() })
    sending = false
    // The turn's own frames drove the transcript; this reload is for the run row
    // and for a title the server may have derived. It is also the fallback when
    // the relay dropped and `turn_done` never arrived.
    await reload()
    if (result.queued === true) {
      toast(`已排队（第 ${result.position} 位），前一个任务完成后自动开始`)
    }
    void loadSiblings()
  } catch (error) {
    sending = false
    el.input.value = text
    grow()
    toast(`发送失败：${error.message}`)
    render()
  }
}

el.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void send()
})

el.input.addEventListener('input', () => {
  grow()
  el.send.disabled = el.input.value.trim() === '' || sending
})

el.input.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter breaks the line -- the convention every chat client
  // shares, including DSH.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
})

const cancel = async () => {
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/cancel`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    toast(response.ok ? '已请求停止' : (body.detail ?? '停止失败'))
  } catch (error) {
    toast(`停止失败：${error.message}`)
  }
}

el.stop.addEventListener('click', () => void cancel())

// Queued-turn dock actions: edit (undo into the composer) and delete.
el.queueDock.addEventListener('click', (event) => {
  const button = event.target.closest('.queue-act')
  if (button === null) return
  const row = button.closest('.queue-row')
  if (row === null) return
  void cancelQueued(row, button.dataset.action)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sending) void cancel()
})

// ---------------------------------------------------------------------------
// thread actions
// ---------------------------------------------------------------------------
//
// Rename and archive used to live in the page header. That header is gone (the
// page now leads with the transcript, like DSH), and both actions already
// exist on the sidebar's row menu -- shell.js owns them, so this page keeps no
// copy. Deleting the handlers here must stay deleted: their buttons no longer
// exist in the DOM.

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

// A phone that has been in a pocket comes back with a dead socket and a stale
// transcript. Reload on return rather than waiting for the next frame -- and give
// the connection back while away, since a hidden page has nothing to draw with
// it.
document.addEventListener('visibilitychange', () => {
  if (chatId === null) return
  if (document.visibilityState === 'visible') {
    void reload()
    connect()
  } else {
    disconnect()
  }
})

// Leaving the page. `pagehide` rather than `unload`, which disqualifies the page
// from the back/forward cache and is exactly the event that does not fire when a
// page is frozen into it.
window.addEventListener('pagehide', disconnect)

if (chatId === null) {
  // `/chat` with no id. The sidebar is the chat list, so this only has to say so
  // rather than build a second one.
  el.identity.hidden = true
  el.composer.hidden = true
  el.log.innerHTML = `<div class="chat-empty">
      <p>从左边选一个会话，或者在某个 agent 下点「新会话」。</p>
    </div>`
  reattachToBottom()
} else {
  void reload().then(loadSiblings)
  connect()
}
