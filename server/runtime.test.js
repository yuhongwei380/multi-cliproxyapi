import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { FakeRuntime, ProcessRuntime, SystemdRuntime } from './runtime.js'

test('systemd runtime builds non-interactive structured commands and parses states', async () => {
  const calls = []; const runtime = new SystemdRuntime({ runner: async args => { calls.push(args); if (args.includes('show')) return { stdout: 'ActiveState=active\nSubState=running\nMainPID=123\n' }; return { stdout: '' } } }); const item = { id: 'cpa-abc', version: 'v1' }
  await runtime.start(item); const status = await runtime.status(item); assert.equal(status.state, 'running'); assert.equal(status.ready, true); assert.equal(status.pid, 123); assert.deepEqual(calls[0], ['--no-ask-password', 'start', 'multi-cpa@cpa-abc.service'])
})

test('process runtime keeps detached child state across controller restarts', { skip: process.platform !== 'linux' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-process-runtime-')); const directory = path.join(root, 'instances', 'cpa-test'); fs.mkdirSync(path.join(directory, 'bin'), { recursive: true }); const binary = path.join(directory, 'bin', 'cli-proxy-api'); fs.writeFileSync(binary, '#!/bin/sh\n'); fs.chmodSync(binary, 0o755); const item = { id: 'cpa-test', version: 'v1', directory }; const children = new Map(); const alive = new Set(); const commands = new Map(); let nextPid = 3000
  const runtime = new ProcessRuntime({ spawnImpl: (binaryPath, args, options) => { const child = new EventEmitter(); child.pid = ++nextPid; child.unref = () => {}; children.set(child.pid, { binary: binaryPath, args, options }); alive.add(child.pid); commands.set(child.pid, `${binaryPath}\0--config\0${args[1]}\0`); queueMicrotask(() => child.emit('spawn')); return child }, isAliveImpl: pid => alive.has(pid), commandLineImpl: pid => commands.get(pid) || '', killImpl: (pid, signal) => { assert.equal(signal, 'SIGTERM'); alive.delete(pid) }, sleepImpl: async () => {} })
  await runtime.start(item); const pid = Number(fs.readFileSync(path.join(directory, '.multi-cpa.pid'), 'utf8')); assert.equal((await runtime.status(item)).pid, pid); assert.equal(children.get(pid).binary, binary); assert.deepEqual(children.get(pid).args, ['--config', path.join(directory, 'config.yaml')]); assert.equal(children.get(pid).options.detached, true); assert.deepEqual(children.get(pid).options.stdio, 'ignore'); const recovered = new ProcessRuntime({ isAliveImpl: value => alive.has(value), commandLineImpl: value => commands.get(value) || '', killImpl: () => alive.clear(), sleepImpl: async () => {} }); assert.equal((await recovered.status(item)).state, 'running'); await recovered.stop(item); assert.equal((await recovered.status(item)).state, 'stopped'); fs.rmSync(root, { recursive: true, force: true })
})

test('fake runtime is deterministic for lifecycle service tests', async () => {
  const runtime = new FakeRuntime(); const item = { id: 'cpa-test', version: 'v1' }; assert.equal((await runtime.status(item)).state, 'stopped'); await runtime.start(item); assert.equal((await runtime.status(item)).state, 'running'); await runtime.stop(item); assert.equal((await runtime.status(item)).state, 'stopped')
})

test('process stop retains PID and fails when SIGKILL has not confirmed exit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-stop-'))
  const item = { id: 'cpa-stop', directory, version: 'v1' }
  const signals = []
  const runtime = new ProcessRuntime({ timeoutMs: 0, isAliveImpl: () => true, commandLineImpl: () => `${directory}/bin/cli-proxy-api --config ${directory}/config.yaml`, killImpl: (_, signal) => signals.push(signal) })
  try {
    runtime.writePid(item, 12345)
    await assert.rejects(runtime.stop(item), /did not exit/)
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(runtime.readPid(item), 12345)
    assert.equal((await runtime.status(item)).state, 'running')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('systemd runtime rejects unsafe unit identifiers', async () => {
  const runtime = new SystemdRuntime({ runner: async () => ({}) }); await assert.rejects(() => runtime.start({ id: '../escape' }), /unsafe/)
})
