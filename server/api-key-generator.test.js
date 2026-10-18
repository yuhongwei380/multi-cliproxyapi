import test from 'node:test'
import assert from 'node:assert/strict'
import { generateApiKey } from '../shared/api-key.js'

test('shared key generation rejects biased bytes and refills to 48 characters', t => {
  let batches = 0
  t.mock.method(globalThis.crypto, 'getRandomValues', bytes => {
    batches++
    if (batches === 1) bytes.fill(255)
    else { bytes.fill(0); bytes[0] = 61; bytes[1] = 62; bytes[2] = 247 }
    return bytes
  })
  assert.equal(generateApiKey(), 'sk-9A9' + 'A'.repeat(45))
  assert.equal(batches, 2)
})
