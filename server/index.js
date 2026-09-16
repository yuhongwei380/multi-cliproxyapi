import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Store, NotFoundError } from './store.js'
import { openSecretStore } from './security.js'
import { ProcessRuntime, SystemdRuntime, SystemdUnitManager } from './runtime.js'
import { HTTPClient } from './cpa.js'
import { GitHubSource, Installer, UpgradeService, VersionService } from './release.js'
import { AuthService, InstanceService, DeleteService, QuotaService } from './services.js'
import { Controller, createHttpServer } from './http.js'
import { ManagementAssets } from './management-assets.js'

export const DEFAULT_ADMIN_PASSWORD = 'admin'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]; if (!value.startsWith('--')) continue
    const [key, inline] = value.slice(2).split('=', 2); result[key.replaceAll('-', '_')] = inline ?? argv[++index]
  }
  return result
}
export function readConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv); const home = os.homedir() || '.'
  return {
    dataDir: path.resolve(args.data_dir || env.MULTI_CPA_DATA_DIR || path.join(home, '.multi-cliproxyapi')),
    listen: args.listen || env.MULTI_CPA_LISTEN || '0.0.0.0:8787',
    adminPassword: env.MULTI_CPA_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD, version: args.version || env.MULTI_CPA_VERSION || '', quotaPath: args.quota_path || env.MULTI_CPA_QUOTA_PATH || '', secureCookies: String(args.secure_cookies ?? (env.MULTI_CPA_SECURE_COOKIES || '')).toLowerCase() === 'true',
    unitDir: args.systemd_unit_dir || env.MULTI_CPA_SYSTEMD_UNIT_DIR || '/etc/systemd/system', runtimeMode: args.runtime || env.MULTI_CPA_RUNTIME || 'systemd', staticRoot: env.MULTI_CPA_STATIC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'), skipVersionInstall: String(env.MULTI_CPA_SKIP_VERSION_INSTALL || '').toLowerCase() === 'true'
  }
}

function validateConfig(config) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error(`Linux amd64 is required, got ${process.platform}/${process.arch}`)
  if (!config.dataDir) throw new Error('data directory is required')
  if (!config.listen) throw new Error('listen address is required')
}
function parseListen(value) {
  const match = String(value).match(/^([^:]+|\[[^\]]+\]):(\d+)$/); if (!match) throw new Error('listen must be host:port')
  const port = Number(match[2]); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('listen port is invalid'); return { host: match[1].replace(/^\[|\]$/g, ''), port }
}
function ensurePrivateDir(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const info = fs.lstatSync(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('data directory must be a real directory'); fs.chmodSync(directory, 0o700) }
function executablePath(root, version) {
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version)) throw new Error('instance version is empty or unsafe')
  const directory = path.join(root, version); const info = fs.lstatSync(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('version path is not a safe directory')
  for (const name of ['cli-proxy-api', 'cliproxyapi', 'CLIProxyAPI']) { const candidate = path.join(directory, name); try { const stat = fs.lstatSync(candidate); if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111)) return candidate } catch {} }
  throw new Error('CPA binary not found in installed version')
}

export function createApplication(config, overrides = {}) {
  validateConfig(config); ensurePrivateDir(config.dataDir)
  const store = overrides.store || new Store(path.join(config.dataDir, 'control.db')); const secrets = overrides.secrets || openSecretStore(path.join(config.dataDir, 'secrets.key')); const auth = overrides.auth || new AuthService(store)
  let initialized = true
  try { store.getAdminHash('admin') } catch (error) { if (error.code !== 'ERR_NOT_FOUND') throw error; initialized = false }
  if (!initialized) auth.initializeAdmin(config.adminPassword || DEFAULT_ADMIN_PASSWORD)
  const managementAssets = overrides.managementAssets || new ManagementAssets()
  const versionsRoot = path.join(config.dataDir, 'versions'); const binaryByVersion = async version => {
    const binary = executablePath(versionsRoot, version)
    await managementAssets.ensure(path.dirname(binary))
    return binary
  }; const runtime = overrides.runtime || (config.runtimeMode === 'process' ? new ProcessRuntime() : new SystemdRuntime()); const units = overrides.units || new SystemdUnitManager({ unitDir: config.unitDir, versionsRoot, binaryByVersion });
  const instances = overrides.instances || new InstanceService({ store, runtime, secrets, units, root: config.dataDir, binaryByVersion, defaultVersion: config.version, requireVersion: true });
  const deleteService = overrides.deleteService || new DeleteService({ store, runtime, units, instances, auth });
  const clients = async instance => { const secret = instances.decryptManagementSecret(instance); return new HTTPClient({ baseUrl: `http://127.0.0.1:${instance.port}`, managementSecret: secret, quotaPath: config.quotaPath, maxRetries: 4, retryBaseMs: 150 }) }
  instances.healthCheck = async instance => { const client = await clients(instance); await client.health() }
  const quota = overrides.quota || new QuotaService({ store, instances, clients, secrets }); const source = overrides.source || new GitHubSource(); const installer = overrides.installer || new Installer({ source, root: versionsRoot }); const activator = overrides.activator || units; const upgrade = overrides.upgrade || new UpgradeService({ store, instances, runtime, activator, units, prepareVersion: binaryByVersion }); const versionService = overrides.versionService || new VersionService({ store, instances, installer });
  const controller = new Controller({ auth, instances, deleteService, quota, upgrade, installer, versionService, activator, store, staticRoot: config.staticRoot, secureCookies: config.secureCookies })
  return { store, secrets, auth, runtime, units, instances, deleteService, quota, installer, versionService, activator, upgrade, controller }
}

async function ensureInitialVersion(app, config, logger) {
  if (config.version) {
    try {
      const existing = app.store.getVersion(config.version)
      if (existing.usable) { app.instances.defaultVersion = config.version; return }
      logger.error(`configured CPA version ${config.version} is not usable`)
    } catch (error) {
      if (error.code !== 'ERR_NOT_FOUND') {
        logger.error(`configured CPA version ${config.version} is unavailable: ${error.message}`)
        return
      }
      try {
        const binary = executablePath(path.join(config.dataDir, 'versions'), config.version)
        const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')
        app.store.saveVersion({ tag: config.version, asset: '', path: path.dirname(binary), sha256: digest, installed_at: new Date().toISOString(), usable: true })
        app.instances.defaultVersion = config.version
        logger.info(`registered configured CPA version ${config.version}`)
        return
      } catch (registrationError) {
        logger.error(`configured CPA version ${config.version} is unavailable: ${registrationError.message}`)
        return
      }
    }
    return
  }
  if (config.skipVersionInstall) return
  try { const existing = app.store.listVersions().find(item => item.usable); if (existing) { app.instances.defaultVersion = existing.tag; return }; const installed = await app.installer.install(''); app.store.saveVersion(installed); await app.activator.activateVersion(installed.tag); app.instances.defaultVersion = installed.tag; logger.info(`installed initial CPA version ${installed.tag}`) } catch (error) { logger.error(`initial CPA version is not ready: ${error.message}`) }
}

export async function start(config = readConfig()) {
  const address = parseListen(config.listen)
  const logger = { info: (...args) => console.log('multi-cpa', ...args), error: (...args) => console.error('multi-cpa', ...args) }
  const app = createApplication(config)
  const runtimeLog = (level, message, context = {}) => { try { app.store.appendRuntimeLog({ level, source: 'controller', message, context }) } catch {} }
  delete process.env.MULTI_CPA_ADMIN_PASSWORD
  config = { ...config, adminPassword: '' }
  let ready = false
  const server = createHttpServer(app.controller, { isReady: () => ready })
  const abort = new AbortController()
  let scheduler = Promise.resolve()
  try {
    // Reserve the listener before any recovery can change child processes.
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('listening', listening); reject(error) }
      const listening = () => { server.removeListener('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', listening)
      server.listen(address.port, address.host)
    })
    await ensureInitialVersion(app, config, logger)
    await app.upgrade.recover().catch(error => { logger.error(`upgrade recovery requires attention: ${error.message}`); runtimeLog('error', `upgrade recovery requires attention: ${error.message}`) })
    await app.instances.reconcileDesired().catch(error => { logger.error(`desired-state recovery: ${error.message}`); runtimeLog('error', `desired-state recovery: ${error.message}`) })
    ready = true
    scheduler = app.quota.run(abort.signal).catch(error => {
      if (!abort.signal.aborted) { logger.error(`quota scheduler stopped: ${error.message}`); runtimeLog('error', `quota scheduler stopped: ${error.message}`) }
    })
    logger.info(`listening on ${config.listen} (runtime=${config.runtimeMode})`)
    runtimeLog('info', 'controller started', { listen: config.listen, runtime: config.runtimeMode })
  } catch (error) {
    abort.abort()
    await new Promise(resolve => server.close(() => resolve()))
    app.store.close()
    throw error
  }
  let closing
  const close = () => closing ||= (async () => {
    ready = false
    runtimeLog('info', 'controller stopping')
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    abort.abort()
    const closed = new Promise(resolve => server.close(() => resolve()))
    await scheduler
    await closed
    app.store.close()
  })()
  const onSignal = () => { void close().finally(() => process.exit(0)) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return { ...app, server, close }
}

if (process.env.MULTI_CPA_SEA !== '1' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start().catch(error => { console.error(`multi-cpa: ${error.message}`); process.exitCode = 1 })
