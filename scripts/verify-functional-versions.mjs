import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
assert.ok(root && path.basename(root).startsWith('.functional-test-'))
let cookie = ''
const evidence = []
async function api(route, body, expected) {
  const response = await fetch(`http://127.0.0.1:18787/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  const value = await response.json()
  if (expected) assert.equal(response.status, expected, JSON.stringify(value))
  else assert.ok(response.ok, `${route}: HTTP ${response.status} ${JSON.stringify(value)}`)
  if (route === '/auth/login') cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
const record = (name, detail = {}) => { evidence.push({ name, ...detail }); console.log(`PASS ${name}`) }
try {
  await api('/auth/login', { username: 'admin', password: 'admin' })
  const before = (await api('/instances')).items
  assert.ok(before.length && before.every(value => fs.existsSync(path.join(root, 'instances', value.id))))
  const original = before[0].version
  const version = process.env.TEST_CPA_VERSION || 'v7.2.158'
  const cached = (await api('/versions')).items.find(item => item.tag === version)
  const installed = cached || await api('/versions/install', { version })
  assert.equal(installed.tag, version)
  assert.match(installed.sha256, /^[a-f0-9]{64}$/)
  record(cached ? 'reuse previously installed official Linux asset' : 'official real Linux asset installation with checksum', { version, sha256: installed.sha256 })
  await api('/versions/install', { version }, 409)
  record('duplicate installation returns explicit conflict')
  await api('/versions/upgrade', { version })
  const after = (await api('/instances')).items
  assert.ok(after.every(value => value.version === version))
  for (const previous of before) {
    const current = after.find(value => value.id === previous.id)
    assert.equal(current.desired_state, previous.desired_state)
    if (previous.desired_state === 'stopped') assert.equal(current.status.state, 'stopped')
    else assert.notEqual(current.status.pid, previous.status.pid)
  }
  record('real unified switch preserves stopped intent and changes running PID')
  const created = await api('/instances', { name: 'accept-after-upgrade', port: 18324 })
  assert.equal(created.version, version)
  record('creation after upgrade selects current version')
  await api('/versions/upgrade', { version: original })
  assert.ok((await api('/instances')).items.every(value => value.version === original))
  record('real rollback to original installed version')
} finally { fs.writeFileSync(path.join(root, 'version-evidence.json'), JSON.stringify({ timestamp: new Date().toISOString(), evidence }, null, 2)) }
