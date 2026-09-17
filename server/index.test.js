import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { DEFAULT_ADMIN_PASSWORD, readConfig, start } from './index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('controller defaults the first administrator password to admin and accepts an override', () => {
  assert.equal(DEFAULT_ADMIN_PASSWORD, 'admin')
  assert.equal(readConfig([], {}).adminPassword, 'admin')
  assert.equal(readConfig([], { MULTI_CPA_ADMIN_PASSWORD: 'custom-initial-password' }).adminPassword, 'custom-initial-password')
})

test('controller defaults to info logging and accepts a custom level and file', () => {
  assert.equal(readConfig([], {}).logLevel, 'info')
  assert.equal(readConfig([], { MULTI_CPA_LOG_LEVEL: 'DEBUG', MULTI_CPA_LOG_FILE: '/tmp/multi-cpa.log' }).logLevel, 'debug')
  assert.equal(readConfig([], { MULTI_CPA_LOG_LEVEL: 'DEBUG', MULTI_CPA_LOG_FILE: '/tmp/multi-cpa.log' }).logFile, '/tmp/multi-cpa.log')
  assert.throws(() => readConfig([], { MULTI_CPA_LOG_LEVEL: 'verbose' }), /debug, info, warn, error/)
})

test('relative data directories resolve before preparing absolute CPA executable paths', () => {
  assert.equal(readConfig(['--data-dir', './testdata'], {}).dataDir, path.resolve('testdata'))
  assert.equal(readConfig([], { MULTI_CPA_DATA_DIR: './testdata' }).dataDir, path.resolve('testdata'))
})

test('configured preinstalled CPA version is registered when its metadata is absent', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-pinned-version-'))
  const versionDir = path.join(root, 'versions', 'v1')
  fs.mkdirSync(versionDir, { recursive: true })
  const binary = path.join(versionDir, 'cli-proxy-api')
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  let app
  try {
    app = await start({ ...readConfig([], {}), dataDir: root, listen: `127.0.0.1:${port}`, runtimeMode: 'process', version: 'v1', skipVersionInstall: true })
    assert.equal(app.instances.defaultVersion, 'v1')
    assert.deepEqual(app.store.getVersion('v1'), { tag: 'v1', asset: '', path: versionDir, sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), installed_at: app.store.getVersion('v1').installed_at, usable: true })
  } finally {
    await app?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('occupied listen port exits promptly without leaving a quota scheduler alive', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-bind-'))
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [new URL('./index.js', import.meta.url).pathname, '--data-dir', root, '--listen', `127.0.0.1:${listener.address().port}`, '--runtime', 'process'], { timeout: 4000, env: { ...process.env, MULTI_CPA_SKIP_VERSION_INSTALL: 'true' } }), error => error.code === 1 && /EADDRINUSE/.test(error.stderr))
  } finally { await new Promise(resolve => listener.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) }
})

test('controller close is idempotent and removes signal handlers', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-close-'))
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const signals = process.listenerCount('SIGTERM')
  try {
    const app = await start({ ...readConfig([], {}), dataDir: root, listen: `127.0.0.1:${port}`, skipVersionInstall: true, runtimeMode: 'process' })
    await Promise.all([app.close(), app.close()])
    assert.equal(process.listenerCount('SIGTERM'), signals)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
