// End-to-end smoke test against a running manager.
//
//   node scripts/smoke.mjs <password> [baseUrl]
//
// Checks auth boundaries, endpoint status degradation and the workspace adapter.
// Exits non-zero on the first hard failure so it can gate a deploy.

const password = process.argv[2]
const base = (process.argv[3] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '')
const username = process.env.MANAGER_USERNAME ?? 'admin'

if (password === undefined) {
  console.error('usage: node scripts/smoke.mjs <password> [baseUrl]')
  process.exit(2)
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures += 1
}
const info = (label, detail) => console.log(`      ${label}  ${detail}`)

const json = async (response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text.slice(0, 200) }
  }
}

const main = async () => {
  console.log(`\n-- auth boundaries --`)
  const root = await fetch(`${base}/`, { redirect: 'manual' })
  check('GET / redirects', root.status === 302, `-> ${root.headers.get('location')}`)

  const app = await fetch(`${base}/app`, { redirect: 'manual' })
  check('GET /app unauthenticated redirects to /login', app.status === 302 && app.headers.get('location') === '/login')

  const apiAnon = await fetch(`${base}/api/status`)
  check('GET /api/status unauthenticated is 401', apiAnon.status === 401)

  const bad = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'definitely-wrong' }),
  })
  check('wrong password is 401', bad.status === 401)

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  check('login succeeds', login.status === 200)
  if (login.status !== 200) {
    console.error('\ncannot continue without a session')
    process.exit(1)
  }

  const setCookie = login.headers.getSetCookie()
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const attrs = setCookie.join(' ')
  check('cookie is HttpOnly', attrs.includes('HttpOnly'))
  check('cookie is SameSite=Lax', /SameSite=Lax/i.test(attrs))

  const auth = { headers: { cookie } }

  console.log(`\n-- status --`)
  const status = await json(await fetch(`${base}/api/status`, auth))
  for (const ep of status.endpoints ?? []) {
    // An unreachable endpoint is a valid state, not a test failure: DSH may
    // simply not be running. What matters is that it degrades to one row.
    info(`endpoint ${ep.id}`, ep.reachable ? `reachable, sessions=${ep.sessions}, apiKeySet=${ep.apiKeySet}` : `unreachable (${ep.error})`)
  }
  check('at least one endpoint is configured', (status.endpoints ?? []).length > 0)
  check('at least one agent is configured', (status.agents ?? []).length > 0)

  console.log(`\n-- workspace adapter --`)
  for (const agent of status.agents ?? []) {
    const w = await json(await fetch(`${base}/api/agents/${agent.id}/workspace`, auth))
    info(`${agent.id} docs`, (w.docs ?? []).map((d) => `${d.name}=${d.present}`).join(' '))
    info(`${agent.id} note-data`, `${(w.noteData?.loaded ?? []).length}/5 loaded, keys=[${(w.noteData?.keys ?? []).join(',')}]`)
    info(`${agent.id} git`, `repo=${w.git?.isRepo} branch=${w.git?.branch} dirty=${(w.git?.dirty ?? []).length}`)
    if ((w.git?.dirty ?? []).length > 0) info(`${agent.id} dirty`, (w.git.dirty ?? []).join(', '))
    if (w.git?.lastCommit) info(`${agent.id} head`, `${w.git.lastCommit.hash} ${w.git.lastCommit.message.slice(0, 60)}`)

    check(`${agent.id}: no blockers`, (w.blockers ?? []).length === 0, (w.blockers ?? []).join(' | '))
    if ((w.violations ?? []).length > 0) {
      for (const v of w.violations) info(`${agent.id} violation`, `[${v.rule}] ${v.path} - ${v.detail.slice(0, 90)}`)
    } else {
      info(`${agent.id} violations`, 'none')
    }

    const nd = await json(await fetch(`${base}/api/agents/${agent.id}/notedata`, auth))
    const trade = nd.data?.trade
    if (trade !== undefined) {
      info(`${agent.id} trade`, `asOf=${trade.asOf} holdings=${trade.holdings?.length} history=${trade.history?.length}`)
      check(`${agent.id}: trade history within the documented cap of 8`, (trade.history?.length ?? 0) <= 8)
    }
    check(`${agent.id}: notedata returns parsed data`, nd.data !== undefined && Object.keys(nd.data).length > 0)
  }

  const unknown = await fetch(`${base}/api/agents/does-not-exist/workspace`, auth)
  check('unknown agent is 404', unknown.status === 404)

  console.log(`\n-- logout --`)
  const logout = await fetch(`${base}/api/logout`, { method: 'POST', ...auth })
  check('logout succeeds', logout.status === 200)
  const afterLogout = await fetch(`${base}/api/status`, auth)
  check('session is revoked server-side', afterLogout.status === 401)

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\nsmoke test could not run: ${error.message}`)
  process.exit(1)
})
