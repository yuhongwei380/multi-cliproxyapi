import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ManagementAssets } from './management-assets.js'

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-assets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
test('management page downloads once, shares concurrent preparation and works offline from cache', async t => {
  const root = directory(t)
  let downloads = 0
  const assets = new ManagementAssets({ source: {
    latest: async () => ({ assets: [{ name: 'management.html' }] }),
    download: async () => { downloads++; return Buffer.from('<html><body>control panel</body></html>') }
  } })
  const files = await Promise.all([assets.ensure(root), assets.ensure(root)])
  assert.equal(downloads, 1)
  assert.equal(files[0], files[1])
  assets.source.latest = async () => { throw new Error('offline') }
  assert.equal(await assets.ensure(root), files[0])
  assert.match(fs.readFileSync(files[0], 'utf8'), /control panel/)
})
test('failed page download leaves no false cache and a retry succeeds', async t => {
  const root = directory(t)
  const source = {
    latest: async () => ({ assets: [{ name: 'management.html' }] }),
    download: async () => { throw new Error('network timeout') }
  }
  const assets = new ManagementAssets({ source })
  await assert.rejects(assets.ensure(root), error => error.status === 409 && /network timeout/.test(error.message))
  assert.deepEqual(fs.readdirSync(path.join(root, 'static')), [])
  source.download = async () => Buffer.from('<html>recovered</html>')
  assert.ok(await assets.ensure(root))
})
test('error documents and ambiguous release assets are rejected', async t => {
  const root = directory(t)
  const source = { latest: async () => ({ assets: [{ name: 'management.html' }] }), download: async () => Buffer.from('{"error":"gateway"}') }
  const assets = new ManagementAssets({ source })
  await assert.rejects(assets.ensure(root), /downloaded management page is invalid/)
  source.latest = async () => ({ assets: [{ name: 'management.html' }, { name: 'management.html' }] })
  await assert.rejects(assets.ensure(root), /one management.html/)
  assert.deepEqual(fs.readdirSync(path.join(root, 'static')), [])
})
