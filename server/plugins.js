import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DirectGitHubSource, extractArchive } from './release.js'
import { editChildConfig } from './child-config.js'
import { ConflictError } from './store.js'

// Reviewed descriptors, not remote scripts. Additional plugins use the same engine.
export const PLUGIN_CATALOG = [{ id: 'cpa-key-billing', name: 'Key Billing', owner: 'haowang02', repo: 'cpa-plugin-key-billing', entry: 'cpa-key-billing.so', asset: version => `cpa-key-billing_${version}_linux_amd64.tar.gz` }]
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const active = job => ['queued', 'running', 'blocked'].includes(job.state)
function regular(file) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('plugin path must be a regular file'); return stat }
function directory(file) { fs.mkdirSync(file, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('plugin directory must be a real directory') }
function atomic(file, bytes, mode = 0o600) { const temporary = `${file}.${crypto.randomUUID()}.tmp`; try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode }); fs.renameSync(temporary, file) } finally { fs.rmSync(temporary, { force: true }) } }
function elf(bytes) { if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== 62) throw new Error('plugin must be a Linux amd64 ELF shared library') }

export class PluginArtifacts {
  constructor({ root, catalog = PLUGIN_CATALOG, sourceFactory = descriptor => new DirectGitHubSource({ ...descriptor, maxAssetBytes: 64 * 1024 * 1024 }) }) { Object.assign(this, { root, catalog, sourceFactory }) }
  descriptor(id) { const item = this.catalog.find(item => item.id === id); if (!item) throw Object.assign(new Error('unsupported plugin'), { status: 400 }); return item }
  async prepare(id, requested = '') {
    const descriptor = this.descriptor(id); const source = this.sourceFactory(descriptor)
    if (typeof requested !== 'string' || (requested && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(requested))) throw Object.assign(new Error('invalid plugin version'), { status: 400 })
    const tag = requested ? `v${requested.replace(/^v/, '')}` : await source.latestTag()
    if (!/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag)) throw new Error('invalid plugin release tag')
    const version = tag.replace(/^v/, ''); directory(this.root)
    const cache = path.join(this.root, `${id}-${version}`)
    if (fs.existsSync(cache)) {
      directory(cache); const file = path.join(cache, descriptor.entry); regular(file)
      regular(path.join(cache, 'manifest.json')); const manifest = JSON.parse(fs.readFileSync(path.join(cache, 'manifest.json')))
      const bytes = fs.readFileSync(file); elf(bytes)
      if (manifest.version !== version || manifest.id !== id || digest(bytes) !== manifest.sha256) throw new Error('plugin cache integrity mismatch')
      return { ...manifest, file }
    }
    const url = name => `https://github.com/${descriptor.owner}/${descriptor.repo}/releases/download/${tag}/${name}`
    const name = descriptor.asset(version)
    const checksums = (await source.download({ url: url('checksums.txt'), size: 0 })).toString('utf8')
    const matches = checksums.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line)).filter(match => match && match[2].trim() === name)
    if (matches.length !== 1) throw new Error('release checksum missing or ambiguous')
    const archiveBytes = await source.download({ url: url(name), size: 0, digest: `sha256:${matches[0][1]}` })
    if (digest(archiveBytes) !== matches[0][1].toLowerCase()) throw new Error('plugin archive checksum mismatch')
    const temporary = fs.mkdtempSync(path.join(this.root, '.stage-')); const archive = `${temporary}.tar.gz`
    try {
      fs.writeFileSync(archive, archiveBytes, { mode: 0o600 }); await extractArchive(archive, temporary)
      const file = path.join(temporary, descriptor.entry); regular(file); const bytes = fs.readFileSync(file); elf(bytes)
      const manifest = { id, version, sha256: digest(bytes), archive_sha256: digest(archiveBytes) }
      // Keep only the reviewed library and manifest in the immutable cache.
      for (const item of fs.readdirSync(temporary)) if (item !== descriptor.entry) fs.rmSync(path.join(temporary, item), { recursive: true, force: true })
      fs.chmodSync(file, 0o755); fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 }); fs.renameSync(temporary, cache)
      return { ...manifest, file: path.join(cache, descriptor.entry) }
    } finally { fs.rmSync(archive, { force: true }); fs.rmSync(temporary, { recursive: true, force: true }) }
  }
}

export class PluginService {
  constructor({ store, instances, runtime, clients, artifacts }) { Object.assign(this, { store, instances, runtime, clients, artifacts }); this.pending = null }
  assertIdle() { if (this.store.listPluginJobs().some(active)) throw new ConflictError('plugin deployment requires completion or recovery first') }
  jobs() { return this.store.listPluginJobs() }
  deleteRecord(id) { this.store.deletePluginJob(id) }
  save(job) { job.updated_at = new Date().toISOString(); this.store.savePluginJob(job) }
  async inventory() {
    const items = []
    for (const instance of this.store.listInstances()) {
      const status = await this.runtime.status(instance)
      let payload; let message = ''
      if (status.state === 'running') { try { payload = JSON.parse((await (await this.clients(instance)).request('GET', '/v0/management/plugins')).body) } catch (error) { message = error.message } }
      const plugins = this.artifacts.catalog.map(descriptor => {
        const file = path.join(instance.directory, 'plugins', descriptor.entry)
        let installed = false; let version = ''; try { regular(file); installed = true; const manifestFile = `${file}.json`; regular(manifestFile); const manifest = JSON.parse(fs.readFileSync(manifestFile)); if (manifest.sha256 === digest(fs.readFileSync(file))) version = manifest.version } catch {}
        const live = payload?.plugins?.find(item => item.id === descriptor.id)
        return { id: descriptor.id, installed, version: live?.metadata?.version || version, registered: live?.registered ?? null, enabled: live?.effective_enabled ?? null, verification: live ? 'live' : 'pending' }
      })
      items.push({ id: instance.id, name: instance.name, locked: instance.locked, state: status.state, plugins, message })
    }
    return { catalog: this.artifacts.catalog.map(({ id, name, owner, repo }) => ({ id, name, repository: `${owner}/${repo}` })), instances: items }
  }
  submit({ plugin, version = '', instances: ids, enable = false }) {
    this.assertIdle(); this.instances.assertUpgradeIdle(); this.artifacts.descriptor(plugin)
    if (typeof version !== 'string' || (version && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) || typeof enable !== 'boolean' || !Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw Object.assign(new Error('invalid plugin deployment request'), { status: 400 })
    const results = ids.map(id => { const instance = this.store.getInstance(id); return { id, state: instance.locked ? 'skipped-locked' : 'pending' } })
    const job = { id: crypto.randomUUID(), plugin, version, enable, state: 'queued', results, created_at: new Date().toISOString(), message: '' }; this.save(job)
    this.pending = this.instances.operations.run('global', () => this.run(job)).catch(error => { job.state = 'blocked'; job.message = error.message; this.save(job) }).finally(() => { this.pending = null })
    return job
  }
  async run(job) {
    job.state = 'running'; this.save(job)
    try {
      const artifact = await this.artifacts.prepare(job.plugin, job.version); job.version = artifact.version; this.save(job)
      for (const result of job.results) {
        if (result.state !== 'pending') continue
        await this.instances.withInstanceLock(result.id, async () => {
          const instance = this.store.getInstance(result.id)
          if (instance.locked) { result.state = 'skipped-locked'; this.save(job); return }
          await this.deploy(job, result, instance, artifact)
        })
      }
      job.state = 'completed'
    } catch (error) {
      job.state = job.results.some(item => item.state === 'blocked') ? 'blocked' : 'failed'; job.message = error.message
      for (const result of job.results) {
        if (result.state === 'pending') result.state = 'cancelled'
        else if (result.state === 'backing-up') { result.state = 'failed'; result.message = error.message }
      }
    }
    this.save(job)
  }
  paths(job, instance) {
    if (!/^[a-f0-9-]{36}$/.test(job.id) || path.resolve(instance.directory) !== path.resolve(this.instances.root, 'instances', instance.id)) throw new Error('unsafe plugin deployment path')
    const stat = fs.lstatSync(instance.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('instance directory must be a real directory')
    const descriptor = this.artifacts.descriptor(job.plugin)
    const plugins = path.join(instance.directory, 'plugins'); const backups = path.join(instance.directory, '.plugin-backups'); directory(plugins); directory(backups)
    const backup = path.join(backups, job.id); const file = path.join(plugins, descriptor.entry)
    return { backup, file, manifest: `${file}.json`, config: path.join(instance.directory, 'config.yaml') }
  }
  async deploy(job, result, instance, artifact) {
    const files = this.paths(job, instance); const status = await this.runtime.status(instance)
    if (!['running', 'stopped', 'failed'].includes(status.state)) throw new Error(`instance state ${status.state} is not safe for deployment`)
    if (status.state === 'running' && fs.existsSync(files.file)) {
      const payload = JSON.parse((await (await this.clients(instance)).request('GET', '/v0/management/plugins')).body)
      const previous = payload.plugins?.find(item => item.id === job.plugin)
      if (typeof previous?.effective_enabled === 'boolean') result.previous_enabled = previous.effective_enabled
    }
    result.was_running = status.state === 'running'; result.state = 'backing-up'; this.save(job)
    directory(files.backup)
    for (const [key, file] of Object.entries(files)) {
      if (!['file', 'manifest', 'config'].includes(key)) continue
      if (fs.existsSync(file)) { regular(file); fs.copyFileSync(file, path.join(files.backup, key)); fs.chmodSync(path.join(files.backup, key), 0o600) }
    }
    if (!fs.existsSync(path.join(files.backup, 'config'))) throw new Error('instance config missing')
    result.state = 'prepared'; this.save(job) // Backups durable before the first runtime mutation.
    try {
      if (result.was_running) { await this.runtime.stop(instance); if (!['stopped', 'failed'].includes((await this.runtime.status(instance)).state)) throw new Error('instance stop not confirmed') }
      result.state = 'installing'; this.save(job)
      atomic(files.file, fs.readFileSync(artifact.file), 0o755); atomic(files.manifest, JSON.stringify({ id: job.plugin, version: artifact.version, sha256: artifact.sha256 }))
      if (job.enable) atomic(files.config, editChildConfig(fs.readFileSync(files.config, 'utf8'), { plugin: { id: job.plugin } }))
      if (result.was_running) {
        result.state = 'verifying'; this.save(job); await this.runtime.start(instance); await this.instances.confirmStarted(instance); await this.verify(instance, job, result)
      }
      result.state = result.was_running ? 'verified' : 'installed-pending-verification'; this.save(job)
    } catch (error) {
      result.message = error.message
      try { await this.restore(job, result, instance); result.state = 'rolled-back' } catch (restoreError) { result.state = 'blocked'; result.message += `; rollback: ${restoreError.message}` }
      this.save(job); throw error
    }
  }
  async verify(instance, job, result = {}) {
    let last
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const payload = JSON.parse((await (await this.clients(instance)).request('GET', '/v0/management/plugins')).body)
        const plugin = payload.plugins?.find(item => item.id === job.plugin)
        if (!plugin?.registered || plugin.metadata?.version !== job.version || (job.enable && !plugin.effective_enabled)) throw new Error('plugin registration/version/enable verification failed')
        if (!job.enable && typeof result.previous_enabled === 'boolean' && plugin.effective_enabled !== result.previous_enabled) throw new Error('plugin enable state changed during upgrade')
        return
      } catch (error) { last = error; if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 500)) }
    }
    throw last
  }
  async restore(job, result, instance) {
    const files = this.paths(job, instance); directory(files.backup); regular(path.join(files.backup, 'config'))
    result.state = 'restoring'; this.save(job)
    await this.runtime.stop(instance); if (!['stopped', 'failed'].includes((await this.runtime.status(instance)).state)) throw new Error('rollback stop not confirmed')
    for (const key of ['file', 'manifest', 'config']) {
      const saved = path.join(files.backup, key)
      if (fs.existsSync(saved)) { regular(saved); atomic(files[key], fs.readFileSync(saved), key === 'file' ? 0o755 : 0o600) } else fs.rmSync(files[key], { force: true })
    }
    if (result.was_running) { await this.runtime.start(instance); await this.instances.confirmStarted(instance); await (await this.clients(instance)).health() }
  }
  async recover() {
    if (this.pending) throw new ConflictError('plugin deployment is still running')
    return this.instances.operations.run('global', async () => {
      for (const job of this.jobs().filter(active)) {
        let blocked = false
        for (const result of job.results) {
          if (['prepared', 'installing', 'verifying', 'restoring', 'blocked'].includes(result.state)) {
            try { await this.instances.withInstanceLock(result.id, () => this.restore(job, result, this.store.getInstance(result.id))); result.state = 'rolled-back' } catch (error) { blocked = true; result.state = 'blocked'; result.message = error.message }
          } else if (result.state === 'backing-up') result.state = 'cancelled'
          else if (result.state === 'pending') result.state = 'cancelled'
        }
        job.state = blocked ? 'blocked' : 'failed'; job.message = blocked ? 'rollback requires attention; retry recovery' : 'interrupted deployment recovered; submit a new deployment to continue'; this.save(job)
      }
    })
  }
}
