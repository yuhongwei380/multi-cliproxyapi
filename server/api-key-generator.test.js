import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { generateSecureApiKey } from './api-key-generator.js'

test('server preserves the CPA generator exactly except TypeScript annotations', () => {
  const source = fs.readFileSync(new URL('../web/src/apiKey.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const javascript = fs.readFileSync(new URL('./api-key-generator.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  assert.equal(javascript, source.replace('generateSecureApiKey(): string', 'generateSecureApiKey()').replace('characters: string[]', 'characters'))
})

test('CPA generator rejects 248-255 and refills with the upstream batch size', t => {
  const sizes = []
  t.mock.method(globalThis.crypto, 'getRandomValues', bytes => {
    sizes.push(bytes.length)
    if (sizes.length === 1) bytes.fill(255)
    else { bytes.fill(0); bytes[0] = 61; bytes[1] = 62; bytes[2] = 247 }
    return bytes
  })
  assert.equal(generateSecureApiKey(), 'sk-9A9' + 'A'.repeat(45))
  assert.deepEqual(sizes, [53, 53])
})
