import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { renderControllerUnit } from '../deploy/render-controller-unit.mjs'

test('installed systemd service uses the selected prefix and a runtime outside the user home', () => {
  const template = fs.readFileSync(new URL('../deploy/systemd/multi-cliproxyapi.service', import.meta.url), 'utf8')
  const rendered = renderControllerUnit(template, '/opt/custom install%')
  assert.match(rendered, /ExecStart="\/opt\/custom install%%\/lib\/multi-cliproxyapi\/runtime\/node" "\/opt\/custom install%%\/lib\/multi-cliproxyapi\/server\/index.js"/)
  assert.match(rendered, /--runtime systemd/)
  assert.doesNotMatch(rendered, /\/usr\/bin\/node/)
  assert.throws(() => renderControllerUnit(template, 'relative'), /absolute/)
  assert.throws(() => renderControllerUnit(template, '/opt/bad\nExecStart=bad'), /absolute/)
  const dataDir = '/home/vesoft/cpa/.multi-cliproxyapi'
  const renderedWithDataDir = renderControllerUnit(template, '/opt/custom', dataDir)
  assert.match(renderedWithDataDir, /WorkingDirectory=\/home\/vesoft\/cpa\/\.multi-cliproxyapi/)
  assert.match(renderedWithDataDir, /--data-dir "\/home\/vesoft\/cpa\/\.multi-cliproxyapi"/)
  assert.throws(() => renderControllerUnit(template, '/opt/custom', 'relative'), /absolute/)
  const binaryInstaller = fs.readFileSync(new URL('../deploy/release/install.sh', import.meta.url), 'utf8')
  assert.match(binaryInstaller, /WorkingDirectory=\$DATA_DIR\n/)
  assert.doesNotMatch(binaryInstaller, /WorkingDirectory="\$DATA_DIR"/)
  assert.match(binaryInstaller, /DATA_DIR=\$\{MULTI_CPA_DATA_DIR:-\/opt\/mutli-cliproxycpa-data\}/)
  assert.match(binaryInstaller, /ProtectHome=read-only/)
  const sourceInstaller = fs.readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8')
  assert.match(sourceInstaller, /data_dir=\$\{MULTI_CPA_DATA_DIR:-\/opt\/mutli-cliproxycpa-data\}/)
  assert.doesNotMatch(sourceInstaller, /--home-dir \/var\/lib\/multi-cliproxyapi/)
  assert.doesNotMatch(sourceInstaller, /install -d -o multi-cpa -g multi-cpa -m 0750 \/var\/lib\/multi-cliproxyapi/)
  assert.match(template, /ProtectHome=read-only/)
  const seaEntry = fs.readFileSync(new URL('./sea-entry.cjs', import.meta.url), 'utf8')
  assert.match(seaEntry, /MULTI_CPA_RUNTIME.*process/)
  assert.match(seaEntry, /MULTI_CPA_DATA_DIR.*'\/opt\/mutli-cliproxycpa-data'/)
})
