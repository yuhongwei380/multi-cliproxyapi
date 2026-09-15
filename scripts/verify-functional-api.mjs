import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// Only the dedicated acceptance server is allowed. Never target port 8787.
const base = 'http://127.0.0.1:18787'
const root = process.argv[2]
assert.ok(root && path.basename(root).startsWith('.functional-test-'), 'dedicated test directory required')
assert.ok(fs.existsSync(path.join(root, 'control.db')))
let cookie = ''
const evidence = []
const record = (name, detail = {}) => { evidence.push({ name, ...detail }); console.log(`PASS ${name}`) }
async function api(route, { method = 'GET', body, expected = 200, headers = {}, anonymous = false } = {}) {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) })
  const value = await response.json()
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(value)}`)
  return { value, response }
}
const post = (route, body = {}, expected = 200) => api(route, { method: 'POST', body, expected })
const item = async id => (await api(`/instances/${id}`)).value
async function ready(id) {
  for (let i = 0; i < 40; i++) { const value = await item(id); if (value.status.management_ready) return value; await new Promise(resolve => setTimeout(resolve, 250)) }
  throw new Error(`instance ${id} management did not become ready`)
}
try {
  await api('/instances', { anonymous: true, expected: 401 })
  const login = await post('/auth/login', { username: 'admin', password: 'admin' })
  cookie = login.response.headers.get('set-cookie').split(';')[0]
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  let existing = (await api('/instances')).value.items
  assert.ok(existing.every(value => value.name.startsWith('win-') || value.name.startsWith('accept-')), 'refusing non-test instances')
  for (const previous of existing.filter(value => value.name.startsWith('accept-'))) {
    assert.ok(fs.existsSync(path.join(root, 'instances', previous.id)), 'server and data directory mismatch')
    const challenge = (await post(`/instances/${previous.id}/delete-challenge`)).value
    await post(`/instances/${previous.id}/delete`, { challenge_id: challenge.challenge_id, admin_password: 'admin' })
  }
  existing = (await api('/instances')).value.items
  assert.equal(existing.length, 1, 'start from the browser-created test instance')
  record('authentication, cookie flags, isolated inventory')
  await api('/instances', { method: 'POST', body: {}, headers: { Origin: 'https://example.invalid' }, expected: 403 })
  await post('/instances', { name: '../escape', port: 18318 }, 400)
  await post('/instances', { name: 'accept-invalid-port', port: 80 }, 400)
  await post('/instances', { name: existing[0].name.toUpperCase(), port: 18318 }, 409)
  await post('/instances', { name: 'accept-duplicate-port', port: 18317 }, 409)
  record('cross-origin, invalid fields, duplicate names and ports rejected')
  const created = []
  for (let i = 0; i < 4; i++) created.push((await post('/instances', { name: `accept-${i}`, port: 18318 + i, management_password: i === 0 ? 'accept-child-secret' : '' }, 201)).value)
  await post('/instances', { name: 'accept-sixth', port: 18322 }, 409)
  assert.equal((await api('/instances')).value.items.length, 5)
  const binaries = [existing[0], ...created].map(value => path.join(root, 'instances', value.id, 'bin', 'cli-proxy-api'))
  for (const file of binaries) assert.ok(fs.statSync(file).size > 1000000)
  record('five-instance limit and independent real binary files')
  const target = created[0]
  await post(`/instances/${target.id}/start`, {}, 202)
  const started = await ready(target.id)
  let response = await fetch('http://127.0.0.1:18318/v0/management/auth-files', { headers: { Authorization: 'Bearer accept-child-secret' } })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).files, [])
  await post(`/instances/${target.id}/restart`, {}, 202)
  const restarted = await ready(target.id)
  assert.notEqual(restarted.status.pid, started.status.pid)
  record('real start, custom management password, restart changes PID', { old_pid: started.status.pid, new_pid: restarted.status.pid })
  await api(`/instances/${target.id}`, { method: 'PATCH', body: { name: 'accept-renamed', expected_revision: target.revision }, expected: 409 })
  await api(`/instances/${target.id}`, { method: 'PATCH', body: { name: 'accept-renamed', port: 18323, management_password: '', expected_revision: restarted.revision } })
  const updated = await ready(target.id)
  assert.equal(updated.port, 18323)
  response = await fetch('http://127.0.0.1:18323/v0/management/auth-files', { headers: { Authorization: 'Bearer accept-child-secret' } })
  assert.equal(response.status, 200)
  record('optimistic conflict, live port update, blank password preserves secret')
  await post(`/instances/${target.id}/quotas`, {}, 202)
  assert.equal((await api(`/instances/${target.id}/quotas`)).value.items[0].status, 'empty')
  await post(`/instances/${target.id}/stop`, {}, 202)
  assert.equal((await item(target.id)).status.state, 'stopped')
  await post(`/instances/${target.id}/quotas`, {}, 409)
  assert.equal((await api(`/instances/${target.id}/quotas`)).value.items[0].status, 'failed')
  await post(`/instances/${target.id}/start`, {}, 202)
  await ready(target.id)
  await post(`/instances/${target.id}/quotas`, {}, 202)
  assert.equal((await api(`/instances/${target.id}/quotas`)).value.items[0].status, 'empty')
  record('quota empty versus connection failure and recovery')
  await api('/quota/settings', { method: 'PATCH', body: { refresh_interval_minutes: 1, alert_threshold_percent: 12.5 } })
  assert.equal((await api('/quota/settings')).value.refresh_interval_minutes, 1)
  await api('/quota/settings', { method: 'PATCH', body: { refresh_interval_minutes: 0 }, expected: 400 })
  await api('/quota/settings', { method: 'PATCH', body: { webhook_url: 'http://127.0.0.1/robot/send?access_token=test' }, expected: 400 })
  record('quota settings persist and invalid values are rejected')
  const challenge = (await post(`/instances/${target.id}/delete-challenge`)).value
  await post(`/instances/${target.id}/delete`, { challenge_id: challenge.challenge_id, admin_password: 'wrong-test-password' }, 401)
  assert.ok(fs.existsSync(path.join(root, 'instances', target.id)))
  await api(`/instances/${target.id}`, { method: 'PATCH', body: { name: 'accept-revision-change', expected_revision: (await item(target.id)).revision } })
  await post(`/instances/${target.id}/delete`, { challenge_id: challenge.challenge_id, admin_password: 'admin' }, 409)
  const fresh = (await post(`/instances/${target.id}/delete-challenge`)).value
  await post(`/instances/${target.id}/delete`, { challenge_id: fresh.challenge_id, admin_password: 'admin' })
  assert.equal(fs.existsSync(path.join(root, 'instances', target.id)), false)
  await api(`/instances/${target.id}`, { expected: 404 })
  assert.ok(fs.existsSync(binaries[0]))
  record('delete rejects wrong password and stale revision; running instance deleted with isolation')
  await api('/auth/password', { method: 'PATCH', body: { current_password: 'wrong-test-password', new_password: 'accept-admin-secret' }, expected: 401 })
  await api('/auth/password', { method: 'PATCH', body: { current_password: 'admin', new_password: 'accept-admin-secret' } })
  await post('/auth/login', { username: 'admin', password: 'admin' }, 401)
  await post('/auth/login', { username: 'admin', password: 'accept-admin-secret' })
  await api('/auth/password', { method: 'PATCH', body: { current_password: 'accept-admin-secret', new_password: 'admin' } })
  record('administrator password change, old rejection, new login, original restored')
  const audit = (await api('/logs/audit?limit=500')).value.items
  assert.ok(audit.some(value => value.outcome === 'failed'))
  assert.ok(audit.some(value => value.outcome === 'success'))
  const logs = JSON.stringify({ audit, runtime: (await api('/logs/runtime?limit=500')).value })
  for (const secret of ['accept-child-secret', 'accept-admin-secret', 'wrong-test-password']) assert.equal(logs.includes(secret), false)
  await api('/logs/runtime?limit=501', { expected: 400 })
  await post('/auth/logout')
  await api('/instances', { expected: 401 })
  record('audit outcomes, secret exclusion, log bounds and logout revocation')
} finally {
  fs.writeFileSync(path.join(root, 'api-evidence.json'), JSON.stringify({ timestamp: new Date().toISOString(), evidence }, null, 2))
}
