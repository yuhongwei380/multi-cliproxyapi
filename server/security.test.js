import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkPassword, hashPassword, openSecretStore, normalizeBearer } from './security.js'

test('password hashing accepts short test passwords and verifies without storing plaintext', () => {
  assert.throws(() => hashPassword(''), /non-empty/)
  const short = hashPassword('a')
  assert.equal(checkPassword(short, 'a'), true)
  const encoded = hashPassword('correct horse battery staple')
  assert.match(encoded, /^scrypt\$/)
  assert.equal(checkPassword(encoded, 'correct horse battery staple'), true)
  assert.equal(checkPassword(encoded, 'wrong password'), false)
  assert.equal(encoded.includes('correct horse'), false)
})

test('file secret store encrypts, persists, and detects tampering', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-secret-')); const file = path.join(directory, 'secrets.key')
  const first = openSecretStore(file); const encrypted = first.encrypt('child-management-secret'); assert.notEqual(encrypted, 'child-management-secret'); assert.equal(first.decrypt(encrypted), 'child-management-secret')
  const second = openSecretStore(file); assert.equal(second.decrypt(encrypted), 'child-management-secret')
  const parts = encrypted.split(':'); const payload = Buffer.from(parts[2], 'base64url'); payload[0] ^= 1; parts[2] = payload.toString('base64url'); assert.throws(() => second.decrypt(parts.join(':')), /unable to decrypt|invalid/)
})

test('bearer normalization accepts only bearer scheme', () => {
  assert.equal(normalizeBearer('Bearer abc'), 'abc'); assert.equal(normalizeBearer('bearer  abc '), 'abc'); assert.equal(normalizeBearer('Basic abc'), '')
})
