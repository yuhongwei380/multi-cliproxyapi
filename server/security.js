import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('password must be a non-empty string')
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export function checkPassword(encoded, password) {
  if (typeof encoded !== 'string' || typeof password !== 'string' || !password) return false
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3])
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || r < 1 || p < 1) return false
  try {
    const salt = Buffer.from(parts[4], 'base64url')
    const expected = Buffer.from(parts[5], 'base64url')
    const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 })
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch { return false }
}

export function normalizeBearer(header = '') {
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : ''
}
export function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex') }
export function newToken() { return crypto.randomBytes(32).toString('hex') }

function ensurePrivateFile(file, bytes) {
  const parent = path.dirname(file)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  let key
  try {
    const info = fs.lstatSync(file)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('secret key path must be a regular file')
    key = fs.readFileSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    key = crypto.randomBytes(bytes)
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' })
  }
  if (key.length !== bytes) throw new Error(`secret key must be ${bytes} bytes`)
  fs.chmodSync(file, 0o600)
  return key
}

export function openSecretStore(file) {
  const key = ensurePrivateFile(file, 32)
  return {
    encrypt(value) {
      const nonce = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return `v1:${nonce.toString('base64url')}:${Buffer.concat([encrypted, tag]).toString('base64url')}`
    },
    decrypt(value) {
      const parts = String(value).split(':')
      if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('invalid encrypted secret')
      let nonce; let payload
      try { nonce = Buffer.from(parts[1], 'base64url'); payload = Buffer.from(parts[2], 'base64url') } catch { throw new Error('invalid encrypted secret') }
      if (nonce.length !== 12 || payload.length < 17) throw new Error('invalid encrypted secret')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(payload.subarray(payload.length - 16))
      try { return Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString('utf8') } catch { throw new Error('unable to decrypt secret') }
    }
  }
}
