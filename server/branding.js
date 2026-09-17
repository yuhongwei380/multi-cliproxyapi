export const DEFAULT_BRANDING = Object.freeze({
  brand_name: 'CPA',
  brand_subtitle: 'CONTROL CENTER',
  banner_title: '静候流量。',
  banner_description: 'CPA 总控 · 统一管理本机的 CLI Proxy API 实例。',
  page_title: 'CLI Proxy API Management Center',
  page_description: 'CPA 总控 · Local Control Plane',
  copyright: '© 2026 Multi CLIProxyAPI',
  icon: '',
  logo: ''
})

const MAX_LOGO_BYTES = 256 * 1024
const MAX_LOGO_DATA_URL_LENGTH = 384 * 1024
const LOGO_TYPES = new Map([
  ['image/png', bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/webp', bytes => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'],
  ['image/gif', bytes => bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))]
])

const FIELD_RULES = {
  brand_name: { max: 48 },
  brand_subtitle: { max: 64, allowEmpty: true },
  banner_title: { max: 80 },
  banner_description: { max: 180 },
  page_title: { max: 80 },
  page_description: { max: 180 },
  copyright: { max: 160, allowEmpty: true },
  icon: { max: 32, allowEmpty: true },
  logo: { max: MAX_LOGO_DATA_URL_LENGTH, allowEmpty: true }
}

function invalid(message) { return Object.assign(new Error(message), { status: 400 }) }

function cleanField(name, value, fallback, rule) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw invalid(`${name} must be a string`)
  const normalized = value.trim()
  if (!normalized && !rule.allowEmpty) throw invalid(`${name} is required`)
  if (normalized.length > rule.max) throw invalid(`${name} is too long`)
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw invalid(`${name} contains control characters`)
  return normalized
}

function cleanLogo(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw invalid('logo must be a string')
  const normalized = value.trim()
  if (!normalized) return ''
  if (normalized.length > MAX_LOGO_DATA_URL_LENGTH) throw invalid('logo is too large')
  const match = normalized.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u)
  if (!match) throw invalid('logo must be a PNG, JPEG, WebP, or GIF data URL')
  const [, mime, encoded] = match
  if (encoded.length % 4 !== 0) throw invalid('logo is invalid')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > MAX_LOGO_BYTES || bytes.toString('base64') !== encoded) throw invalid('logo is invalid')
  if (!LOGO_TYPES.get(mime)?.(bytes)) throw invalid('logo content does not match its type')
  return normalized
}

export function normalizeBranding(input = {}, base = DEFAULT_BRANDING) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('branding must be an object')
  return Object.fromEntries(Object.entries(FIELD_RULES).map(([name, rule]) => [name, name === 'logo' ? cleanLogo(input[name], base[name]) : cleanField(name, input[name], base[name], rule)]))
}

export class BrandingService {
  constructor({ store } = {}) { this.store = store }
  get() { return normalizeBranding(this.store?.getBranding?.() || {}, DEFAULT_BRANDING) }
  update(input) {
    const next = normalizeBranding(input, this.get())
    this.store.saveBranding(next)
    return this.get()
  }
}
