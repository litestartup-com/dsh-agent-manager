import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cancelQueuedTurn, cancelQueuedTurns, closeQueues, drainAgentQueue, enqueueTurn, queuedTurnsFor } from './queue.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('chat queue', () => {
  it('enqueues FIFO per agent and reports positions', () => {
    closeQueues()
    assert.equal(enqueueTurn('a', { chatId: 'c1', id: 't-c1', execute: async () => {} }), 1)
    assert.equal(enqueueTurn('a', { chatId: 'c2', id: 't-c2', execute: async () => {} }), 2)
    assert.equal(enqueueTurn('b', { chatId: 'c3', id: 't-c3', execute: async () => {} }), 1)
    assert.equal(queuedTurnsFor('a'), 2)
    assert.equal(queuedTurnsFor('b'), 1)
    closeQueues()
  })

  it('drains in order, one at a time, and continues after each turn', async () => {
    closeQueues()
    const order: string[] = []
    const make = (id: string) => async () => {
      order.push(id + ':start')
      await tick()
      order.push(id + ':end')
    }
    enqueueTurn('a', { chatId: 'c1', id: 't-c1', execute: make('one') })
    enqueueTurn('a', { chatId: 'c2', id: 't-c2', execute: make('two') })
    drainAgentQueue('a')
    await tick()
    await tick()
    await tick()
    await tick()
    assert.deepEqual(order, ['one:start', 'one:end', 'two:start', 'two:end'])
    assert.equal(queuedTurnsFor('a'), 0)
    closeQueues()
  })

  it('a concurrent drain call is a no-op', async () => {
    closeQueues()
    let runs = 0
    enqueueTurn('a', { chatId: 'c1', id: 't-c1', execute: async () => { runs += 1; await tick() } })
    drainAgentQueue('a')
    drainAgentQueue('a')
    drainAgentQueue('a')
    await tick()
    await tick()
    assert.equal(runs, 1)
    closeQueues()
  })

  it('cancelQueuedTurn drops one item by id and leaves the rest in order', async () => {
    closeQueues()
    const ran: string[] = []
    const make = (id: string) => async () => { ran.push(id) }
    enqueueTurn('a', { id: 't1', chatId: 'c1', execute: make('t1') })
    enqueueTurn('a', { id: 't2', chatId: 'c1', execute: make('t2') })
    enqueueTurn('a', { id: 't3', chatId: 'c2', execute: make('t3') })
    cancelQueuedTurn('c1', 't2')
    assert.equal(queuedTurnsFor('a'), 2)
    drainAgentQueue('a')
    await tick()
    await tick()
    await tick()
    assert.deepEqual(ran, ['t1', 't3'])
    closeQueues()
  })

  it('cancelQueuedTurns drops only the given chat', () => {
    closeQueues()
    enqueueTurn('a', { chatId: 'c1', id: 't-c1', execute: async () => {} })
    enqueueTurn('a', { chatId: 'c2', id: 't-c2', execute: async () => {} })
    enqueueTurn('b', { chatId: 'c1', id: 't-c1', execute: async () => {} })
    cancelQueuedTurns('c1')
    assert.equal(queuedTurnsFor('a'), 1)
    assert.equal(queuedTurnsFor('b'), 0)
    closeQueues()
  })
})