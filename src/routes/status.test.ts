import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig, ResolvedAgent } from '../config.js'
import { openDb, schema, type Db } from '../db/index.js'
import { GatewayClient } from '../gateway/client.js'
import { UpstreamClient } from '../upstream/client.js'
import { DEFAULT_PRICING } from '../pricing.js'
import { registerStatusRoutes } from './status.js'

/**
 * The agent detail aggregate.
 *
 * Two agents on one endpoint, and that endpoint deliberately dead: this is the
 * exact configuration the sidebar reports misleadingly (both dots red for one
 * broken DSH process), so it is the one the panel has to explain.
 */

const agentFor = (id: string, name: string, workspacePath: string, isPublic = false): ResolvedAgent => ({
  id,
  name,
  endpoint: 'A',
  workspacePath,
  public: isPublic,
  preset: null,
  gitRemote: null,
  provider: null,
  model: null,
})

const boot = (): { app: FastifyInstance; db: Db } => {
  const dir = mkdtempSync(join(tmpdir(), 'route-status-'))
  const workspace = mkdtempSync(join(tmpdir(), 'route-status-ws-'))
  const { db } = openDb(join(dir, 'test.db'))
  for (const id of ['personal', 'company']) {
    db.insert(schema.agent)
      .values({
        id,
        name: id,
        workspacePath: workspace,
        endpoint: 'A',
        preset: null,
        gitRemote: null,
        public: 0,
        createdAt: Date.now(),
      })
      .run()
  }

  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    // Port 1 is never listening, so health() fails the way a stopped DSH does.
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'gateway', prefix: '/api-gw/v1', key: 'k' } },
    agents: {
      personal: agentFor('personal', 'Personal', workspace),
      company: agentFor('company', 'Company', workspace),
    },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: ['endpoint "A" is shared by 2 agents (personal, company).'],
  }

  const app = Fastify()
  const clients = new Map([['A', new GatewayClient(config.endpoints.A!)]])
  registerStatusRoutes(app, config, db, clients, async () => undefined, new Map())
  return { app, db }
}

test('agent details name who else shares the endpoint', async () => {
  const { app } = boot()
  const response = await app.inject({ method: 'GET', url: '/api/agents/personal' })
  assert.equal(response.statusCode, 200)
  const body = response.json() as {
    agent: { id: string; name: string }
    endpoint: { reachable: boolean; error: string | null }
    sharedWith: { id: string; name: string }[]
    chats: { active: number; archived: number }
    month: { costMicroUsd: number; runs: number }
    runs: unknown[]
    warnings: string[]
  }

  assert.equal(body.agent.id, 'personal')
  // A dead endpoint is a reported state, not a 500: the panel exists to say why.
  assert.equal(body.endpoint.reachable, false)
  assert.ok(body.endpoint.error !== null, 'the reason the endpoint is unreachable is included')
  assert.deepEqual(
    body.sharedWith.map((a) => a.id),
    ['company'],
  )
  // The boot warning about a shared sandbox root has to be visible for as long
  // as it is true, not only in the log at startup.
  assert.equal(body.warnings.length, 1)
  assert.deepEqual(body.chats, { active: 0, archived: 0 })
  assert.equal(body.month.runs, 0)
  assert.deepEqual(body.runs, [])
  await app.close()
})

test('an agent that is not configured is a 404, not an empty panel', async () => {
  const { app } = boot()
  const response = await app.inject({ method: 'GET', url: '/api/agents/nope' })
  assert.equal(response.statusCode, 404)
  await app.close()
})

test('an apiproxy endpoint gets a row probed via host.describe, not /health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-status-apx-'))
  const workspace = mkdtempSync(join(tmpdir(), 'route-status-apx-ws-'))
  const { db } = openDb(join(dir, 'test.db'))
  const config: AppConfig = {
    listen: { host: '127.0.0.1', port: 0 },
    // Port 1 never listens: host.describe fails, and the row must still exist.
    endpoints: { A: { id: 'A', url: 'http://127.0.0.1:1', driver: 'apiproxy', prefix: '/api', key: '' } },
    agents: { personal: agentFor('personal', 'Personal', workspace) },
    runner: { timeoutMs: 10_000, silenceMs: 0, maxConsecutiveFailures: 3, dailyBudgetMicroUsd: null },
    databasePath: ':memory:',
    pricing: DEFAULT_PRICING,
    sessionSecret: 'x'.repeat(32),
    initialUser: { username: 'admin', password: null },
    warnings: [],
  }
  const app = Fastify()
  const upstream = new UpstreamClient(config.endpoints.A!)
  const upstreamClients = new Map([['A', upstream]])
  registerStatusRoutes(app, config, db, new Map(), async () => undefined, upstreamClients)

  const response = await app.inject({ method: 'GET', url: '/api/status' })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { endpoints: Array<{ id: string; driver: string; reachable: boolean; error: string | null }> }
  assert.equal(body.endpoints.length, 1)
  assert.equal(body.endpoints[0]!.id, 'A')
  assert.equal(body.endpoints[0]!.driver, 'apiproxy')
  assert.equal(body.endpoints[0]!.reachable, false)
  assert.ok(body.endpoints[0]!.error !== null, 'the unreachable reason is included')
  await app.close()
})
