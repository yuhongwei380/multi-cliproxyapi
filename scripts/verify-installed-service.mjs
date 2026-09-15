import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const base = process.argv[2] || 'http://127.0.0.1:8787'
const sourceRoot = path.resolve(process.argv[3] || '/mnt/d/github/multi-cliproxyapi')
const installPort = 19317
assert.equal(new URL(base).origin, 'http://127.0.0.1:8787', 'only the isolated installed service is allowed')
let cookie = ''
const evidence = []
const record = name => { evidence.push(name); console.log(`PASS ${name}`) }

async function request(route, { method = 'GET', body, expected = 200, anonymous = false } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  const value = await response.json().catch(() => ({}))
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`)
  return { response, value }
}

async function instance(id) { return (await request(`/instances/${id}`)).value }
async function waitController() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/instances`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('installed controller did not become reachable after restart')
}
async function waitReady(id) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const value = await instance(id)
    if (value.status?.management_ready) return value
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`installed instance ${id} did not become ready`)
}

const login = await request('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' }, anonymous: true })
cookie = login.response.headers.get('set-cookie').split(';')[0]
const before = (await request('/instances')).value.items
assert.equal(before.length, 0, 'isolated install data must start without instances')
record('installed service authenticates with the expected cookie flow')

let created
try {
  created = (await request('/instances', { method: 'POST', body: { name: 'install-acceptance', port: installPort, management_password: 'install-child-secret' }, expected: 201 })).value
  await request(`/instances/${created.id}/start`, { method: 'POST', body: {}, expected: 202 })
  const started = await waitReady(created.id)
  const child = await fetch(`http://127.0.0.1:${installPort}/v0/management/auth-files`, { headers: { Authorization: 'Bearer install-child-secret' }, signal: AbortSignal.timeout(10000) })
  assert.equal(child.status, 200)
  record('installed controller creates and starts a real systemd-managed CPA')

  const installEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin` }
  execFileSync('sh', [path.join(sourceRoot, 'deploy', 'install.sh'), sourceRoot], { env: installEnv, stdio: 'inherit' })
  await waitController()
  const afterInstall = await waitReady(created.id)
  assert.equal(afterInstall.status.pid, started.status.pid)
  record('re-running install.sh preserves the running CPA PID and instance data')

  await request(`/instances/${created.id}/stop`, { method: 'POST', body: {}, expected: 202 })
  assert.equal((await instance(created.id)).status.state, 'stopped')
  record('installed service persists an explicit stopped intent')

  const challenge = (await request(`/instances/${created.id}/delete-challenge`, { method: 'POST', body: {} })).value
  await request(`/instances/${created.id}/delete`, { method: 'POST', body: { challenge_id: challenge.challenge_id, admin_password: 'admin' } })
  await request(`/instances/${created.id}`, { expected: 404 })
  record('installed service deletes only the test instance after a fresh challenge')
} finally {
  if (created) {
    try {
      const current = await instance(created.id)
      if (current.status?.state !== 'stopped') await request(`/instances/${created.id}/stop`, { method: 'POST', body: {}, expected: 202 })
      const challenge = (await request(`/instances/${created.id}/delete-challenge`, { method: 'POST', body: {} })).value
      await request(`/instances/${created.id}/delete`, { method: 'POST', body: { challenge_id: challenge.challenge_id, admin_password: 'admin' } })
    } catch {}
  }
}

console.log(JSON.stringify({ evidence }))
