import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareManagementPage, prepareInstanceBinary } from './instance-binary.js'

test('an existing binary still receives a missing cached management page', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-panel-repair-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const version = path.join(root, 'version')
  const instance = { directory: path.join(root, 'instance'), version: 'v1' }
  fs.mkdirSync(version)
  fs.mkdirSync(instance.directory)
  const binary = path.join(version, 'cli-proxy-api')
  fs.writeFileSync(binary, 'test binary')
  await prepareInstanceBinary(instance, () => binary)
  fs.mkdirSync(path.join(version, 'static'))
  fs.writeFileSync(path.join(version, 'static', 'management.html'), '<html>panel</html>')
  const result = await prepareInstanceBinary(instance, () => binary)
  assert.equal(result.changed, false)
  assert.equal(fs.readFileSync(path.join(instance.directory, 'static', 'management.html'), 'utf8'), '<html>panel</html>')
})

test('management page copy rejects a linked instance static directory', { skip: process.platform !== 'linux' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-panel-link-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const version = path.join(root, 'version')
  const instance = { directory: path.join(root, 'instance') }
  const outside = path.join(root, 'other-instance')
  fs.mkdirSync(path.join(version, 'static'), { recursive: true })
  fs.writeFileSync(path.join(version, 'static', 'management.html'), '<html>panel</html>')
  fs.mkdirSync(instance.directory)
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(instance.directory, 'static'))
  assert.throws(() => prepareManagementPage(instance, version), /unsafe/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('installed management page is copied independently and existing instance pages are preserved', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-panel-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const version = path.join(root, 'version')
  const instance = { directory: path.join(root, 'instance') }
  fs.mkdirSync(instance.directory)
  assert.equal(prepareManagementPage(instance, version), false)
  fs.mkdirSync(path.join(version, 'static'), { recursive: true })
  const source = path.join(version, 'static', 'management.html')
  fs.writeFileSync(source, '<html>installed panel</html>')
  assert.equal(prepareManagementPage(instance, version), true)
  const target = path.join(instance.directory, 'static', 'management.html')
  assert.equal(fs.readFileSync(target, 'utf8'), '<html>installed panel</html>')
  fs.writeFileSync(target, '<html>instance update</html>')
  assert.equal(prepareManagementPage(instance, version), false)
  assert.equal(fs.readFileSync(source, 'utf8'), '<html>installed panel</html>')
  assert.equal(fs.readFileSync(target, 'utf8'), '<html>instance update</html>')
})
