export type InstanceStatus = {
  instance_id: string
  state: string
  ready: boolean
  management_ready?: boolean
  management_message?: string
  pid?: number
  version?: string
  message?: string
}

export type Instance = {
  id: string
  name: string
  port: number
  desired_state: string
  version: string
	revision: number
	management_url?: string
  status: InstanceStatus
}

export type QuotaValue = { name: string; remaining?: number; total?: number; unit?: string; reset_at?: string }
export type QuotaSnapshot = {
  instance_id: string
  account_id: string
  provider?: string
  values?: QuotaValue[]
  status: 'ok' | 'unsupported' | 'failed' | 'stale' | string
  message?: string
  collected_at: string
  attempted_at: string
}

export type QuotaSettings = {
  refresh_interval_minutes: number
  webhook_enabled: boolean
  webhook_url: string
  webhook_url_configured: boolean
  alert_threshold_percent: number
  webhook_signing_enabled: boolean
  webhook_secret_configured: boolean
  webhook_secret?: string
}

export type VersionInstall = {
  tag: string
  asset: string
  sha256: string
  installed_at: string
  usable: boolean
}

export type UpgradeState = {
  state: string
  old_version?: string
  new_version?: string
  message?: string
  updated_at?: string
}

export type BrandingSettings = {
  brand_name: string
  brand_subtitle: string
  banner_title: string
  banner_description: string
  page_title: string
  page_description: string
  copyright: string
  icon: string
}

export type RuntimeLog = { id: number; level: string; source: string; instance_id?: string; message: string; context?: Record<string, unknown>; created_at: string }
export type AuditLog = { id: number; actor: string; action: string; resource_type?: string; resource_id?: string; outcome: string; client_address?: string; detail?: string; created_at: string }

export type API = {
  get: (path: string) => Promise<any>
  post: (path: string, body?: unknown) => Promise<any>
  patch: (path: string, body: unknown) => Promise<any>
}

async function request(path: string, options: RequestInit = {}) {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) }
    })
  } catch {
    throw new Error('无法连接总控服务，请检查服务是否仍在运行')
  }
  let body: any = null
  try { body = await response.json() } catch { /* empty response */ }
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}

export const api: API = {
  get: path => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) })
}
