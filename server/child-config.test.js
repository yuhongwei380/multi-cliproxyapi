import test from 'node:test'
import assert from 'node:assert/strict'
import { editChildConfig } from './child-config.js'

const config = `plugins:
    enabled: true
    custom:
        enabled: false
server:
    host: 0.0.0.0
    port: 8322
management:
    allow-remote: true
    secret-key: "$2a$existing-hash"
    disable-control-panel: false
oauth:
    auth-dir: "/opt/data/auths"
observability:
    logs:
        logging-to-file: true
config-version: 8
access:
    api-keys:
        - "keep-this-key"
`
const options = { host: '0.0.0.0', secret: 'admin', ensure: true }

test('v8 four-space configuration survives repeated starts byte for byte', () => {
  const first = editChildConfig(config, options)
  assert.equal(first, config)
  assert.equal(editChildConfig(first, options), config)
})

test('v8 edits only server and management fields and preserves plugin data', () => {
  const updated = editChildConfig(config, { ...options, port: 8333, replaceSecret: true, secret: 'new "password"' })
  assert.equal(updated, config.replace('port: 8322', 'port: 8333').replace('"$2a$existing-hash"', JSON.stringify('new "password"')))
  assert.equal(editChildConfig(updated, options), updated)
})

test('legacy four-space mappings are scoped and retain their indentation', () => {
  const legacy = `host: 127.0.0.1
port: 8322
other:
    secret-key: "unrelated"
    enabled: false
remote-management:
    secret-key: "" # fill me
plugins:
    enabled: false
    custom:
        enabled: false
`
  const updated = editChildConfig(legacy, options)
  assert.match(updated, /^host: 0\.0\.0\.0$/m)
  assert.match(updated, /other:\n    secret-key: "unrelated"\n    enabled: false/)
  assert.match(updated, /remote-management:\n    secret-key: "admin"\n    allow-remote: true\n    disable-control-panel: false/)
  assert.match(updated, /plugins:\n    enabled: true\n    custom:\n        enabled: false/)
  assert.equal(editChildConfig(updated, options), updated)
})

test('missing settings use v8 sections and preserve CRLF', () => {
  const updated = editChildConfig('config-version: 8\r\n', options)
  assert.match(updated, /server:\r\n  host: 0\.0\.0\.0/)
  assert.match(updated, /management:\r\n  allow-remote: true/)
  assert.doesNotMatch(updated, /remote-management:/)
  assert.equal(editChildConfig(updated, options), updated)
})

test('refuses the reported mixed-indent corruption and duplicate plugin keys', () => {
  assert.throws(() => editChildConfig(config.replace('    enabled: true', '    enabled: true\n  enabled: true'), options), /inconsistent indentation/)
  assert.throws(() => editChildConfig(config.replace('    enabled: true', '    enabled: true\n    enabled: true'), options), /duplicate CPA config key/)
})

test('unsupported inline mapping fails without silently adding another section', () => {
  assert.throws(() => editChildConfig('plugins: {enabled: true}\n', options), /must be a block mapping/)
})
