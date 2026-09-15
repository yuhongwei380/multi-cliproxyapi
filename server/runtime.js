import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { ObservedState } from './domain.js'
import { instanceBinaryPath } from './instance-binary.js'

const execFileAsync = promisify(execFile)
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)

export class SystemdRuntime {
  constructor({ unitPrefix = 'multi-cpa', timeoutMs = 30000, runner = null } = {}) {
    if (!safe(unitPrefix)) throw new Error('unit prefix contains unsafe characters')
    this.unitPrefix = unitPrefix
    this.timeoutMs = timeoutMs
    this.runner = runner
  }
  unit(instance) {
    if (!safe(instance.id)) throw new Error('instance id contains unsafe characters')
    return `${this.unitPrefix}@${instance.id}.service`
  }
  async command(args, signal) {
    const commandArgs = ['--no-ask-password', ...args]
    if (this.runner) {
      const result = await this.runner(commandArgs, signal)
      if (result?.error) throw new Error(`systemctl ${commandArgs.join(' ')}: ${result.error}${result.output ? ` (${result.output})` : ''}`)
      return String(result?.stdout ?? result?.output ?? '')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const result = await execFileAsync('systemctl', commandArgs, { signal: controller.signal, maxBuffer: 1024 * 1024 })
      return result.stdout || ''
    } catch (error) {
      const output = String(error.stderr || error.stdout || '').trim()
      throw new Error(`systemctl --no-ask-password ${args.join(' ')}: ${error.message}${output ? ` (${output})` : ''}`)
    } finally { clearTimeout(timer) }
  }
  async start(instance, signal) { await this.command(['start', this.unit(instance)], signal) }
  async stop(instance, signal) { await this.command(['stop', this.unit(instance)], signal) }
  async restart(instance, signal) { await this.command(['restart', this.unit(instance)], signal) }
  async unregister(instance, signal) { await this.command(['disable', this.unit(instance)], signal) }
  async status(instance, signal) {
    const id = instance.id
    try {
      const output = await this.command(['show', this.unit(instance), '--property=ActiveState,SubState,MainPID'], signal)
      let active = ''; let sub = ''; let pid = 0
      for (const line of output.split(/\r?\n/)) {
        const [key, ...rest] = line.trim().split('='); const value = rest.join('=')
        if (key === 'ActiveState') active = value
        if (key === 'SubState') sub = value
        if (key === 'MainPID') pid = Number(value) || 0
      }
      let state = ObservedState.UNKNOWN; let ready = false
      if (active === 'active') { state = ObservedState.RUNNING; ready = true }
      else if (active === 'inactive' || active === 'dead') state = ObservedState.STOPPED
      else if (active === 'activating' || active === 'reloading') state = ObservedState.STARTING
      else if (active === 'deactivating') state = ObservedState.STOPPING
      else if (active === 'failed') state = ObservedState.FAILED
      if (sub === 'start') { state = ObservedState.STARTING; ready = false }
      if (sub === 'stop') { state = ObservedState.STOPPING; ready = false }
      return { instance_id: id, state, ready, pid, version: instance.version || '' }
    } catch (error) {
      return { instance_id: id, state: ObservedState.UNKNOWN, ready: false, version: instance.version || '', message: error.message }
    }
  }
}

const processSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/**
 * Linux-only fallback used by start.sh when the source tree is run without
 * the packaged systemd units (for example, a WSL development environment).
 * The child is detached and its pid is persisted, so stopping the controller
 * does not stop an already running CPA process.
 */
export class ProcessRuntime {
  constructor({ timeoutMs = 30000, spawnImpl = spawnProcess, killImpl = process.kill.bind(process), isAliveImpl = null, commandLineImpl = null, sleepImpl = processSleep } = {}) {
    this.timeoutMs = timeoutMs
    this.spawnImpl = spawnImpl
    this.killImpl = killImpl
    this.isAliveImpl = isAliveImpl
    this.commandLineImpl = commandLineImpl
    this.sleepImpl = sleepImpl
    this.pids = new Map()
  }
  pidFile(instance) { return path.join(instance.directory, '.multi-cpa.pid') }
  readPid(instance) {
    try {
      const value = Number(fs.readFileSync(this.pidFile(instance), 'utf8').trim())
      return Number.isSafeInteger(value) && value > 0 ? value : 0
    } catch { return 0 }
  }
  writePid(instance, pid) { fs.writeFileSync(this.pidFile(instance), `${pid}\n`, { mode: 0o600 }); fs.chmodSync(this.pidFile(instance), 0o600) }
  clearPid(instance) { try { fs.unlinkSync(this.pidFile(instance)) } catch (error) { if (error.code !== 'ENOENT') throw error } this.pids.delete(instance.id) }
  async binary(instance) {
    const binary = instanceBinaryPath(instance)
    if (!path.isAbsolute(binary)) throw new Error('process runtime binary path is invalid')
    try {
      const info = fs.lstatSync(binary)
      if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw new Error('instance binary is not executable')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('instance binary is missing')
      throw error
    }
    return binary
  }
  async alive(pid) {
    if (this.isAliveImpl) return Boolean(await this.isAliveImpl(pid))
    try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
  }
  async commandLine(pid) {
    if (this.commandLineImpl) return String(await this.commandLineImpl(pid) || '')
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') } catch { return '' }
  }
  async owns(instance, pid) {
    const command = await this.commandLine(pid)
    if (command) return command.includes(instance.directory)
    return this.pids.get(instance.id) === pid
  }
  async status(instance) {
    const pid = this.readPid(instance) || this.pids.get(instance.id) || 0
    if (!pid || !(await this.alive(pid))) { this.clearPid(instance); return { instance_id: instance.id, state: ObservedState.STOPPED, ready: false, pid: 0, version: instance.version || '' } }
    if (!(await this.owns(instance, pid))) { this.clearPid(instance); return { instance_id: instance.id, state: ObservedState.STOPPED, ready: false, pid: 0, version: instance.version || '' } }
    this.pids.set(instance.id, pid)
    return { instance_id: instance.id, state: ObservedState.RUNNING, ready: true, pid, version: instance.version || '' }
  }
  async start(instance) {
    const current = await this.status(instance)
    if ([ObservedState.RUNNING, ObservedState.STARTING].includes(current.state)) return
    const binary = await this.binary(instance)
    const config = path.join(instance.directory, 'config.yaml')
    let child
    try {
      child = this.spawnImpl(binary, ['--config', config], { cwd: instance.directory, detached: true, stdio: 'ignore' })
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error = null) => { if (settled) return; settled = true; error ? reject(error) : resolve() }
        if (typeof child.once === 'function') { child.once('spawn', () => finish()); child.once('error', finish) } else finish()
      })
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('process runtime did not return a pid')
      child.unref?.()
      this.writePid(instance, child.pid)
      this.pids.set(instance.id, child.pid)
    } catch (error) { throw new Error(`start local CPA process: ${error.message}`) }
  }
  async stop(instance) {
    const current = await this.status(instance)
    if (current.state === ObservedState.STOPPED) return
    const pid = current.pid
    if (await this.owns(instance, pid)) {
      try { this.killImpl(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw new Error(`stop local CPA process: ${error.message}`) }
      const deadline = Date.now() + this.timeoutMs
      while (await this.alive(pid) && Date.now() < deadline) await this.sleepImpl(100)
      if (await this.alive(pid)) {
        try { this.killImpl(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw new Error(`kill local CPA process: ${error.message}`) }
        const killDeadline = Date.now() + this.timeoutMs
        while (await this.alive(pid) && Date.now() < killDeadline) await this.sleepImpl(100)
        if (await this.alive(pid)) throw new Error(`local CPA process ${pid} did not exit after SIGKILL`)
      }
    }
    this.clearPid(instance)
  }
  async restart(instance) { await this.stop(instance); await this.start(instance) }
  async unregister(instance) { await this.stop(instance); this.clearPid(instance) }
}

function quoteSystemd(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(' ', '\\x20').replaceAll('\t', '\\x09').replaceAll('\n', '\\x0a')
}

export class SystemdUnitManager {
  constructor({ unitDir = '/etc/systemd/system', versionsRoot, binaryByVersion, unitPrefix = 'multi-cpa', user = 'multi-cpa', group = 'multi-cpa' } = {}) {
    this.unitDir = unitDir
    this.versionsRoot = versionsRoot
    this.binaryByVersion = binaryByVersion
    this.unitPrefix = unitPrefix
    this.user = user
    this.group = group
  }
  unit(instance) {
    if (!safe(instance.id)) throw new Error('instance id contains unsafe characters')
    return `${this.unitPrefix}@${instance.id}.service`
  }
  async install(instance) {
    // The packaged multi-cpa@.service template resolves the executable from
    // the instance directory. Per-instance files are prepared by
    // InstanceService before this unit is started.
    if (!safe(instance.id)) throw new Error('instance id contains unsafe characters')
  }
  async unregister(instance) {
    if (!safe(instance.id)) throw new Error('instance id contains unsafe characters')
  }
  async activateVersion(version) {
    if (!this.versionsRoot || !safe(version)) throw new Error('version path is unavailable')
    const target = path.join(this.versionsRoot, version)
    const info = fs.lstatSync(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('version path is not a safe directory')
    const pointer = path.join(this.versionsRoot, 'current')
    try { fs.unlinkSync(pointer) } catch (error) { if (error.code !== 'ENOENT') throw error }
    fs.symlinkSync(target, pointer, 'dir')
  }
}

export class FakeRuntime {
  constructor() { this.statuses = new Map(); this.nextPid = 1000; this.failures = new Map() }
  failure(operation, error) { this.failures.set(operation, error); return this }
  check(operation) { if (this.failures.has(operation)) throw this.failures.get(operation) }
  async start(instance) { this.check('start'); const old = this.statuses.get(instance.id); if (old?.state === ObservedState.RUNNING) return; this.nextPid += 1; this.statuses.set(instance.id, { instance_id: instance.id, state: ObservedState.RUNNING, ready: true, pid: this.nextPid, version: instance.version || '' }) }
  async stop(instance) { this.check('stop'); this.statuses.set(instance.id, { instance_id: instance.id, state: ObservedState.STOPPED, ready: false, pid: 0, version: instance.version || '' }) }
  async restart(instance) { await this.stop(instance); await this.start(instance) }
  async status(instance) { this.check('status'); return this.statuses.get(instance.id) || { instance_id: instance.id, state: ObservedState.STOPPED, ready: false, pid: 0, version: instance.version || '' } }
  async unregister(instance) { this.check('unregister'); this.statuses.delete(instance.id) }
}

export class NoopUnitManager {
  async install() {}
  async unregister() {}
}
