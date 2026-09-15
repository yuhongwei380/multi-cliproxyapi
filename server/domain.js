export const DesiredState = Object.freeze({ RUNNING: 'running', STOPPED: 'stopped' })
export const ObservedState = Object.freeze({
  UNKNOWN: 'unknown', STARTING: 'starting', RUNNING: 'running',
  STOPPING: 'stopping', STOPPED: 'stopped', FAILED: 'failed'
})
export const DiscoveryAccountId = '__discovery__'

export function nowIso() { return new Date().toISOString() }
export function isStopped(state) { return state === ObservedState.STOPPED || state === ObservedState.FAILED }
export function isActive(state) { return state === ObservedState.RUNNING || state === ObservedState.STARTING || state === ObservedState.STOPPING }

export function instanceView(instance, status, request) {
  const localAddress = String(request?.socket?.localAddress || '127.0.0.1').replace(/^::ffff:/, '')
  const cleanHost = /^[0-9a-f:.]+$/i.test(localAddress) ? localAddress : '127.0.0.1'
  const managementUrl = cleanHost.includes(':') ? `http://[${cleanHost}]:${instance.port}/management.html` : `http://${cleanHost}:${instance.port}/management.html`
  return { ...instance, status, management_url: managementUrl }
}
