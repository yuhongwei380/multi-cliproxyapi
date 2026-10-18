import fs from 'node:fs'
import path from 'node:path'
import { ConflictError } from './store.js'

// A test clone must never retain an absolute reference to its source data.
export function relocateBackupConfig(config, source, target) {
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*([\w-]+):\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    if (!/(?:dir|path|file|database|dsn|db)$/.test(match[1]) && !match[2].includes(source) && !match[2].includes(JSON.stringify(source).slice(1, -1))) continue
    let value = match[2]
    if (value.startsWith('"')) {
      const quoted = /^"(?:[^"\\]|\\.)*"/.exec(value)?.[0]
      if (!quoted) throw new ConflictError('cannot read backup configuration path')
      try { value = JSON.parse(quoted) } catch { throw new ConflictError('cannot read backup configuration path') }
    } else if (value.startsWith("'")) value = /^'((?:[^']|'')*)'/.exec(value)?.[1]?.replaceAll("''", "'") || ''
    else value = value.replace(/\s+#.*$/, '')
    let storagePath = value
    if (value.startsWith('file:')) storagePath = value.slice(5).split('?')[0]
    else if (value.startsWith('sqlite://')) storagePath = value.slice(9).split('?')[0]
    else if (/(?:database|dsn|db)$/.test(match[1]) && /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) throw new ConflictError('备份仅支持实例目录内的本地数据库')
    if (path.isAbsolute(storagePath) || /^[A-Za-z]:[\\/]/.test(storagePath)) {
      const relative = path.relative(source, path.resolve(storagePath))
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ConflictError(`备份不支持实例目录外的配置路径（${match[1]}），请先将数据移入实例目录`)
    } else if (/(?:dir|path|file|database|dsn|db)$/.test(match[1]) && (storagePath.startsWith('~') || storagePath.split(/[\\/]/).includes('..'))) {
      throw new ConflictError(`备份不支持指向实例目录外的配置路径（${match[1]}）`)
    }
  }
  for (const [from, to] of [[JSON.stringify(source).slice(1, -1), JSON.stringify(target).slice(1, -1)], [source, target], [source.replaceAll('\\', '/'), target.replaceAll('\\', '/')]]) config = config.replaceAll(from, to)
  return config
}

export function backupMetadata(instance) {
  try {
    const file = path.join(instance.directory, '.multi-cpa-backup.json')
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof value.source_id !== 'string' || typeof value.source_name !== 'string') return undefined
    return { source_id: value.source_id, source_name: value.source_name, automatic: value.automatic === true, reason: String(value.reason || ''), created_at: String(value.created_at || '') }
  } catch { return undefined }
}

export function copyBackupTree(from, to) {
  const stat = fs.lstatSync(from)
  if (stat.isSymbolicLink()) throw new ConflictError('备份不支持实例数据中的符号链接')
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const entry of fs.readdirSync(from)) copyBackupTree(path.join(from, entry), path.join(to, entry))
  } else if (stat.isFile()) { fs.copyFileSync(from, to); fs.chmodSync(to, stat.mode & 0o111 ? 0o700 : 0o600) }
  else throw new ConflictError('备份不支持实例数据中的特殊文件')
}
