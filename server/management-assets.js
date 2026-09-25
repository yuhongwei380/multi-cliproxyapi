import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DirectGitHubSource } from './release.js'

const maxBytes = 16 * 1024 * 1024
function validPage(bytes) {
  return bytes.length > 0 && bytes.length <= maxBytes && /<html[\s>]/i.test(bytes.toString('utf8')) && /<\/html>/i.test(bytes.toString('utf8'))
}

export class ManagementAssets {
  constructor({ source = new DirectGitHubSource({ repo: 'Cli-Proxy-API-Management-Center', maxAssetBytes: maxBytes, timeoutMs: 15000 }) } = {}) {
    this.source = source
    this.pending = new Map()
  }
  async ensure(versionDirectory) {
    if (this.pending.has(versionDirectory)) return this.pending.get(versionDirectory)
    const task = this.prepare(versionDirectory)
    this.pending.set(versionDirectory, task)
    try { return await task } finally { this.pending.delete(versionDirectory) }
  }
  async prepare(versionDirectory) {
    let temporary
    try {
      const versionInfo = fs.lstatSync(versionDirectory)
      if (!versionInfo.isDirectory() || versionInfo.isSymbolicLink()) throw new Error('unsafe version directory')
      const directory = path.join(versionDirectory, 'static')
      try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      const info = fs.lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe static directory')
      const file = path.join(directory, 'management.html')
      try {
        const cached = fs.lstatSync(file)
        if (!cached.isFile() || cached.isSymbolicLink()) throw new Error('unsafe management page')
        if (cached.size <= maxBytes && validPage(fs.readFileSync(file))) return file
        throw new Error('cached management page is invalid')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const latestAsset = typeof this.source.latestAsset === 'function' ? await this.source.latestAsset('management.html') : null
      const release = latestAsset ? null : await this.source.latest()
      const assets = latestAsset ? [latestAsset] : (release.assets || []).filter(asset => asset.name === 'management.html')
      if (assets.length !== 1) throw new Error('official release must contain one management.html asset')
      const bytes = await this.source.download(assets[0])
      if (!validPage(bytes)) throw new Error('downloaded management page is invalid')
      temporary = path.join(directory, `.management-${crypto.randomUUID()}.tmp`)
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
      return file
    } catch (error) {
      throw Object.assign(new Error(`CPA 管理页面资源准备失败：${error.message}。请检查总控访问官方 GitHub 发布的网络后重试。`), { status: 409, code: 'ERR_MANAGEMENT_ASSETS' })
    } finally {
      if (temporary) { try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    }
  }
}
