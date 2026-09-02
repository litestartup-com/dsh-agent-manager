import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  eventPayload, mapEvents, muxFrameToEvent, muxFrameToGatewayFrame,
  createSessionParams, promptParams, cancelParams, historyParams,
  extractProjectionUsage, extractProjectionTitle,
  questionRequestedFrame, questionResolvedFrame, approvalRequestedFrame, approvalResolvedFrame,
  unwrapHistoryEvents, mapSessionList,
  type MuxFrame,
} from './translate.js'

// ---- eventPayload ----

describe('eventPayload', () => {
  it('maps user/message', () => {
    const result = eventPayload({ type: 'user/message', seq: 1, data: { id: 'msg-1', content: [{ type: 'text', text: 'hello' }] } })
    assert.deepEqual(result, { kind: 'user', seq: 1, messageId: 'msg-1', text: 'hello' })
  })

  it('maps assistant/chunk text-delta', () => {
    const result = eventPayload({ type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: 'hi' } } })
    assert.ok(result)
    assert.equal(result.kind, 'chunk')
    assert.deepEqual(result.chunk, { type: 'text-delta', text: 'hi' })
  })

  it('maps assistant/chunk reasoning-delta', () => {
    const result = eventPayload({ type: 'assistant/chunk', seq: 3, data: { chunk: { type: 'reasoning-delta', text: 'thinking...' } } })
    assert.ok(result)
    assert.equal(result.kind, 'chunk')
    assert.deepEqual(result.chunk, { type: 'reasoning-delta', text: 'thinking...' })
  })

  it('maps assistant/message with usage', () => {
    const result = eventPayload({
      type: 'assistant/message', seq: 10,
      data: {
        message: { content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'thought' }] },
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
      },
    })
    assert.ok(result)
    assert.equal(result.kind, 'message')
    assert.equal(result.text, 'answer')
    assert.equal(result.reasoning, 'thought')
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 })
  })

  it('maps assistant/message with null reasoning', () => {
    const result = eventPayload({
      type: 'assistant/message', seq: 10,
      data: { message: { content: [{ type: 'text', text: 'answer' }] }, usage: null },
    })
    assert.ok(result)
    assert.equal(result.reasoning, null)
    assert.equal(result.usage, null)
  })

  it('maps tool/call', () => {
    const result = eventPayload({ type: 'tool/call', seq: 5, data: { name: 'read_file', arguments: '{"path":"/tmp"}' } })
    assert.deepEqual(result, { kind: 'tool_call', seq: 5, name: 'read_file', arguments: '{"path":"/tmp"}' })
  })

  it('maps tool/result', () => {
    const result = eventPayload({
      type: 'tool/result', seq: 6,
      data: { error: false, message: { content: [{ type: 'text', content: [{ type: 'text', text: 'file content' }], isError: false }] } },
    })
    assert.ok(result)
    assert.equal(result.kind, 'tool_result')
    assert.equal(result.isError, false)
    assert.equal(result.text, 'file content')
  })

  it('maps turn/start', () => {
    const result = eventPayload({ type: 'turn/start', seq: 0, data: { turn: 1 } })
    assert.deepEqual(result, { kind: 'turn_start', seq: 0, turn: 1 })
  })

  it('maps turn/end with error', () => {
    const result = eventPayload({
      type: 'turn/end', seq: 99,
      data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E_FAIL' } } },
    })
    assert.ok(result)
    assert.equal(result.kind, 'turn_end')
    assert.equal(result.reason, 'error')
    assert.deepEqual(result.detail, { message: 'boom', code: 'E_FAIL' })
  })

  it('maps turn/end with aborted', () => {
    const result = eventPayload({
      type: 'turn/end', seq: 99,
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    assert.ok(result)
    assert.equal(result.reason, 'aborted')
    assert.deepEqual(result.detail, { cause: 'user' })
  })

  it('maps approval/asked', () => {
    const result = eventPayload({
      type: 'approval/asked', seq: 7,
      data: { id: 'ap-1', toolName: 'write_file', callId: 'call-1', reason: 'dangerous' },
    })
    assert.deepEqual(result, { kind: 'approval_asked', seq: 7, id: 'ap-1', toolName: 'write_file', callId: 'call-1', reason: 'dangerous' })
  })

  it('maps approval/decided', () => {
    const result = eventPayload({ type: 'approval/decided', seq: 8, data: { id: 'ap-1', outcome: 'allowed-once' } })
    assert.deepEqual(result, { kind: 'approval_decided', seq: 8, id: 'ap-1', outcome: 'allowed-once' })
  })

  it('returns null for unknown event types', () => {
    assert.equal(eventPayload({ type: 'internal/bookkeeping', seq: 0 }), null)
  })

  it('returns null for null/undefined', () => {
    assert.equal(eventPayload(null), null)
    assert.equal(eventPayload(undefined), null)
  })
})

// ---- mapEvents ----

describe('mapEvents', () => {
  it('maps and filters a batch', () => {
    const events = [
      { type: 'user/message', seq: 1, data: { id: 'a', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'internal/unknown', seq: 2, data: {} },
      { type: 'turn/start', seq: 3, data: { turn: 1 } },
    ]
    const result = mapEvents(events)
    assert.equal(result.length, 2)
    assert.equal(result[0]!.kind, 'user')
    assert.equal(result[1]!.kind, 'turn_start')
  })
})

// ---- muxFrameToEvent ----

describe('muxFrameToEvent', () => {
  it('extracts event from session/event frame', () => {
    const frame: MuxFrame = {
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'user/message', seq: 1, data: { id: 'a', content: [{ type: 'text', text: 'hi' }] } },
    }
    const result = muxFrameToEvent(frame)
    assert.ok(result)
    assert.equal(result.kind, 'user')
    assert.equal(result.text, 'hi')
  })

  it('returns null for non-event frames', () => {
    assert.equal(muxFrameToEvent({ type: 'session/projection', sessionId: 's1' }), null)
    assert.equal(muxFrameToEvent({ type: 'session/subscribed', sessionId: 's1' }), null)
  })

  it('returns null when event is missing', () => {
    assert.equal(muxFrameToEvent({ type: 'session/event', sessionId: 's1' }), null)
  })
})

// ---- muxFrameToGatewayFrame ----

describe('muxFrameToGatewayFrame', () => {
  it('returns a GatewayFrame with kind and seq', () => {
    const frame: MuxFrame = {
      type: 'session/event',
      sessionId: 's1',
      event: { type: 'turn/start', seq: 5, data: { turn: 2 } },
    }
    const result = muxFrameToGatewayFrame(frame)
    assert.ok(result)
    assert.equal(result.kind, 'turn_start')
    assert.equal(result.seq, 5)
  })
})

// ---- manager input → apiproxy params ----

describe('createSessionParams', () => {
  it('includes cwd', () => {
    assert.deepEqual(createSessionParams({ cwd: '/workspace' }), { cwd: '/workspace' })
  })

  it('includes agentPreset when provided', () => {
    assert.deepEqual(createSessionParams({ cwd: '/ws', preset: 'personal' }), { cwd: '/ws', agentPreset: 'personal' })
  })

  it('omits agentPreset when null', () => {
    const result = createSessionParams({ cwd: '/ws', preset: null })
    assert.equal('agentPreset' in result, false)
  })
})

describe('promptParams', () => {
  it('builds correct shape', () => {
    const result = promptParams('session-1', 'hello world')
    assert.deepEqual(result, {
      sessionId: 'session-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello world' }],
    })
  })
})

describe('cancelParams', () => {
  it('includes sessionId', () => {
    assert.deepEqual(cancelParams('s1'), { sessionId: 's1' })
  })
})

describe('historyParams', () => {
  it('includes sessionId', () => {
    assert.deepEqual(historyParams('s1'), { sessionId: 's1' })
  })
})

// ---- projection extraction ----

describe('extractProjectionUsage', () => {
  it('extracts usage from a per-key projection frame', () => {
    const frame: MuxFrame = {
      type: 'session/projection',
      sessionId: 's1',
      key: 'tokenUsage',
      value: { inputTokens: 100, outputTokens: 50 },
    }
    const result = extractProjectionUsage(frame)
    assert.ok(result)
    assert.equal(result.sessionId, 's1')
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 })
  })

  it('returns null for non-projection frames', () => {
    assert.equal(extractProjectionUsage({ type: 'session/event', sessionId: 's1' }), null)
  })

  it('returns null when the key is not tokenUsage', () => {
    assert.equal(
      extractProjectionUsage({ type: 'session/projection', sessionId: 's1', key: 'title', value: 'x' }),
      null,
    )
  })
})

describe('extractProjectionTitle', () => {
  it('extracts title from a per-key projection frame', () => {
    const frame: MuxFrame = {
      type: 'session/projection',
      sessionId: 's1',
      key: 'title',
      value: 'My Chat',
    }
    const result = extractProjectionTitle(frame)
    assert.ok(result)
    assert.equal(result.title, 'My Chat')
  })

  it('returns null for empty title', () => {
    assert.equal(
      extractProjectionTitle({ type: 'session/projection', sessionId: 's1', key: 'title', value: '' }),
      null,
    )
  })
})

// ---- question/approval mux frames → GatewayFrame ----

describe('questionRequestedFrame', () => {
  it('maps to question_asked with the envelope rpcId as questionId', () => {
    const result = questionRequestedFrame('rpc-1', {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'a', question: 'which?' }],
    })
    assert.deepEqual(result, {
      kind: 'question_asked',
      seq: 0,
      questionId: 'rpc-1',
      questions: [{ id: 'a', question: 'which?' }],
    })
  })
})

describe('questionResolvedFrame', () => {
  it('maps to question_resolved', () => {
    const result = questionResolvedFrame({
      type: 'question/resolved',
      sessionId: 's1',
      questionRpcId: 'rpc-1',
      outcome: 'answered',
    })
    assert.deepEqual(result, { kind: 'question_resolved', seq: 0, questionId: 'rpc-1', outcome: 'answered' })
  })
})

describe('approvalRequestedFrame', () => {
  it('maps to approval_pending carrying decisionId + approvalId', () => {
    const result = approvalRequestedFrame('rpc-9', {
      type: 'approval/requested',
      sessionId: 's1',
      approvalId: 'ap-1',
      toolName: 'write_file',
      reason: 'outside workspace',
    })
    assert.deepEqual(result, {
      kind: 'approval_pending',
      seq: 0,
      decisionId: 'rpc-9',
      approvalId: 'ap-1',
      toolName: 'write_file',
      reason: 'outside workspace',
    })
  })
})

describe('approvalResolvedFrame', () => {
  it('maps to approval_resolved with the supplied decisionId', () => {
    const result = approvalResolvedFrame({
      type: 'approval/resolved',
      sessionId: 's1',
      approvalId: 'ap-1',
      outcome: 'allowed-once',
    }, 'rpc-9')
    assert.deepEqual(result, {
      kind: 'approval_resolved',
      seq: 0,
      decisionId: 'rpc-9',
      approvalId: 'ap-1',
      outcome: 'allowed-once',
    })
  })

  it('keeps decisionId null when the request was never seen', () => {
    const result = approvalResolvedFrame({
      type: 'approval/resolved',
      sessionId: 's1',
      approvalId: 'ap-2',
      outcome: 'rejected',
    }, null)
    assert.equal(result.decisionId, null)
    assert.equal(result.outcome, 'rejected')
  })
})

// ---- history / session.list 解包 ----

describe('unwrapHistoryEvents', () => {
  it('unwraps the { event, view? } entries', () => {
    const events = [
      { event: { type: 'user/message', seq: 1, data: { id: 'a', content: [{ type: 'text', text: 'hi' }] } } },
      { event: { type: 'turn/start', seq: 2, data: { turn: 1 } }, view: null },
    ]
    const result = unwrapHistoryEvents({ events, hasMore: false })
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], events[0]!.event)
  })

  it('returns [] for malformed values', () => {
    assert.deepEqual(unwrapHistoryEvents(null), [])
    assert.deepEqual(unwrapHistoryEvents({}), [])
    assert.deepEqual(unwrapHistoryEvents({ events: 'nope' }), [])
  })
})

describe('mapSessionList', () => {
  it('maps items and reads title from projections.values.title', () => {
    const result = mapSessionList({
      items: [
        { sessionId: 's1', updatedAt: 111, running: false, blank: false, projections: { asOfSeq: 3, values: { title: 'Chat One' } } },
        { sessionId: 's2', updatedAt: 222, running: true, blank: true },
      ],
    })
    assert.deepEqual(result, [
      { sessionId: 's1', title: 'Chat One', updatedAt: 111, running: false, blank: false },
      { sessionId: 's2', updatedAt: 222, running: true, blank: true },
    ])
  })

  it('returns [] for malformed values', () => {
    assert.deepEqual(mapSessionList(null), [])
    assert.deepEqual(mapSessionList({ sessions: [] }), [])
  })
})
