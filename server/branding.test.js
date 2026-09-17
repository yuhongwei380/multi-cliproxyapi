import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrandingService, DEFAULT_BRANDING, normalizeBranding } from './branding.js'
import { Store } from './store.js'

test('branding falls back to defaults and persists customized fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-branding-'))
  const file = path.join(directory, 'control.db')
  const store = new Store(file)
  const service = new BrandingService({ store })
  assert.deepEqual(service.get(), DEFAULT_BRANDING)

  const updated = service.update({ brand_name: 'Northstar CPA', page_description: '内部 CLI Proxy API 控制台' })
  assert.equal(updated.brand_name, 'Northstar CPA')
  assert.equal(updated.page_description, '内部 CLI Proxy API 控制台')
  assert.equal(updated.banner_title, DEFAULT_BRANDING.banner_title)
  store.close()

  const reopened = new Store(file)
  assert.equal(new BrandingService({ store: reopened }).get().brand_name, 'Northstar CPA')
  reopened.close()
})

test('branding validation rejects unsafe or oversized values', () => {
  assert.throws(() => normalizeBranding({ banner_title: '' }), error => error.status === 400 && /required/.test(error.message))
  assert.throws(() => normalizeBranding({ brand_name: 'x'.repeat(49) }), error => error.status === 400 && /too long/.test(error.message))
  assert.throws(() => normalizeBranding({ page_description: 'ok\nnot ok' }), error => error.status === 400 && /control characters/.test(error.message))
})

test('branding accepts real image data URLs and rejects spoofed logo content', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(normalizeBranding({ logo: png }).logo, png)
  assert.equal(normalizeBranding({ logo: '' }).logo, '')
  assert.throws(() => normalizeBranding({ logo: 'data:image/svg+xml;base64,PHN2Zy8+' }), error => error.status === 400 && /PNG/.test(error.message))
  assert.throws(() => normalizeBranding({ logo: 'data:image/png;base64,ZmFrZQ==' }), error => error.status === 400 && /content does not match/.test(error.message))
})
