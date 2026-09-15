import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function renderControllerUnit(template, prefix, dataDir = '/opt/mutli-cliproxycpa-data') {
  if (!path.posix.isAbsolute(prefix) || /[\r\n\0]/.test(prefix)) throw new Error('PREFIX must be an absolute Linux path')
  if (!path.posix.isAbsolute(dataDir) || /[\r\n\0%]/.test(dataDir) || /[^A-Za-z0-9_./:-]/.test(dataDir)) throw new Error('data directory must be an absolute safe Linux path')
  const installRoot = path.posix.join(prefix, 'lib', 'multi-cliproxyapi')
  // systemd expands percent specifiers even inside quoted arguments.
  const quote = value => JSON.stringify(value.replaceAll('%', '%%'))
  const command = `ExecStart=${quote(`${installRoot}/runtime/node`)} ${quote(`${installRoot}/server/index.js`)} --data-dir ${quote(dataDir)} --listen 0.0.0.0:8787 --runtime systemd`
  if (!/^ExecStart=.*$/m.test(template)) throw new Error('controller unit has no ExecStart')
  return template.replaceAll('/opt/mutli-cliproxycpa-data', dataDir).replace(/^ExecStart=.*$/m, command)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, destination, prefix, dataDir] = process.argv
  fs.writeFileSync(destination, renderControllerUnit(fs.readFileSync(source, 'utf8'), prefix, dataDir), { mode: 0o644 })
}
