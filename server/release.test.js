import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { GitHubSource, Installer, UpgradeService, UpgradeState } from './release.js'
import { Store } from './store.js'
import { openSecretStore } from './security.js'
import { FakeRuntime, NoopUnitManager } from './runtime.js'
import { InstanceService } from './services.js'
import { instanceBinaryPath } from './instance-binary.js'

const trustedAsset = 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v1.0.0/CLIProxyAPI_1.0.0_linux_amd64.tar.gz'

test('upgrade resource preparation failure leaves running processes and versions untouched', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    const before = await f.runtime.status(f.first)
    const prepared = []
    f.upgrade.prepareVersion = async version => {
      prepared.push(version)
      if (version === 'v2') throw new Error('management resource unavailable')
    }
    let stops = 0
    f.runtime.stop = async () => { stops++; throw new Error('must not stop') }
    await assert.rejects(f.upgrade.upgrade('v2'), /management resource unavailable/)
    assert.deepEqual(prepared, ['v1', 'v2'])
    assert.equal(stops, 0)
    assert.deepEqual(await f.runtime.status(f.first), before)
    assert.ok(f.store.listInstances().every(item => item.version === 'v1'))
    assert.throws(() => f.store.getUpgradeState(), /not found/)
  } finally { f.close() }
})

test('creation after a unified upgrade uses the active instance version', async () => {
  const f = await upgradeFixture()
  try {
    await f.upgrade.upgrade('v2')
    const created = await f.instances.create({ name: 'after-upgrade', port: await freePort() })
    assert.equal(created.version, 'v2')
  } finally { f.close() }
})

test('duplicate version installation reports conflict without downloading again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-duplicate-'))
  let downloads = 0
  fs.mkdirSync(path.join(root, 'v1'))
  const installer = new Installer({ root, source: { byTag: async () => ({ tag: 'v1', assets: [{ name: 'CLIProxyAPI_linux_amd64.tar.gz' }] }), download: async () => { downloads++; throw new Error('network unavailable') } } })
  try {
    await assert.rejects(installer.install('v1'), error => error.status === 409 && /already installed/.test(error.message))
    assert.equal(downloads, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('blocked upgrades prevent ordinary start, restart and desired-state recovery', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    f.runtime.failStop = true
    await assert.rejects(f.upgrade.upgrade('v2'))
    assert.equal(f.store.getUpgradeState().state, 'blocked')
    f.runtime.failStop = false
    await f.runtime.stop(f.first)
    await assert.rejects(f.instances.start(f.second.id), /upgrade state is blocked/)
    await assert.rejects(f.instances.restart(f.first.id), /upgrade state is blocked/)
    await assert.rejects(f.instances.reconcileDesired(), /upgrade state is blocked/)
    assert.equal((await f.runtime.status(f.first)).state, 'stopped')
  } finally { f.close() }
})

test('rollback does not replace binaries or versions until all new processes have stopped', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    await f.upgrade.upgrade('v2')
    f.runtime.failStop = true
    const state = { id: 'singleton', state: 'starting-new', old_version: 'v1', new_version: 'v2', original_running: [f.first.id], original_desired: {}, instance_stages: {}, message: '', updated_at: new Date().toISOString() }
    await f.upgrade.rollback(state, [f.first, f.second], new Error('test interrupted switch'))
    assert.equal(f.store.getUpgradeState().state, 'blocked')
    assert.equal(f.store.getInstance(f.first.id).version, 'v2')
    assert.equal(fs.readFileSync(instanceBinaryPath(f.first), 'utf8'), 'binary-v2')
    f.runtime.failStop = false
    await f.upgrade.recover()
    assert.equal(f.store.getInstance(f.first.id).version, 'v1')
    assert.equal((await f.runtime.status(f.first)).version, 'v1')
  } finally { f.close() }
})

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port
      server.close(() => resolve(value))
    })
  })
}

async function upgradeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-upgrade-'))
  const store = new Store(path.join(root, 'control.db'))
  const secrets = openSecretStore(path.join(root, 'secrets.key'))
  const binaries = new Map()
  for (const version of ['v1', 'v2']) {
    const file = path.join(root, 'versions', version, 'cli-proxy-api')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `binary-${version}`)
    fs.chmodSync(file, 0o755)
    binaries.set(version, file)
    store.saveVersion({ tag: version, asset: `${version}.tar.gz`, path: file, sha256: '', installed_at: new Date().toISOString(), usable: true })
  }
  const baseRuntime = new FakeRuntime()
  const runtime = {
    failNewStart: false,
    failOldStart: false,
    failStop: false,
    start: async instance => {
      if (runtime.failNewStart && instance.version === 'v2') throw new Error('new version failed to start')
      if (runtime.failOldStart && instance.version === 'v1') throw new Error('old version failed to start')
      return baseRuntime.start(instance)
    },
    stop: async instance => {
      if (runtime.failStop) throw new Error('old instance refused to stop')
      return baseRuntime.stop(instance)
    },
    restart: baseRuntime.restart.bind(baseRuntime),
    status: baseRuntime.status.bind(baseRuntime),
    unregister: baseRuntime.unregister.bind(baseRuntime)
  }
  const instances = new InstanceService({ store, runtime, secrets, units: new NoopUnitManager(), root, binaryByVersion: version => binaries.get(version), defaultVersion: 'v1', requireVersion: false })
  const first = await instances.create({ name: 'running', port: await freePort() })
  const second = await instances.create({ name: 'stopped', port: await freePort() })
  const upgrade = new UpgradeService({ store, instances, runtime })
  return {
    root, store, runtime, baseRuntime, instances, upgrade, first, second,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
  }
}

test('GitHub release source only downloads bounded assets from the configured repository', async () => {
  let calls = 0
  const source = new GitHubSource({ maxAssetBytes: 4, fetchImpl: async () => { calls += 1; return new Response('test', { status: 200, headers: { 'content-length': '4' } }) } })
  assert.equal((await source.download({ url: trustedAsset, size: 4, digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' })).toString(), 'test')
  await assert.rejects(() => source.download({ url: trustedAsset, size: 4, digest: `sha256:${'0'.repeat(64)}` }), /digest mismatch/)
  await assert.rejects(() => source.download({ url: 'http://127.0.0.1/internal', size: 1 }), /not trusted/)
  await assert.rejects(() => source.download({ url: trustedAsset, size: 5 }), /size.*limit/)
  assert.equal(calls, 2)

  let redirectCalls = 0
  const redirectSource = new GitHubSource({ fetchImpl: async () => {
    redirectCalls += 1
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } })
  } })
  await assert.rejects(() => redirectSource.download({ url: trustedAsset, size: 0 }), /untrusted host/)
  assert.equal(redirectCalls, 1)
})

test('GitHub release metadata is bounded and Linux installs reject ZIP assets', async () => {
  const payload = { tag_name: 'v1.0.0', assets: [{ name: 'CLIProxyAPI_1.0.0_linux_amd64.zip', browser_download_url: trustedAsset.replace(/\.tar\.gz$/, '.zip'), size: 4 }] }
  const source = new GitHubSource({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) })
  assert.equal((await source.latest()).tag, '1.0.0')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-release-')); const installer = new Installer({ source, root })
  await assert.rejects(() => installer.install(), /no supported Linux amd64 asset/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('Linux installer accepts regular tar entries and rejects symlinks', { skip: process.platform !== 'linux' }, async () => {
  const working = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-tar-'))
  try {
    const payload = path.join(working, 'payload'); fs.mkdirSync(payload)
    fs.writeFileSync(path.join(payload, 'cli-proxy-api'), '#!/bin/sh\n')
    const safeArchive = path.join(working, 'safe.tar.gz')
    execFileSync('tar', ['-czf', safeArchive, '-C', payload, 'cli-proxy-api'])
    const source = {
      latest: async () => ({ tag: '1.0.0', assets: [{ name: 'CLIProxyAPI_1.0.0_linux_amd64.tar.gz', size: fs.statSync(safeArchive).size }] }),
      download: async () => fs.readFileSync(safeArchive)
    }
    const installed = await new Installer({ source, root: path.join(working, 'versions') }).install()
    assert.equal(fs.statSync(path.join(installed.path, 'cli-proxy-api')).isFile(), true)

    const linkedPayload = path.join(working, 'linked'); fs.mkdirSync(linkedPayload)
    fs.symlinkSync('/etc/passwd', path.join(linkedPayload, 'cli-proxy-api'))
    const linkedArchive = path.join(working, 'linked.tar.gz')
    execFileSync('tar', ['-czf', linkedArchive, '-C', linkedPayload, 'cli-proxy-api'])
    const linkedSource = {
      latest: async () => ({ tag: '2.0.0', assets: [{ name: 'CLIProxyAPI_2.0.0_linux_amd64.tar.gz', size: fs.statSync(linkedArchive).size }] }),
      download: async () => fs.readFileSync(linkedArchive)
    }
    await assert.rejects(() => new Installer({ source: linkedSource, root: path.join(working, 'linked-versions') }).install(), /special or link entry/)
  } finally {
    fs.rmSync(working, { recursive: true, force: true })
  }
})

test('unified upgrade stops old instances, preserves stopped intent, and starts one new version', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    await f.upgrade.upgrade('v2')
    const items = f.store.listInstances()
    assert.deepEqual(items.map(item => item.version), ['v2', 'v2'])
    assert.equal(items[0].desired_state, 'running')
    assert.equal(items[1].desired_state, 'stopped')
    assert.equal((await f.instances.status(f.first.id)).state, 'running')
    assert.equal((await f.instances.status(f.second.id)).state, 'stopped')
    assert.equal(fs.readFileSync(instanceBinaryPath(items[0]), 'utf8'), 'binary-v2')
    assert.equal(fs.readFileSync(instanceBinaryPath(items[1]), 'utf8'), 'binary-v2')
    assert.throws(() => f.store.getUpgradeState(), /upgrade state not found/)
  } finally { f.close() }
})

test('unified upgrade blocks before switching when an old instance will not stop', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    f.runtime.failStop = true
    await assert.rejects(() => f.upgrade.upgrade('v2'), /old instance refused to stop/)
    assert.equal(f.store.getUpgradeState().state, UpgradeState.BLOCKED)
    assert.ok(f.store.listInstances().every(item => item.version === 'v1'))
    assert.equal((await f.instances.status(f.first.id)).state, 'running')
  } finally { f.close() }
})

test('unified upgrade rolls back old binaries when a new instance fails to start', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    f.runtime.failNewStart = true
    await assert.rejects(() => f.upgrade.upgrade('v2'), /new version failed to start/)
    assert.equal(f.store.getUpgradeState().state, UpgradeState.ROLLED_BACK)
    assert.ok(f.store.listInstances().every(item => item.version === 'v1'))
    assert.equal((await f.instances.status(f.first.id)).state, 'running')
    assert.equal((await f.instances.status(f.second.id)).state, 'stopped')
  } finally { f.close() }
})

test('unified upgrade enters blocked state when restoring the old process fails', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    f.runtime.failNewStart = true
    f.runtime.failOldStart = true
    await assert.rejects(() => f.upgrade.upgrade('v2'), /new version failed to start/)
    assert.equal(f.store.getUpgradeState().state, UpgradeState.BLOCKED)
    assert.ok(f.store.listInstances().every(item => item.version === 'v1'))
    assert.equal((await f.instances.status(f.first.id)).state, 'stopped')
  } finally { f.close() }
})

test('recovering an interrupted upgrade restores the old version and desired states', async () => {
  const f = await upgradeFixture()
  try {
    await f.instances.start(f.first.id)
    for (const item of f.store.listInstances()) {
      const upgraded = { ...item, version: 'v2', revision: item.revision + 1 }
      f.store.updateInstance(upgraded, item.revision)
    }
    f.store.saveUpgradeState({ id: 'singleton', state: UpgradeState.STARTING_NEW, old_version: 'v1', new_version: 'v2', original_running: [f.first.id], original_desired: { [f.first.id]: 'running', [f.second.id]: 'stopped' }, instance_stages: {}, message: '', updated_at: new Date().toISOString() })
    await f.upgrade.recover()
    assert.equal(f.store.getUpgradeState().state, UpgradeState.ROLLED_BACK)
    assert.ok(f.store.listInstances().every(item => item.version === 'v1'))
    assert.equal((await f.instances.status(f.first.id)).state, 'running')
    assert.equal((await f.instances.status(f.second.id)).state, 'stopped')
  } finally { f.close() }
})
