'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sea = require('node:sea')

function materializeFrontend() {
  if (!sea.isSea()) return
  const root = path.join(os.tmpdir(), `multi-cliproxyapi-static-${process.pid}`)
  for (const key of sea.getAssetKeys()) {
    const destination = path.resolve(root, key)
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe embedded asset path: ${key}`)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.writeFileSync(destination, Buffer.from(sea.getAsset(key)), { mode: 0o600 })
  }
  process.env.MULTI_CPA_STATIC_ROOT = root
  process.once('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
}

process.env.MULTI_CPA_SEA = '1'
// A copied SEA executable is commonly launched directly with `nohup` rather
// than through the installed systemd controller unit. In that mode the
// caller usually is not the dedicated `multi-cpa` account and cannot pass
// polkit authorization for `systemctl`. Keep child processes detached from
// the controller by default, while allowing an explicit environment variable
// or --runtime systemd argument to select the production systemd adapter.
if (!process.env.MULTI_CPA_RUNTIME) process.env.MULTI_CPA_RUNTIME = 'process'
// Match the installer default; explicit environment and CLI paths override it.
if (!process.env.MULTI_CPA_DATA_DIR) process.env.MULTI_CPA_DATA_DIR = '/opt/mutli-cliproxycpa-data'
materializeFrontend()

const { start } = require('./index.js')
start().catch(error => { console.error(`multi-cpa: ${error.message}`); process.exitCode = 1 })
