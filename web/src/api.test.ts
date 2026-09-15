import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

test('turns a network failure into an actionable controller error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  await expect(api.get('/instances')).rejects.toThrow('无法连接总控服务，请检查服务是否仍在运行')
})
