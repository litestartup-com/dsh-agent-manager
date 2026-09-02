import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMuxFrame, muxUrl } from './mux.js'

describe('muxUrl', () => {
  it('derives the WebSocket endpoint from an http base', () => {
    assert.equal(muxUrl('http://127.0.0.1:3080/api'), 'ws://127.0.0.1:3080/api/events.mux')
  })

  it('derives wss from https', () => {
    assert.equal(muxUrl('https://host.example/api'), 'wss://host.example/api/events.mux')
  })
})

describe('parseMuxFrame', () => {
  it('parses a server-request envelope', () => {
    const env = parseMuxFrame(JSON.stringify({
      type: 'server-request',
      rpcId: 'rpc-1',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/start', seq: 1, time: 0, data: {} } },
    }))
    assert.ok(env)
    assert.equal(env.type, 'server-request')
    assert.equal(env.rpcId, 'rpc-1')
    assert.equal(env.method, 'session/event')
    assert.equal(env.payload.sessionId, 's1')
  })

  it('returns null for server-response envelopes (wrong direction)', () => {
    assert.equal(parseMuxFrame(JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: null } })), null)
  })

  it('returns null for non-objects and malformed JSON', () => {
    assert.equal(parseMuxFrame('not json'), null)
    assert.equal(parseMuxFrame('"a string"'), null)
    assert.equal(parseMuxFrame('null'), null)
  })

  it('returns null when payload is missing', () => {
    assert.equal(parseMuxFrame(JSON.stringify({ type: 'server-request', rpcId: 'x', method: 'session/event' })), null)
  })
})
