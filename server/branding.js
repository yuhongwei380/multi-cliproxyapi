export const DEFAULT_BRANDING = Object.freeze({
  brand_name: 'CPA',
  brand_subtitle: 'CONTROL CENTER',
  banner_title: '静候流量。',
  banner_description: 'CPA 总控 · 统一管理本机的 CLI Proxy API 实例。',
  page_title: 'CLI Proxy API Management Center',
  page_description: 'CPA 总控 · Local Control Plane',
  copyright: '© 2026 Multi CLIProxyAPI',
  icon: ''
})

const FIELD_RULES = {
  brand_name: { max: 48 },
  brand_subtitle: { max: 64, allowEmpty: true },
  banner_title: { max: 80 },
  banner_description: { max: 180 },
  page_title: { max: 80 },
  page_description: { max: 180 },
  copyright: { max: 160, allowEmpty: true },
  icon: { max: 32, allowEmpty: true }
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

export function normalizeBranding(input = {}, base = DEFAULT_BRANDING) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('branding must be an object')
  return Object.fromEntries(Object.entries(FIELD_RULES).map(([name, rule]) => [name, cleanField(name, input[name], base[name], rule)]))
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
