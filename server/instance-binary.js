import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const binaryName = 'cli-proxy-api'

export function instanceBinaryPath(instance) {
  return path.join(instance.directory, 'bin', binaryName)
}

function instanceBinaryMarker(instance) {
  return path.join(instance.directory, 'bin', `${binaryName}.version`)
}

function regularFile(file) {
  try {
    const info = fs.lstatSync(file)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function executableFile(file) {
  try {
    const info = fs.lstatSync(file)
    return info.isFile() && !info.isSymbolicLink() && Boolean(info.mode & 0o111)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function ensureBinaryDirectory(instance) {
  const directory = path.join(instance.directory, 'bin')
  try {
    const info = fs.lstatSync(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('instance binary directory is not a real directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
  }
  fs.chmodSync(directory, 0o700)
  return directory
}

export async function prepareInstanceBinary(instance, binaryByVersion) {
  if (typeof binaryByVersion !== 'function') return { path: instanceBinaryPath(instance), changed: false }
  if (!instance?.version) throw new Error('instance version is empty')
  const directory = ensureBinaryDirectory(instance)
  const target = instanceBinaryPath(instance)
  const marker = instanceBinaryMarker(instance)
  const expectedMarker = `${instance.version}\n`
  const source = await binaryByVersion(instance.version)
  if (typeof source !== 'string' || !path.isAbsolute(source) || !regularFile(source)) throw new Error('source CPA binary is not a regular file')
  prepareManagementPage(instance, path.dirname(source))
  if (executableFile(target) && regularFile(marker)) {
    if (fs.readFileSync(marker, 'utf8') === expectedMarker) return { path: target, changed: false }
  } else if (fs.existsSync(target)) {
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('instance binary is not a regular file')
  }

  const suffix = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`
  const temporary = path.join(directory, `.${binaryName}.tmp-${suffix}`)
  const temporaryMarker = path.join(directory, `.${binaryName}.version.tmp-${suffix}`)
  try {
    fs.copyFileSync(source, temporary)
    fs.chmodSync(temporary, 0o755)
    fs.writeFileSync(temporaryMarker, expectedMarker, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, target)
    fs.renameSync(temporaryMarker, marker)
    fs.chmodSync(target, 0o755)
    fs.chmodSync(marker, 0o600)
    return { path: target, changed: true }
  } finally {
    try { fs.rmSync(temporary, { force: true }) } catch {}
    try { fs.rmSync(temporaryMarker, { force: true }) } catch {}
  }
}

// A release can include a cached control panel. Copy it independently so new
// instances do not need Internet access to serve that already-installed page.
export function prepareManagementPage(instance, versionDirectory) {
  const sourceDirectory = path.join(versionDirectory, 'static')
  if (!fs.existsSync(sourceDirectory)) return false
  const sourceInfo = fs.lstatSync(sourceDirectory)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('management asset directory is unsafe')
  const source = path.join(sourceDirectory, 'management.html')
  if (!regularFile(source)) return false
  const directory = path.join(instance.directory, 'static')
  try { fs.mkdirSync(directory, { recursive: false, mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('instance management directory is unsafe')
  const target = path.join(directory, 'management.html')
  if (regularFile(target)) return false
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(target, 0o600)
  return true
}
