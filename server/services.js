import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import { URL } from 'node:url'
import path from 'node:path'
import crypto from 'node:crypto'
import { DesiredState, DiscoveryAccountId, ObservedState, isActive, isStopped, nowIso } from './domain.js'
import { checkPassword, hashPassword, hashToken, newToken } from './security.js'
import { NotFoundError, ConflictError } from './store.js'
import { unsupported } from './cpa.js'
import { prepareInstanceBinary } from './instance-binary.js'

export const ErrInvalidCredentials = Object.assign(new Error('invalid credentials'), { code: 'ERR_INVALID_CREDENTIALS', status: 401 })
export const ErrRateLimited = Object.assign(new Error('too many authentication attempts'), { code: 'ERR_RATE_LIMITED', status: 429 })
export const ErrNotInitialized = Object.assign(new Error('administrator is not initialized'), { code: 'ERR_NOT_INITIALIZED', status: 503 })
export const ErrInvalidInstance = message => Object.assign(new Error(message || 'invalid instance'), { code: 'ERR_INVALID_INSTANCE', status: 400 })
export const ErrPortUnavailable = Object.assign(new Error('port is unavailable'), { code: 'ERR_PORT_UNAVAILABLE', status: 409 })
export const ErrStartNotConfirmed = message => Object.assign(new Error(message || 'instance start was not confirmed'), { code: 'ERR_START_NOT_CONFIRMED', status: 409 })
export const ErrStopNotConfirmed = message => Object.assign(new Error(message || 'instance stop was not confirmed'), { code: 'ERR_STOP_NOT_CONFIRMED', status: 409 })
export const ErrDeleteNotSafe = Object.assign(new Error('instance is not safe to delete'), { code: 'ERR_DELETE_NOT_SAFE', status: 409 })
export const ErrInvalidQuotaSettings = message => Object.assign(new Error(message || 'invalid quota settings'), { code: 'ERR_INVALID_QUOTA_SETTINGS', status: 400 })

class KeyedMutex {
  constructor() { this.queues = new Map() }
  async run(key, fn) {
    const previous = this.queues.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.queues.set(key, tail)
    await previous
    try { return await fn() } finally { release(); if (this.queues.get(key) === tail) this.queues.delete(key) }
  }
}

const validName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/
const validateName = name => { if (typeof name !== 'string' || !validName.test(name) || name.trim() !== name) throw ErrInvalidInstance('name must use letters, digits, spaces, ".", "_" or "-"') }
const validatePort = port => { if (!Number.isInteger(port) || port < 1024 || port > 65535) throw ErrInvalidInstance('port must be between 1024 and 65535') }
export const DEFAULT_CHILD_MANAGEMENT_PASSWORD = 'admin'
export const DEFAULT_CHILD_BIND_HOST = '0.0.0.0'
function managementPassword(value) {
  if (value === undefined || value === null || value === '') return { secret: DEFAULT_CHILD_MANAGEMENT_PASSWORD, configured: false }
  if (typeof value !== 'string') throw ErrInvalidInstance('management password must be a string')
  return { secret: value, configured: true }
}
const id = prefix => `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const ensureDirectory = directory => { if (!directory) throw new Error('directory path is required'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const info = fs.lstatSync(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('directory path must be a real directory'); fs.chmodSync(directory, 0o700) }

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => { server.close(); resolve(false) })
    server.listen({ host: '0.0.0.0', port }, () => server.close(() => resolve(true)))
  })
}

export class AuthService {
  constructor(store, { now = () => new Date(), sessionTtlMs = 12 * 60 * 60 * 1000 } = {}) { this.store = store; this.now = now; this.sessionTtlMs = sessionTtlMs; this.failures = new Map() }
  initializeAdmin(password) { this.store.setAdminHash('admin', hashPassword(password)) }
  setAdminPassword(username = 'admin', password) { this.store.setAdminHash(username || 'admin', hashPassword(password)) }
  loginFailureKey(username, clientKey = 'local') {
    const client = typeof clientKey === 'string' && clientKey.length <= 128 ? clientKey : 'unknown'
    return `login:${client}:${username === 'admin' ? 'admin' : 'unknown'}`
  }
  checkBlocked(key) { const entry = this.failures.get(key); if (entry?.blockedUntil > this.now().getTime()) throw ErrRateLimited }
  recordFailure(key) { const current = this.now().getTime(); const entry = this.failures.get(key) || { times: [], blockedUntil: 0 }; entry.times = entry.times.filter(value => value > current - 15 * 60 * 1000); entry.times.push(current); if (entry.times.length >= 5) { entry.blockedUntil = current + 30 * 60 * 1000; entry.times = [] } this.failures.set(key, entry) }
  clearFailures(key) { this.failures.delete(key) }
  verifyPassword(password, failureKey = 'admin-change') {
    this.checkBlocked(failureKey)
    if (typeof password !== 'string' || password.length < 1 || password.length > 4096) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    let encoded
    try { encoded = this.store.getAdminHash('admin') } catch (error) { if (error.code === 'ERR_NOT_FOUND') throw ErrNotInitialized; throw error }
    if (!checkPassword(encoded, password)) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    this.clearFailures(failureKey)
  }
  login(username, password, clientKey = 'local') {
    const failureKey = this.loginFailureKey(username, clientKey); this.checkBlocked(failureKey)
    if (typeof username !== 'string' || username.length < 1 || username.length > 64 || typeof password !== 'string' || password.length < 1 || password.length > 4096) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    let encoded
    try { encoded = this.store.getAdminHash(username) } catch (error) { if (error.code === 'ERR_NOT_FOUND') { this.recordFailure(failureKey); throw ErrInvalidCredentials } throw error }
    if (!checkPassword(encoded, password)) { this.recordFailure(failureKey); throw ErrInvalidCredentials }
    this.clearFailures(failureKey)
    const token = newToken(); const expires = new Date(this.now().getTime() + this.sessionTtlMs)
    this.store.cleanupSessions?.(this.now().toISOString())
    this.store.createSession(hashToken(token), username, expires.toISOString())
    return { token, expires }
  }
  authenticate(token) {
    if (!token) throw ErrInvalidCredentials
    let session
    try { session = this.store.getSession(hashToken(token)) } catch (error) { if (error.code === 'ERR_NOT_FOUND') throw ErrInvalidCredentials; throw error }
    if (Date.parse(session.expiresAt) <= this.now().getTime()) { this.store.deleteSession(hashToken(token)); throw ErrInvalidCredentials }
    return session.username
  }
  logout(token) { if (token) this.store.deleteSession(hashToken(token)) }
  changeAdminPassword(currentPassword, newPassword) {
    this.verifyPassword(currentPassword, 'admin-change')
    if (typeof newPassword !== 'string' || newPassword.length < 1 || newPassword.length > 4096) throw ErrInvalidCredentials
    this.setAdminPassword('admin', newPassword)
  }
  verifyAdminPassword(password) {
    this.verifyPassword(password, 'admin-delete')
  }
}

export class InstanceService {
  constructor({ store, runtime, secrets, units, root, binaryByVersion = null, clock = () => new Date(), defaultVersion = '', requireVersion = true, healthCheck = null, maxInstances = 5 } = {}) {
    this.store = store; this.runtime = runtime; this.secrets = secrets; this.units = units; this.root = root; this.binaryByVersion = binaryByVersion; this.clock = clock; this.defaultVersion = defaultVersion; this.requireVersion = requireVersion; this.healthCheck = healthCheck; this.maxInstances = maxInstances; this.locks = new KeyedMutex(); this.operations = new KeyedMutex()
  }
  runtimeLog(level, instance, message, context = {}) {
    try { this.store.appendRuntimeLog?.({ level, source: 'instance', instance_id: instance?.id || '', message, context, created_at: this.clock().toISOString() }) } catch {}
  }
  async prepareBinary(instance) { return prepareInstanceBinary(instance, this.binaryByVersion) }
  async withInstanceLock(instanceId, fn) { return this.locks.run(instanceId, fn) }
  assertUpgradeIdle() {
    let state
    try { state = this.store.getUpgradeState() } catch (error) { if (error.code === 'ERR_NOT_FOUND') return; throw error }
    if (!['committed', 'rolled-back'].includes(state.state)) throw new ConflictError(`upgrade state is ${state.state}; recover the upgrade first`)
  }
  async create(input) {
    return this.operations.run('global', async () => {
      this.assertUpgradeIdle()
      ensureDirectory(this.root); ensureDirectory(path.join(this.root, 'instances'))
      validateName(input?.name); validatePort(input?.port)
      if (!(await portAvailable(input.port))) throw ErrPortUnavailable
      const childPassword = managementPassword(input?.management_password)
      const existing = this.store.listInstances(); if (this.maxInstances > 0 && existing.length >= this.maxInstances) throw new ConflictError(`maximum of ${this.maxInstances} instances reached`)
      if (existing.some(item => item.name.toLowerCase() === input.name.toLowerCase() || item.port === input.port)) throw new ConflictError()
      let version = input.version || existing[0]?.version || this.defaultVersion || ''
      if (existing.some(item => item.version !== version)) throw new ConflictError(`all CPA instances must use version ${existing[0].version}`)
      if (this.requireVersion && !version) throw new Error('no usable CPA version is installed')
      if (this.requireVersion) { const installed = this.store.getVersion(version); if (!installed.usable) throw new Error(`CPA version ${version} is not usable`) }
      if (!this.secrets) throw new Error('secret store is unavailable')
      const instanceId = id('cpa'); const directory = path.join(this.root, 'instances', instanceId); const timestamp = this.clock().toISOString()
      const instance = { id: instanceId, name: input.name, port: input.port, directory, desired_state: DesiredState.STOPPED, version, revision: 1, created_at: timestamp, updated_at: timestamp, management_secret_ciphertext: this.secrets.encrypt(childPassword.secret) }
      try {
        ensureDirectory(directory); ensureDirectory(path.join(directory, 'auths')); ensureDirectory(path.join(directory, 'logs'))
        this.writeInitialConfig(instance, childPassword.secret)
        await this.prepareBinary(instance)
        this.store.createInstance(instance)
        await this.units?.install(instance)
        this.runtimeLog('info', instance, `instance ${instance.name} created`, { port: instance.port, version: instance.version })
        return instance
      } catch (error) { try { this.store.deleteInstance(instance.id) } catch {} try { fs.rmSync(directory, { recursive: true, force: true }) } catch {} try { await this.units?.unregister(instance) } catch {}; throw error }
    })
  }
  writeInitialConfig(instance, secret) {
    const file = path.join(instance.directory, 'config.yaml'); const temporary = `${file}.tmp`
    // CPA disables the management API when secret-key is empty.  Keep the
    // controller's default password (admin) explicit in the child config so
    // newly-created default instances are manageable as well.
    const secretLine = `  secret-key: ${JSON.stringify(secret)}\n`
    // Listen on every IPv4 interface so proxy and management endpoints are
    // reachable from the LAN. Access remains protected by the CPA keys.
    const yaml = `host: ${DEFAULT_CHILD_BIND_HOST}\nport: ${instance.port}\nauth-dir: ${JSON.stringify(path.join(instance.directory, 'auths'))}\nremote-management:\n  allow-remote: true\n${secretLine}  disable-control-panel: false\nplugins:\n  enabled: true\nlogging-to-file: true\n`
    fs.writeFileSync(temporary, yaml, { mode: 0o600 }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600)
  }
  ensureManagementConfig(instance) {
    if (!this.secrets) throw new Error('secret store is unavailable')
    const file = path.join(instance.directory, 'config.yaml')
    const original = fs.readFileSync(file, 'utf8')
    const secret = this.decryptManagementSecret(instance)
    const lines = original.split(/\r?\n/)
    let found = false
    let changed = false
    let hostFound = false
    let allowRemoteFound = false
    let controlPanelFound = false
    const updated = lines.map(line => {
      if (/^host:\s*/.test(line)) {
        hostFound = true
        const expected = `host: ${DEFAULT_CHILD_BIND_HOST}`
        if (line !== expected) changed = true
        return expected
      }
      if (/^  allow-remote:\s*/.test(line)) {
        allowRemoteFound = true
        if (line !== '  allow-remote: true') changed = true
        return '  allow-remote: true'
      }
      if (/^  disable-control-panel:\s*/.test(line)) {
        controlPanelFound = true
        if (line !== '  disable-control-panel: false') changed = true
        return '  disable-control-panel: false'
      }
      const match = line.match(/^  secret-key:\s*(.*)$/)
      if (!match) return line
      found = true
      const value = match[1].trim()
      if (!value || value === '""' || value === "''") {
        changed = true
        return `  secret-key: ${JSON.stringify(secret)}`
      }
      return line
    })
    if (!hostFound) {
      updated.unshift(`host: ${DEFAULT_CHILD_BIND_HOST}`)
      changed = true
    }
    let remoteManagement = updated.findIndex(line => /^remote-management:\s*$/.test(line))
    if (remoteManagement < 0) {
      while (updated.length && updated.at(-1) === '') updated.pop()
      remoteManagement = updated.length
      updated.push('remote-management:')
      changed = true
    }
    if (!allowRemoteFound) {
      updated.splice(remoteManagement + 1, 0, '  allow-remote: true')
      allowRemoteFound = true
      changed = true
    }
    if (!found) {
      const allowRemote = updated.findIndex(line => /^  allow-remote:\s*/.test(line))
      updated.splice(allowRemote + 1, 0, `  secret-key: ${JSON.stringify(secret)}`)
      changed = true
    }
    if (!controlPanelFound) {
      const secretKey = updated.findIndex(line => /^  secret-key:\s*/.test(line))
      updated.splice(secretKey + 1, 0, '  disable-control-panel: false')
      changed = true
    }
    // CPA's upstream example disables dynamic plugins by default. The
    // controller's managed instances opt in explicitly so plugin-backed
    // providers and management extensions are available after creation.
    const pluginsHeader = updated.findIndex(line => /^plugins:\s*$/.test(line))
    if (pluginsHeader < 0) {
      while (updated.length && updated.at(-1) === '') updated.pop()
      updated.push('plugins:', '  enabled: true')
      changed = true
    } else {
      let pluginsEnd = updated.length
      let enabledIndex = -1
      for (let index = pluginsHeader + 1; index < updated.length; index += 1) {
        const line = updated[index]
        if (/^\S/.test(line) && line.trim() && !line.startsWith('#')) { pluginsEnd = index; break }
        if (/^  enabled:\s*/.test(line)) { enabledIndex = index; break }
      }
      if (enabledIndex >= 0) {
        if (updated[enabledIndex] !== '  enabled: true') { updated[enabledIndex] = '  enabled: true'; changed = true }
      } else {
        updated.splice(pluginsEnd, 0, '  enabled: true')
        changed = true
      }
    }
    if (!changed) return false
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, updated.join('\n'), { mode: 0o600 })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
    return true
  }
  async mutate(instanceId, kind, desired, action) {
    return this.operations.run('global', () => this.withInstanceLock(instanceId, async () => {
      if (kind !== 'stop') this.assertUpgradeIdle()
      let instance = this.store.getInstance(instanceId)
      if (desired && kind !== 'stop') { const next = { ...instance, desired_state: desired, revision: instance.revision + 1, updated_at: this.clock().toISOString() }; this.store.updateInstance(next, instance.revision); instance = next }
      const operation = { id: id('op'), kind, instance_id: instanceId, state: 'running', message: '', created_at: this.clock().toISOString(), updated_at: this.clock().toISOString() }
      this.store.saveOperation(operation)
      this.runtimeLog('info', instance, `instance ${kind} started`, { operation_id: operation.id })
      let error
      try { await action(instance); if (desired === DesiredState.STOPPED && kind === 'stop') { const next = { ...instance, desired_state: desired, revision: instance.revision + 1, updated_at: this.clock().toISOString() }; this.store.updateInstance(next, instance.revision) } }
      catch (cause) { error = cause }
      operation.updated_at = this.clock().toISOString(); operation.state = error ? 'failed' : 'succeeded'; operation.message = error?.message || ''; this.store.updateOperation(operation)
      this.runtimeLog(error ? 'error' : 'info', instance, error ? `instance ${kind} failed: ${error.message}` : `instance ${kind} succeeded`, { operation_id: operation.id })
      if (error) throw error
    }))
  }
  async startRuntime(instance, restart = false) {
    try {
      await this.prepareBinary(instance)
      this.ensureManagementConfig(instance)
      if (restart) await this.runtime.restart(instance)
      else await this.runtime.start(instance)
      await this.confirmStarted(instance)
    } catch (error) {
      if (error?.code === 'ERR_START_NOT_CONFIRMED') throw error
      throw ErrStartNotConfirmed(`start failed: ${error.message}`)
    }
  }
  async start(instanceId) { return this.mutate(instanceId, 'start', DesiredState.RUNNING, async instance => { if (!this.runtime) throw new Error('runtime unavailable'); await this.startRuntime(instance) }) }
  async stop(instanceId) { return this.mutate(instanceId, 'stop', DesiredState.STOPPED, async instance => { if (!this.runtime) throw new Error('runtime unavailable'); await this.runtime.stop(instance); const status = await this.runtime.status(instance); if (!isStopped(status.state)) throw ErrStopNotConfirmed(`observed state ${status.state}`) }) }
  async restart(instanceId) { return this.mutate(instanceId, 'restart', DesiredState.RUNNING, async instance => { if (!this.runtime) throw new Error('runtime unavailable'); await this.startRuntime(instance, true) }) }
  async confirmStarted(instance) { const status = await this.runtime.status(instance); if (![ObservedState.RUNNING, ObservedState.STARTING].includes(status.state)) throw ErrStartNotConfirmed(`observed state ${status.state}`) }
  async status(instanceId) {
    return this.withInstanceLock(instanceId, async () => {
      const instance = this.store.getInstance(instanceId); let status
      if (!this.runtime) status = { instance_id: instance.id, state: ObservedState.UNKNOWN, ready: false, version: instance.version, message: 'runtime unavailable' }
      else status = { ...await this.runtime.status(instance) }
      // Runtime adapters may reuse their status object. Never retain a previous
      // successful health result after the management API becomes unavailable.
      delete status.management_ready
      delete status.management_message
      if (this.healthCheck && status.state === ObservedState.RUNNING) { try { await this.healthCheck(instance); status.management_ready = true } catch (error) { status.management_message = error.message } }
      return status
    })
  }
  async list() { const instances = this.store.listInstances(); return Promise.all(instances.map(async instance => ({ ...instance, status: await this.status(instance.id) }))) }
  async update(instanceId, input) {
    return this.operations.run('global', () => this.withInstanceLock(instanceId, async () => {
      this.assertUpgradeIdle()
      const current = this.store.getInstance(instanceId); const expected = input.expected_revision || current.revision; if (expected !== current.revision) throw new ConflictError('instance revision conflict'); const next = { ...current }
      await this.prepareBinary(current)
      const passwordProvided = Object.prototype.hasOwnProperty.call(input, 'management_password') && input.management_password !== undefined && input.management_password !== null && input.management_password !== ''
      if (Object.prototype.hasOwnProperty.call(input, 'management_password') && input.management_password !== undefined && input.management_password !== null && typeof input.management_password !== 'string') throw ErrInvalidInstance('management password must be a string')
      const passwordChanged = passwordProvided
      if (passwordChanged) { if (!this.secrets) throw new Error('secret store is unavailable'); next.management_secret_ciphertext = this.secrets.encrypt(input.management_password) }
      if (input.name !== undefined) { validateName(input.name); if (input.name.toLowerCase() !== current.name.toLowerCase() && this.store.listInstances().some(item => item.id !== instanceId && item.name.toLowerCase() === input.name.toLowerCase())) throw new ConflictError(); next.name = input.name }
      let wasRunning = false; let originalConfig = null
      const portChanged = input.port !== undefined && input.port !== current.port
      if (portChanged || passwordChanged) {
        if (!this.runtime) throw new Error('runtime unavailable')
        if (portChanged) { validatePort(input.port); if (this.store.listInstances().some(item => item.id !== instanceId && item.port === input.port) || !(await portAvailable(input.port))) throw ErrPortUnavailable }
        originalConfig = fs.readFileSync(path.join(current.directory, 'config.yaml')); const status = await this.runtime.status(current)
        if (status.state === ObservedState.UNKNOWN) throw new ConflictError(`cannot update instance while state is ${status.state}`)
        wasRunning = isActive(status.state); if (wasRunning) { await this.runtime.stop(current); const stopped = await this.runtime.status(current); if (!isStopped(stopped.state)) throw new ConflictError('instance did not stop before port change') }
        try {
          const lines = originalConfig.toString().split(/\r?\n/); let replacedPort = false; let replacedSecret = false
          const updated = lines.map(line => {
            if (portChanged && /^port:\s*/.test(line)) { replacedPort = true; return `port: ${input.port}` }
            if (passwordChanged && /^  secret-key:\s*/.test(line)) { replacedSecret = true; return `  secret-key: ${JSON.stringify(input.management_password)}` }
            return line
          })
          if (portChanged && !replacedPort) updated.unshift(`port: ${input.port}`)
          if (passwordChanged && !replacedSecret) { const index = updated.findIndex(line => /^  allow-remote:\s*/.test(line)); updated.splice(index >= 0 ? index + 1 : 0, 0, `  secret-key: ${JSON.stringify(input.management_password)}`) }
          const temporary = path.join(current.directory, 'config.yaml.tmp'); fs.writeFileSync(temporary, updated.join('\n'), { mode: 0o600 }); fs.renameSync(temporary, path.join(current.directory, 'config.yaml')); if (portChanged) next.port = input.port
        }
        catch (error) { fs.writeFileSync(path.join(current.directory, 'config.yaml'), originalConfig, { mode: 0o600 }); if (wasRunning) await this.startRuntime(current); throw error }
      }
      if (next.name === current.name && next.port === current.port && !passwordChanged) return current
      next.revision = current.revision + 1; next.updated_at = this.clock().toISOString()
      try { this.store.updateInstance(next, current.revision) } catch (error) { if (originalConfig) fs.writeFileSync(path.join(current.directory, 'config.yaml'), originalConfig, { mode: 0o600 }); if (wasRunning) await this.startRuntime(current); throw error }
      if (wasRunning) {
        const updated = this.store.getInstance(instanceId)
        try { await this.startRuntime(updated) }
        catch (error) {
          try {
            await this.runtime.stop(updated)
            if (!isStopped((await this.runtime.status(updated)).state)) throw ErrStopNotConfirmed('new configuration process did not stop')
            fs.writeFileSync(path.join(current.directory, 'config.yaml'), originalConfig, { mode: 0o600 })
            const restored = { ...current, revision: updated.revision + 1, updated_at: this.clock().toISOString() }
            this.store.updateInstance(restored, updated.revision)
            await this.startRuntime(restored)
            this.runtimeLog('warn', restored, 'configuration update failed; previous configuration restored')
          } catch (recoveryError) {
            this.runtimeLog('error', updated, 'configuration update recovery failed')
            throw ErrStartNotConfirmed(`${error.message}; restore failed: ${recoveryError.message}`)
          }
          throw error
        }
      }
      return this.store.getInstance(instanceId)
    }))
  }
  async reconcileDesired() {
    return this.operations.run('global', async () => {
    this.assertUpgradeIdle()
    let firstError = null
    for (const instance of this.store.listInstances()) {
      try {
        await this.withInstanceLock(instance.id, async () => {
          const status = await this.runtime.status(instance)
          // Reattaching a controller must not migrate or restart a live child.
          // Prepare configuration and binaries only when a child needs starting.
          if (instance.desired_state === DesiredState.RUNNING && isStopped(status.state)) await this.startRuntime(instance)
        })
      } catch (error) { firstError ||= error }
    }
    if (firstError) throw firstError
    })
  }
  decryptManagementSecret(instance) { if (!this.secrets) throw new Error('secret store unavailable'); return this.secrets.decrypt(instance.management_secret_ciphertext) }
  setDefaultVersionIfEmpty(version) { if (!this.defaultVersion && !this.store.listInstances().length) this.defaultVersion = version }
}

export class DeleteService {
  constructor({ store, runtime, units, instances, auth, clock = () => new Date(), challengeTtlMs = 10 * 60 * 1000 } = {}) { this.store = store; this.runtime = runtime; this.units = units; this.instances = instances; this.auth = auth; this.clock = clock; this.challengeTtlMs = challengeTtlMs; this.running = new Set() }
  preview(instanceId) { const instance = this.store.getInstance(instanceId); const challenge = { id: id('del'), instance_id: instance.id, revision: instance.revision, expires_at: new Date(this.clock().getTime() + this.challengeTtlMs).toISOString() }; this.store.createDeleteChallenge(challenge); return challenge }
  async confirm(instanceId, challengeId, password) {
    if (!this.auth) throw new Error('authentication service unavailable'); this.auth.verifyAdminPassword(password); if (this.running.has(instanceId)) throw new Error('delete already in progress'); this.running.add(instanceId)
    try {
      return await this.instances.operations.run('global', () => this.instances.withInstanceLock(instanceId, async () => {
        const instance = this.store.getInstance(instanceId); this.store.consumeDeleteChallenge(challengeId, instanceId, instance.revision, this.clock().toISOString()); const operation = { id: id('op'), kind: 'delete', instance_id: instanceId, state: 'running', message: '', created_at: this.clock().toISOString(), updated_at: this.clock().toISOString() }; this.store.saveOperation(operation)
        try { await this.remove(instance); operation.state = 'succeeded'; operation.updated_at = this.clock().toISOString(); this.store.updateOperation(operation) }
        catch (error) { operation.state = 'failed'; operation.message = error.message; operation.updated_at = this.clock().toISOString(); this.store.updateOperation(operation); throw error }
      }))
    } finally { this.running.delete(instanceId) }
  }
  async remove(instance) {
    const expected = path.resolve(this.instances.root, 'instances', instance.id); if (path.resolve(instance.directory) !== expected) throw ErrDeleteNotSafe
    if (!this.runtime) throw ErrDeleteNotSafe
    let status = await this.runtime.status(instance); if (!isStopped(status.state)) { await this.runtime.stop(instance); status = await this.runtime.status(instance); if (!isStopped(status.state)) throw ErrDeleteNotSafe }
    await this.units?.unregister(instance)
    validateDeletePath(this.instances.root, instance.directory)
    await fsp.rm(instance.directory, { recursive: true, force: true })
    this.store.deleteInstance(instance.id)
  }
}

function validateDeletePath(root, target) {
  const rootAbs = path.resolve(root); const targetAbs = path.resolve(target); const relative = path.relative(rootAbs, targetAbs)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw ErrDeleteNotSafe
  let current = rootAbs
  for (const component of relative.split(path.sep)) { if (!component || component === '.') continue; current = path.join(current, component); let info; try { info = fs.lstatSync(current) } catch (error) { if (error.code === 'ENOENT') return; throw error } if (info.isSymbolicLink() || !info.isDirectory()) throw ErrDeleteNotSafe }
}

export const DEFAULT_QUOTA_SETTINGS = Object.freeze({ refresh_interval_minutes: 360, webhook_enabled: false, webhook_url: '', webhook_url_configured: false, alert_threshold_percent: 20, webhook_signing_enabled: false, webhook_secret_configured: false })

function validateQuotaSettings(input, current = DEFAULT_QUOTA_SETTINGS) {
  const next = { ...current }
  if (input.refresh_interval_minutes !== undefined) {
    const value = Number(input.refresh_interval_minutes)
    if (!Number.isInteger(value) || value < 1 || value > 10080) throw ErrInvalidQuotaSettings('refresh interval must be between 1 and 10080 minutes')
    next.refresh_interval_minutes = value
  }
  if (input.webhook_enabled !== undefined) {
    if (typeof input.webhook_enabled !== 'boolean') throw ErrInvalidQuotaSettings('webhook_enabled must be boolean')
    next.webhook_enabled = input.webhook_enabled
  }
  if (input.webhook_url !== undefined) {
    if (typeof input.webhook_url !== 'string') throw ErrInvalidQuotaSettings('webhook_url must be a string')
    const url = input.webhook_url.trim()
    if (url) {
      let parsed
      try { parsed = new URL(url) } catch { throw ErrInvalidQuotaSettings('webhook_url must be a valid HTTP(S) URL') }
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'oapi.dingtalk.com' || parsed.port || parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/robot/send' || !parsed.searchParams.get('access_token')) throw ErrInvalidQuotaSettings('webhook_url must be a DingTalk HTTPS robot URL with an access_token')
    }
    next.webhook_url = url
  }
  if (input.webhook_signing_enabled !== undefined) {
    if (typeof input.webhook_signing_enabled !== 'boolean') throw ErrInvalidQuotaSettings('webhook_signing_enabled must be boolean')
    next.webhook_signing_enabled = input.webhook_signing_enabled
  }
  if (input.webhook_secret !== undefined) {
    if (typeof input.webhook_secret !== 'string') throw ErrInvalidQuotaSettings('webhook_secret must be a string')
    if (input.webhook_secret.length > 256) throw ErrInvalidQuotaSettings('webhook_secret must be 256 characters or fewer')
    next.webhook_secret = input.webhook_secret
    next.webhook_secret_configured = Boolean(input.webhook_secret)
  }
  if (input.alert_threshold_percent !== undefined) {
    const value = Number(input.alert_threshold_percent)
    if (!Number.isFinite(value) || value < 0 || value > 100) throw ErrInvalidQuotaSettings('alert threshold must be between 0 and 100 percent')
    next.alert_threshold_percent = Math.round(value * 100) / 100
  }
  if (next.webhook_enabled && !next.webhook_url) throw ErrInvalidQuotaSettings('webhook_url is required when webhook notifications are enabled')
  if (next.webhook_signing_enabled && !next.webhook_secret) throw ErrInvalidQuotaSettings('webhook_secret is required when webhook signing is enabled')
  return next
}

export class DingTalkNotifier {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 10000, clock = () => Date.now() } = {}) { this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.clock = clock }
  signedWebhookUrl(settings) {
    if (!settings.webhook_signing_enabled) return settings.webhook_url
    if (!settings.webhook_secret) throw new Error('webhook signing secret is unavailable')
    const now = this.clock(); const timestamp = String(now instanceof Date ? now.getTime() : now)
    const sign = crypto.createHmac('sha256', settings.webhook_secret).update(`${timestamp}\n${settings.webhook_secret}`).digest('base64')
    const url = new URL(settings.webhook_url)
    url.searchParams.set('timestamp', timestamp)
    url.searchParams.set('sign', sign)
    return url.toString()
  }
  async notify(settings, message) {
    if (!settings.webhook_enabled || !settings.webhook_url) return false
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(this.signedWebhookUrl(settings), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: message } }), signal: controller.signal })
      if (!response.ok) throw new Error(`DingTalk webhook returned HTTP ${response.status}`)
      let payload = null
      try { payload = await response.json() } catch {}
      if (!payload || ![0, '0'].includes(payload.errcode)) throw new Error('DingTalk webhook did not confirm delivery')
      return true
    } finally { clearTimeout(timer) }
  }
}

function quotaPercent(value) {
  if (value?.remaining == null || value?.total == null) return null
  const remaining = Number(value?.remaining); const total = Number(value?.total)
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, remaining / total * 100))
}

export class QuotaService {
  constructor({ store, instances, clients, secrets = null, clock = () => new Date(), refreshIntervalMs = 6 * 60 * 60 * 1000, maxConcurrent = 3, notifier = null } = {}) { this.store = store; this.instances = instances; this.clients = clients; this.secrets = secrets; this.clock = clock; this.refreshIntervalMs = refreshIntervalMs; this.maxConcurrent = maxConcurrent; this.notifier = notifier || new DingTalkNotifier(); this.running = new Set(); this.migrateLegacyWebhookUrl() }
  getSettings() {
    const settings = typeof this.store.getQuotaSettings === 'function' ? this.store.getQuotaSettings() : { refresh_interval_minutes: Math.max(1, Math.round(this.refreshIntervalMs / 60000)) }
    const safe = { ...settings }; delete safe.webhook_secret; delete safe.webhook_signing_secret_ciphertext; delete safe.webhook_url_ciphertext; delete safe.webhook_url_legacy; delete safe.webhook_url
    return { ...DEFAULT_QUOTA_SETTINGS, ...safe, webhook_url: '', webhook_url_configured: Boolean(settings.webhook_url_configured || settings.webhook_url), webhook_secret_configured: Boolean(settings.webhook_secret_configured) }
  }
  storedSettings() {
    if (typeof this.store.getQuotaSettings !== 'function') return { ...this.getSettings(), webhook_signing_secret_ciphertext: '', webhook_url_ciphertext: '', webhook_url_legacy: '' }
    return this.store.getQuotaSettings({ includeSecretCiphertext: true })
  }
  migrateLegacyWebhookUrl() {
    if (typeof this.store?.getQuotaSettings !== 'function' || typeof this.store?.saveQuotaSettings !== 'function') return
    const stored = this.storedSettings()
    if (!stored.webhook_url_legacy || stored.webhook_url_ciphertext) return
    let webhookUrl = ''
    try { webhookUrl = validateQuotaSettings({ webhook_url: stored.webhook_url_legacy }, { ...DEFAULT_QUOTA_SETTINGS }).webhook_url } catch {}
    if (webhookUrl && !this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
    this.store.saveQuotaSettings({ ...stored, webhook_enabled: webhookUrl ? stored.webhook_enabled : false, webhook_url: '', webhook_url_ciphertext: webhookUrl ? this.secrets.encrypt(webhookUrl) : '' })
  }
  settingsWithSecret() {
    const stored = this.storedSettings(); let secret = ''; let webhookUrl = stored.webhook_url_legacy || ''
    if (stored.webhook_signing_secret_ciphertext) {
      if (!this.secrets?.decrypt) throw new Error('webhook secret store is unavailable')
      secret = this.secrets.decrypt(stored.webhook_signing_secret_ciphertext)
    }
    if (stored.webhook_url_ciphertext) {
      if (!this.secrets?.decrypt) throw new Error('webhook secret store is unavailable')
      webhookUrl = this.secrets.decrypt(stored.webhook_url_ciphertext)
    }
    const safe = { ...stored }; delete safe.webhook_signing_secret_ciphertext; delete safe.webhook_url_ciphertext; delete safe.webhook_url_legacy
    return { ...DEFAULT_QUOTA_SETTINGS, ...safe, webhook_url: webhookUrl, webhook_url_configured: Boolean(webhookUrl), webhook_secret: secret, webhook_secret_configured: Boolean(secret) }
  }
  updateSettings(input = {}) {
    const current = this.settingsWithSecret(); const stored = this.storedSettings(); const next = validateQuotaSettings(input, current); const hasSecret = Object.prototype.hasOwnProperty.call(input, 'webhook_secret'); const hasUrl = Object.prototype.hasOwnProperty.call(input, 'webhook_url')
    let ciphertext = stored.webhook_signing_secret_ciphertext || ''
    let urlCiphertext = stored.webhook_url_ciphertext || ''
    if (hasSecret) {
      if (next.webhook_secret) {
        if (!this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
        ciphertext = this.secrets.encrypt(next.webhook_secret)
      } else ciphertext = ''
    }
    if (hasUrl || (!urlCiphertext && next.webhook_url)) {
      if (next.webhook_url) {
        if (!this.secrets?.encrypt) throw new Error('webhook secret store is unavailable')
        urlCiphertext = this.secrets.encrypt(next.webhook_url)
      } else urlCiphertext = ''
    }
    delete next.webhook_secret; delete next.webhook_signing_secret_ciphertext; delete next.webhook_url_ciphertext; delete next.webhook_url_legacy
    const saved = typeof this.store.saveQuotaSettings === 'function' ? this.store.saveQuotaSettings({ ...next, webhook_url: '', webhook_url_ciphertext: urlCiphertext, webhook_signing_secret_ciphertext: ciphertext }) : { ...DEFAULT_QUOTA_SETTINGS, ...next, webhook_url: '', webhook_url_configured: Boolean(urlCiphertext), webhook_secret_configured: Boolean(ciphertext) }
    if (next.refresh_interval_minutes !== current.refresh_interval_minutes) this.wakeScheduler?.()
    return saved
  }
  intervalMs() { const settings = this.getSettings(); return Math.max(60000, Number(settings.refresh_interval_minutes) * 60000) }
  async refreshInstance(instanceId, signal) {
    if (this.running.has(instanceId)) throw new Error('quota refresh already in progress'); this.running.add(instanceId)
    try {
      return await this.instances.operations.run('global', () => this.instances.withInstanceLock(instanceId, async () => {
        signal?.throwIfAborted()
        const instance = this.store.getInstance(instanceId); const attempt = this.clock().toISOString(); let client
        if (this.instances.runtime && isStopped((await this.instances.runtime.status(instance)).state)) {
          const error = Object.assign(new Error('instance is stopped; start it before refreshing quotas'), { status: 409 })
          this.markDiscoveryFailure(instanceId, attempt, error)
          throw error
        }
        try { if (!this.clients) throw new Error('CPA client factory unavailable'); client = await this.clients(instance); const accounts = await client.listAccounts(signal); const previous = this.store.listQuotas(instanceId); const previousBy = new Map(previous.map(item => [item.account_id, item])); if (!accounts.length) { this.store.saveQuota({ instance_id: instanceId, account_id: DiscoveryAccountId, provider: '', values: [], status: 'empty', message: 'no OAuth accounts configured', attempted_at: attempt, collected_at: attempt }) }
          const results = []; let index = 0; const worker = async () => { while (index < accounts.length) { const account = accounts[index++]; let snapshot; try { snapshot = await client.fetchQuota(account, signal); snapshot = { ...snapshot, instance_id: instanceId, account_id: account.id, provider: account.provider || '', attempted_at: attempt, status: 'ok', collected_at: attempt } } catch (error) { const old = previousBy.get(account.id); snapshot = { instance_id: instanceId, account_id: account.id, provider: account.provider || '', values: old?.values || [], collected_at: old?.collected_at || '', attempted_at: attempt, status: error.code === 'ERR_UNSUPPORTED' ? 'unsupported' : 'failed', message: error.code === 'ERR_UNSUPPORTED' ? 'quota endpoint is not supported for this account' : error.message } } results.push(snapshot) } }
          await Promise.all(Array.from({ length: Math.max(1, Math.min(this.maxConcurrent, accounts.length || 1)) }, worker)); for (const snapshot of results) this.store.saveQuota(snapshot)
          const settings = this.settingsWithSecret()
          const low = results.filter(snapshot => snapshot.status === 'ok').flatMap(snapshot => (snapshot.values || []).map(value => ({ snapshot, value, percent: quotaPercent(value) })).filter(item => item.percent !== null && item.percent < settings.alert_threshold_percent))
          if (low.length && this.notifier && settings.webhook_enabled && settings.webhook_url) {
            const lines = low.map(item => `${instance.name} / ${item.snapshot.provider || 'OAuth'} / ${item.value.name || '默认窗口'}：剩余 ${item.percent.toFixed(1)}%`)
            try { await this.notifier.notify(settings, `CLIProxyAPI 配额告警\n${lines.join('\n')}`) } catch {
              // Transport errors may contain the full signed webhook URL.
              this.store.appendRuntimeLog?.({ level: 'error', source: 'quota', instance_id: instanceId, message: 'DingTalk quota notification failed; check webhook settings and network access', context: {} })
            }
          }
          const seen = new Set(accounts.map(account => account.id)); for (const old of previous) if ((old.account_id === DiscoveryAccountId && accounts.length) || (old.account_id !== DiscoveryAccountId && !seen.has(old.account_id))) this.store.deleteQuota(instanceId, old.account_id)
          return results
        } catch (error) { this.markDiscoveryFailure(instanceId, attempt, error); throw new Error(`list OAuth accounts: ${error.message}`) }
      }))
    } finally { this.running.delete(instanceId) }
  }
  markDiscoveryFailure(instanceId, attempt, error) { const previous = this.store.listQuotas(instanceId); if (!previous.length) this.store.saveQuota({ instance_id: instanceId, account_id: DiscoveryAccountId, provider: '', values: [], status: 'failed', message: error.message, attempted_at: attempt, collected_at: '' }); else for (const item of previous) this.store.saveQuota({ ...item, attempted_at: attempt, status: 'failed', message: error.message }) }
  async list(instanceId) { this.store.getInstance(instanceId); const now = this.clock().getTime(); const interval = this.intervalMs(); return this.store.listQuotas(instanceId).map(item => item.status === 'ok' && (!item.attempted_at || now - Date.parse(item.attempted_at) >= interval) ? { ...item, status: 'stale', message: 'quota snapshot is older than the refresh interval' } : item) }
  async refreshDue(signal) { const now = this.clock().getTime(); const interval = this.intervalMs(); for (const instance of this.store.listInstances()) { const snapshots = this.store.listQuotas(instance.id); if (!snapshots.length || snapshots.some(item => item.status === 'failed' || !item.attempted_at || now - Date.parse(item.attempted_at) >= interval)) { try { await this.refreshInstance(instance.id, signal) } catch {} } } }
  async run(signal) {
    if (signal?.aborted) return
    await this.refreshDue(signal)
    while (!signal?.aborted) {
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', finish)
          if (this.wakeScheduler === finish) this.wakeScheduler = null
          resolve()
        }
        const timer = setTimeout(finish, this.intervalMs())
        this.wakeScheduler = finish
        signal?.addEventListener('abort', finish, { once: true })
        if (signal?.aborted) finish()
      })
      if (!signal?.aborted) await this.refreshDue(signal)
    }
  }
}


