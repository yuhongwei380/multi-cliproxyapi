import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = path.join(projectRoot, 'release')
const stagingRoot = path.join(releaseRoot, '.staging-linux-x64')
const binaryName = 'multi-cliproxyapi-linux-x64'
const seaWorkRoot = path.join(os.tmpdir(), `multi-cliproxyapi-sea-${process.pid}`)
const seaBinaryPath = path.join(seaWorkRoot, binaryName)
const webDependencies = path.join(projectRoot, 'web', 'node_modules')
const binaryPath = path.join(releaseRoot, binaryName)
const releaseScripts = ['install.sh', 'start.sh', 'stop.sh', 'uninstall.sh']

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('run this packager inside WSL/Linux amd64')
if (process.versions.node.split('.').map(Number)[0] < 24) throw new Error('Node.js 24 or newer is required for this SEA packager')

function run(command, args) {
  console.log(`> ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' })
}

function filesUnder(directory) {
  const files = []
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) files.push(fullPath)
      else throw new Error(`unsupported frontend asset: ${fullPath}`)
    }
  }
  visit(directory)
  return files
}

function cleanTemporaryBuildFiles() {
  fs.rmSync(stagingRoot, { recursive: true, force: true })
  fs.rmSync(seaWorkRoot, { recursive: true, force: true })
  fs.rmSync(webDependencies, { recursive: true, force: true })
}

fs.mkdirSync(releaseRoot, { recursive: true })
cleanTemporaryBuildFiles()
fs.mkdirSync(stagingRoot, { recursive: true })
fs.mkdirSync(seaWorkRoot, { recursive: true })

try {
  run('npm', ['ci', '--prefix', 'web'])
  run('npm', ['--prefix', 'web', 'run', 'build'])

  const webDist = path.join(projectRoot, 'web', 'dist')
  const frontendAssets = filesUnder(webDist)
  if (!frontendAssets.some(file => path.basename(file) === 'index.html')) throw new Error('web/dist/index.html was not built')

  const bundlePath = path.join(stagingRoot, 'sea-main.cjs')
  run('npx', ['--yes', 'esbuild', 'server/sea-entry.cjs', '--bundle', '--platform=node', '--format=cjs', '--external:node:*', `--outfile=${bundlePath}`])

  const seaConfigPath = path.join(stagingRoot, 'sea-config.json')
  const blobPath = path.join(stagingRoot, 'sea-prep.blob')
  const assets = Object.fromEntries(frontendAssets.map(file => [path.relative(webDist, file).replaceAll(path.sep, '/'), file]))
  fs.writeFileSync(seaConfigPath, JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2))
  run(process.execPath, ['--experimental-sea-config', seaConfigPath])

  // Keep the large ELF on Linux's filesystem while postject parses and
  // rewrites it. Doing this on a Windows-mounted path can stall for minutes.
  fs.copyFileSync(process.execPath, seaBinaryPath)
  fs.chmodSync(seaBinaryPath, 0o755)
  // Node distributions used by WSL may carry several megabytes of debug
  // sections. postject's ELF parser expands those sections in memory; with
  // the default 2 GB WSL limit it can be OOM-killed before writing the blob.
  // A stripped runtime is fully compatible with SEA and keeps the release
  // smaller as well.
  run('strip', ['--strip-all', seaBinaryPath])
  run('npx', ['--yes', 'postject', seaBinaryPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'])
  fs.copyFileSync(seaBinaryPath, binaryPath)
  fs.chmodSync(binaryPath, 0o755)
  for (const script of releaseScripts) {
    const source = path.join(projectRoot, 'deploy', 'release', script)
    const destination = path.join(releaseRoot, script)
    fs.copyFileSync(source, destination)
    fs.chmodSync(destination, 0o755)
  }

  const digest = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex')
  fs.writeFileSync(`${binaryPath}.sha256`, `${digest}  ${binaryName}\n`)
  fs.writeFileSync(path.join(releaseRoot, 'README.md'), [
    '# Multi CLIProxyAPI binary release',
    '',
    `- Binary: ${binaryName}`,
    '- Target: Linux amd64',
    `- SHA-256: see ${binaryName}.sha256`,
    '',
    'The executable embeds the controller and web UI. For a server installation, run sudo bash install.sh, then use sudo bash start.sh and sudo bash stop.sh; the installer registers the controller service, the multi-cpa@.service template, and the restricted polkit rule. Instance data defaults to /opt/mutli-cliproxycpa-data (override with MULTI_CPA_DATA_DIR). Controller output is dual-written to the systemd journal and /var/log/multi-cpa.log; the installer configures daily logrotate with 7 days by default, or 14 days when MULTI_CPA_LOG_RETENTION_DAYS=14 is set during installation. ./uninstall.sh refuses to uninstall while any CPA child service or process is running (including old instances), and asks once before removing services and the binary, then asks for the exact data path before permanently deleting instance data; declining the second prompt keeps the data. Set MULTI_CPA_LISTEN and other supported environment variables before starting it. The first administrator password defaults to admin unless MULTI_CPA_ADMIN_PASSWORD is set; change it from the administrator avatar settings after login.',
    ''
  ].join('\n'))
  console.log(`created ${binaryPath}`)
  console.log(`sha256 ${digest}`)
} finally {
  cleanTemporaryBuildFiles()
}
