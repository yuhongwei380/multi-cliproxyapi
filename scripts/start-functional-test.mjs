import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../server/store.js'
import { readConfig, start } from '../server/index.js'

// Dedicated real-CPA acceptance environment; never opens the user's database.
const root = fs.mkdtempSync(path.resolve('.functional-test-'))
const version = process.env.MULTI_CPA_VERSION || '7.2.159'
const source = path.resolve('.local-data', 'versions', version)
const destination = path.join(root, 'versions', version)
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.cpSync(source, destination, { recursive: true, dereference: false })
const store = new Store(path.join(root, 'control.db'))
store.saveVersion({ tag: version, path: destination, usable: true, installed_at: new Date().toISOString() })
store.close()
const config = readConfig()
Object.assign(config, { dataDir: root, listen: process.env.MULTI_CPA_LISTEN || '0.0.0.0:18787', runtimeMode: 'process', version, skipVersionInstall: true })
console.log(`Functional test data: ${root}`)
await start(config)
