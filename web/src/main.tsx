import { InputHTMLAttributes, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import webPackage from '../package.json'
import { api, AuditLog, BrandingSettings, Instance, QuotaSettings, QuotaSnapshot, QuotaValue, RuntimeLog, UpgradeState, VersionInstall } from './api'
import './app.css'
import './management-link.css'

type Modal = 'create' | 'delete' | 'edit' | 'uninstall-version' | 'admin-settings' | null
type Module = 'overview' | 'instances' | 'quotas' | 'versions' | 'runtime-logs' | 'audit-logs'

const DEFAULT_QUOTA_SETTINGS: QuotaSettings = {
  refresh_interval_minutes: 360,
  webhook_enabled: false,
  webhook_url: '',
  webhook_url_configured: false,
  alert_threshold_percent: 20,
  webhook_signing_enabled: false,
  webhook_secret_configured: false,
  webhook_secret: ''
}

const APP_VERSION = webPackage.version
const DEFAULT_BRANDING: BrandingSettings = {
  brand_name: 'CPA',
  brand_subtitle: 'CONTROL CENTER',
  banner_title: '静候流量。',
  banner_description: 'CPA 总控 · 统一管理本机的 CLI Proxy API 实例。',
  page_title: 'CLI Proxy API Management Center',
  page_description: 'CPA 总控 · Local Control Plane',
  copyright: '© 2026 Multi CLIProxyAPI',
  icon: ''
}

const MODULE_LABELS: Record<Module, string> = {
  overview: '总览',
  instances: 'CLIProxyAPI 实例管理',
  quotas: '配额观察',
  versions: '版本管理',
  'runtime-logs': '运行日志',
  'audit-logs': '审计日志'
}

function moduleFromHash(hash: string): Module {
  const value = hash.replace(/^#/, '')
  if (value === 'instances' || value === 'quotas' || value === 'versions' || value === 'runtime-logs' || value === 'audit-logs') return value
  return 'overview'
}

function moduleHref(module: Module) {
  return module === 'overview' ? '#dashboard' : '#' + module
}

function App() {
  const [user, setUser] = useState<string | null>(null)
  const [branding, setBranding] = useState<BrandingSettings>(DEFAULT_BRANDING)
  const [authLoading, setAuthLoading] = useState(true)
  const [loading, setLoading] = useState(false)
  const [instances, setInstances] = useState<Instance[]>([])
  const [quotas, setQuotas] = useState<Record<string, QuotaSnapshot[]>>({})
  const [versions, setVersions] = useState<VersionInstall[]>([])
  const [upgradeState, setUpgradeState] = useState<UpgradeState>({ state: 'idle' })
  const [busy, setBusy] = useState<string | null>(null)
  const [instanceBusy, setInstanceBusy] = useState<Record<string, string>>({})
  const [modal, setModal] = useState<Modal>(null)
  const [deleteTarget, setDeleteTarget] = useState<Instance | null>(null)
  const [editTarget, setEditTarget] = useState<Instance | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<VersionInstall | null>(null)
  const [challenge, setChallenge] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [activeModule, setActiveModule] = useState<Module>(() => moduleFromHash(typeof window === 'undefined' ? '' : window.location.hash))
  const [quotaSettings, setQuotaSettings] = useState<QuotaSettings | null>(null)
  const [quotaSettingsLoaded, setQuotaSettingsLoaded] = useState(false)
  const [quotaSettingsLoading, setQuotaSettingsLoading] = useState(false)
  const [quotaSettingsError, setQuotaSettingsError] = useState('')
  const [quotaPeriodOpen, setQuotaPeriodOpen] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState('')
  const instanceActionLock = useRef(new Set<string>())

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get('/instances')
      const items = (response.items ?? []) as Instance[]
      setInstances(items)
      const currentIDs = new Set(items.map(instance => instance.id))
      setQuotas(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => currentIDs.has(id))))
      await Promise.all(items.map(async instance => {
        try {
          const q = await api.get('/instances/' + instance.id + '/quotas')
          setQuotas(previous => ({ ...previous, [instance.id]: q.items ?? [] }))
        } catch {
          /* card shows unknown */
        }
      }))
      try {
        const versionResponse = await api.get('/versions')
        setVersions((versionResponse.items ?? []) as VersionInstall[])
      } catch {
        /* version panel stays available for retry */
      }
      try {
        setUpgradeState(await api.get('/upgrade/state') as UpgradeState)
      } catch {
        /* keep last upgrade state */
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '加载失败'
      if (message === 'authentication required') setUser(null)
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const loadQuotaSettings = async () => {
    if (quotaSettingsLoading) return
    setQuotaSettingsLoading(true)
    setQuotaSettingsError('')
    try {
      const response = await api.get('/quota/settings')
      setQuotaSettings({ ...DEFAULT_QUOTA_SETTINGS, ...response } as QuotaSettings)
      setQuotaSettingsLoaded(true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '配额设置加载失败'
      setQuotaSettingsError(message)
      setError(message)
      setQuotaSettingsLoaded(true)
    } finally {
      setQuotaSettingsLoading(false)
    }
  }

  useEffect(() => {
    const onHashChange = () => setActiveModule(moduleFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (user && activeModule === 'quotas' && !quotaSettingsLoaded && !quotaSettingsLoading) void loadQuotaSettings()
  }, [user, activeModule, quotaSettingsLoaded, quotaSettingsLoading])

  useEffect(() => {
    api.get('/auth/status')
      .then(status => {
        if (status.branding) setBranding({ ...DEFAULT_BRANDING, ...status.branding } as BrandingSettings)
        if (status.authenticated) {
          setUser(status.username)
          void load()
        }
      })
      .catch(() => undefined)
      .finally(() => setAuthLoading(false))
  }, [])

  useEffect(() => { applyDocumentBranding(branding) }, [branding])

  if (authLoading) return <LoadingState label="正在检查会话…" />
  if (!user) return <Login branding={branding} onLoggedIn={name => { setUser(name); void load() }} />

  const navigate = (module: Module) => {
    setActiveModule(module)
    const href = moduleHref(module)
    if (window.location.hash !== href) window.location.hash = href
  }

  const act = async (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas') => {
    if (instanceActionLock.current.has(instance.id)) return
    instanceActionLock.current.add(instance.id)
    setInstanceBusy(previous => ({ ...previous, [instance.id]: action }))
    setError('')
    try {
      await api.post('/instances/' + instance.id + '/' + action)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      instanceActionLock.current.delete(instance.id)
      setInstanceBusy(previous => {
        const next = { ...previous }
        delete next[instance.id]
        return next
      })
    }
  }

  const refreshAllQuotas = async () => {
    setBusy('quotas:all')
    setError('')
    try {
      const results = await Promise.allSettled(instances.map(instance => api.post('/instances/' + instance.id + '/quotas')))
      await load()
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length) {
        const firstMessage = failures.find(result => result.status === 'rejected')?.reason
        const detail = firstMessage instanceof Error && firstMessage.message ? `（${firstMessage.message}）` : ''
        setError(`配额刷新完成：${results.length - failures.length} 个实例成功，${failures.length} 个实例失败${detail}`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配额刷新失败')
    } finally {
      setBusy(null)
    }
  }

  const beginDelete = async (instance: Instance) => {
    setDeleteTarget(instance)
    setChallenge(null)
    setModal('delete')
    setError('')
    try {
      const response = await api.post('/instances/' + instance.id + '/delete-challenge')
      setChallenge(response.challenge_id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法准备删除')
    }
  }

  const beginUninstall = (version: VersionInstall) => {
    setUninstallTarget(version)
    setModal('uninstall-version')
    setError('')
  }

  const installVersion = async (tag: string) => {
    setBusy('version:install')
    setError('')
    try { await api.post('/versions/install', { version: tag }); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '版本安装失败') } finally { setBusy(null) }
  }

  const upgradeVersion = async (tag: string) => {
    setBusy('version:upgrade:' + tag)
    setError('')
    try { await api.post('/versions/upgrade', { version: tag }); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '版本升级失败') } finally { setBusy(null) }
  }

  const recoverUpgrade = async () => {
    setBusy('version:recover')
    setError('')
    try { await api.post('/upgrade/recover'); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') } finally { setBusy(null) }
  }

  const uninstallVersion = async (tag: string) => {
    setBusy('version:uninstall:' + tag)
    setError('')
    try { await api.post('/versions/uninstall', { version: tag }); await load(); setModal(null); setUninstallTarget(null) } catch (cause) { setError(cause instanceof Error ? cause.message : '版本卸载失败') } finally { setBusy(null) }
  }

  const saveQuotaSettings = (settings: QuotaSettings) => {
    setQuotaSettings(settings)
    setQuotaSettingsLoaded(true)
    setQuotaSettingsError('')
  }

  const saveBranding = (settings: BrandingSettings) => {
    setBranding(settings)
    setSettingsNotice('品牌设置已更新')
    setModal(null)
  }

  return <div className="app-shell">
    <aside className="app-sidebar" aria-label="主导航">
      <div className="brand-lockup">
        <BrandIcon branding={branding} />
        <div><strong>{branding.brand_name}</strong>{branding.brand_subtitle && <small>{branding.brand_subtitle}</small>}</div>
      </div>
      <div className="sidebar-caption">运行</div>
      <nav className="sidebar-nav">
        <NavigationLink module="overview" activeModule={activeModule} onNavigate={navigate} icon="⌂">总览</NavigationLink>
      </nav>
      <div className="sidebar-caption nav-section-caption">控制</div>
      <nav className="sidebar-nav">
        <NavigationLink module="instances" activeModule={activeModule} onNavigate={navigate} icon="◈" ariaLabel="CLIProxyAPI 实例管理（实例运行轨）">CLIProxyAPI 实例管理<span className="nav-count">{instances.length}</span></NavigationLink>
        <NavigationLink module="versions" activeModule={activeModule} onNavigate={navigate} icon="↥">版本管理</NavigationLink>
      </nav>
      <div className="sidebar-caption nav-section-caption">观测</div>
      <nav className="sidebar-nav">
        <NavigationLink module="quotas" activeModule={activeModule} onNavigate={navigate} icon="◌">配额观察</NavigationLink>
        <NavigationLink module="runtime-logs" activeModule={activeModule} onNavigate={navigate} icon="≋">运行日志</NavigationLink>
        <NavigationLink module="audit-logs" activeModule={activeModule} onNavigate={navigate} icon="◎">审计日志</NavigationLink>
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-caption">连接</div>
        <div className="connection-state"><span className="dot" /><span><strong>本地总控在线</strong><small>仅限局域网访问</small></span></div>
        <div className="sidebar-user">
          <button type="button" className="sidebar-user-profile" aria-label="管理员设置" title="管理员设置" onClick={() => { setSettingsNotice(''); setError(''); setModal('admin-settings') }}>
            <span className="avatar">{user.slice(0, 1).toUpperCase()}</span>
            <span><strong>{user}</strong><small>管理员 · 设置</small></span>
          </button>
          <button type="button" className="icon-button settings-button" aria-label="管理员设置" title="管理员设置" onClick={() => { setSettingsNotice(''); setError(''); setModal('admin-settings') }}><SettingsIcon /></button>
          <button className="icon-button" aria-label="退出" title="退出" onClick={async () => { await api.post('/auth/logout'); setUser(null) }}>↗</button>
        </div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>控制中心</span><b>/</b><strong>{MODULE_LABELS[activeModule]}</strong></div>
        <div className="topbar-actions"><span className="connection-toast"><span className="dot" />已连接</span><span className="user-chip"><span className="dot" />{user}</span><button type="button" className="icon-button topbar-settings" aria-label="管理员设置" title="管理员设置" onClick={() => { setSettingsNotice(''); setError(''); setModal('admin-settings') }}><SettingsIcon /></button><button className="button ghost" onClick={async () => { await api.post('/auth/logout'); setUser(null) }}>退出</button></div>
      </header>
      <main id={activeModule === 'overview' ? 'dashboard' : activeModule} className="dashboard-content">
        {error && <div className="alert" role="alert"><span>!</span>{error}<button aria-label="关闭错误" onClick={() => setError('')}>×</button></div>}
        {settingsNotice && <div className="success-toast" role="status"><span>✓</span>{settingsNotice}<button aria-label="关闭提示" onClick={() => setSettingsNotice('')}>×</button></div>}
        {activeModule === 'overview' && <Overview branding={branding} instances={instances} quotas={quotas} versions={versions} upgradeState={upgradeState} loading={loading} busy={busy} instanceBusy={instanceBusy} onCreate={() => { setModal('create'); setError('') }} onRefresh={load} onAction={act} onDelete={beginDelete} onConfigure={instance => { setEditTarget(instance); setModal('edit'); setError('') }} onInstall={installVersion} onUpgrade={upgradeVersion} onRecover={recoverUpgrade} onUninstall={beginUninstall} onNavigate={navigate} />}
        {activeModule === 'instances' && <InstanceManagement instances={instances} quotas={quotas} loading={loading} instanceBusy={instanceBusy} onCreate={() => { setModal('create'); setError('') }} onRefresh={load} onAction={act} onDelete={beginDelete} onConfigure={instance => { setEditTarget(instance); setModal('edit'); setError('') }} />}
        {activeModule === 'quotas' && <QuotaObservation instances={instances} quotas={quotas} settings={quotaSettings ?? DEFAULT_QUOTA_SETTINGS} settingsLoaded={quotaSettingsLoaded} settingsLoading={quotaSettingsLoading} settingsError={quotaSettingsError} periodOpen={quotaPeriodOpen} busy={busy} instanceBusy={instanceBusy} onTogglePeriod={() => { setQuotaPeriodOpen(open => !open); if (!quotaSettingsLoaded) void loadQuotaSettings() }} onRefreshAll={refreshAllQuotas} onRefreshInstance={instance => act(instance, 'quotas')} onCreate={() => { setModal('create'); setError('') }} onSettingsSaved={saveQuotaSettings} onSettingsError={message => { setQuotaSettingsError(message); setError(message) }} />}
        {activeModule === 'versions' && <section className="module-pane versions-module"><VersionPanel versions={versions} instances={instances} upgradeState={upgradeState} busy={busy} onInstall={installVersion} onUpgrade={upgradeVersion} onRecover={recoverUpgrade} onUninstall={beginUninstall} /></section>}
        {activeModule === 'runtime-logs' && <LogPage kind="runtime" instances={instances} />}
        {activeModule === 'audit-logs' && <LogPage kind="audit" instances={instances} />}
      </main>
      <footer className="content-copyright" aria-label="版权信息"><span>{branding.copyright}</span><span className="content-version">v{APP_VERSION}</span></footer>
    </div>
    {modal === 'create' && <CreateDialog onClose={() => setModal(null)} onCreated={() => { setModal(null); void load() }} onError={setError} />}
    {modal === 'edit' && editTarget && <EditDialog instance={editTarget} onClose={() => setModal(null)} onSaved={() => { setModal(null); setEditTarget(null); void load() }} onError={setError} />}
    {modal === 'delete' && deleteTarget && <DeleteDialog instance={deleteTarget} challenge={challenge} onClose={() => setModal(null)} onDeleted={() => { setModal(null); void load() }} onError={setError} />}
    {modal === 'uninstall-version' && uninstallTarget && <UninstallVersionDialog version={uninstallTarget} busy={busy === 'version:uninstall:' + uninstallTarget.tag} onClose={() => { if (!busy) { setModal(null); setUninstallTarget(null) } }} onConfirm={() => void uninstallVersion(uninstallTarget.tag)} />}
    {modal === 'admin-settings' && <AdminSettingsDialog branding={branding} onClose={() => setModal(null)} onSaved={() => { setModal(null); setSettingsNotice('管理员密码已更新') }} onBrandingSaved={saveBranding} />}
  </div>
}

function NavigationLink({ module, activeModule, onNavigate, icon, ariaLabel, children }: { module: Module; activeModule: Module; onNavigate: (module: Module) => void; icon: string; ariaLabel?: string; children: React.ReactNode }) {
  return <a className={'nav-item ' + (module === activeModule ? 'active' : '')} href={moduleHref(module)} aria-label={ariaLabel} aria-current={module === activeModule ? 'page' : undefined} onClick={event => { event.preventDefault(); onNavigate(module) }}><span className="nav-icon" aria-hidden="true">{icon}</span>{children}</a>
}

function Overview({ branding, instances, quotas, versions, upgradeState, loading, busy, instanceBusy, onCreate, onRefresh, onAction, onDelete, onConfigure, onInstall, onUpgrade, onRecover, onUninstall, onNavigate }: { branding: BrandingSettings; instances: Instance[]; quotas: Record<string, QuotaSnapshot[]>; versions: VersionInstall[]; upgradeState: UpgradeState; loading: boolean; busy: string | null; instanceBusy: Record<string, string>; onCreate: () => void; onRefresh: () => void; onAction: (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas') => void; onDelete: (instance: Instance) => void; onConfigure: (instance: Instance) => void; onInstall: (tag: string) => void; onUpgrade: (tag: string) => void; onRecover: () => void; onUninstall: (version: VersionInstall) => void; onNavigate: (module: Module) => void }) {
  const running = instances.filter(instance => instance.status?.ready).length
  const snapshots = Object.values(quotas).flat()
  const successful = snapshots.filter(quota => quota.status === 'ok').length
  const accounts = snapshots.filter(quota => quota.account_id !== '__discovery__').length
  const low = snapshots.flatMap(quota => (quota.values ?? []).map(value => quotaPercent(value))).filter(value => value !== null && value <= 20).length
  return <>
    <section className="page-intro">
      <div className="hero-copy"><div className="eyebrow">{branding.brand_name} · CONTROL PLANE</div><h1>{branding.banner_title}</h1><p>{branding.banner_description}</p><div className="hero-actions"><button className="button primary" onClick={onCreate}>+ 创建实例</button><a className="hero-link" href="#instances" onClick={event => { event.preventDefault(); onNavigate('instances') }}>查看实例 <span aria-hidden="true">→</span></a></div></div>
      <div className="traffic-card"><div className="traffic-card-head"><span>运行观察</span><span className="live-pill"><span className="dot" />实时</span></div><strong>{running}</strong><small>正在运行的 CPA 实例</small><div className="traffic-rule"><span /><span /><span /></div><div className="traffic-footer"><span>托管实例 {instances.length}</span><span>快照 {successful}</span></div></div>
      <div className="intro-meta"><span className="live-indicator"><span className="dot" />服务在线</span><span className="mono-label">LAN / AMD64</span></div>
    </section>
    <section className="overview-strip" aria-label="总览">
      <div><span>托管实例</span><strong>{instances.length}<small> / 5</small></strong><em>已登记的 CPA 服务</em></div>
      <div><span>运行中</span><strong>{running}</strong><em>当前可接收请求</em></div>
      <div><span>配额快照</span><strong>{successful}<small> 个成功</small></strong><em>最近一次从子实例读取</em></div>
      <div><span>当前版本</span><strong className="metric-version">{instances[0]?.version || '—'}</strong><em>{loading ? '正在同步版本' : instances.length ? '由实例统一使用' : versions.some(version => version.usable) ? '版本已安装，等待创建实例' : '尚未安装 CPA 版本'}</em></div>
    </section>
    <section className="overview-combined-card" aria-label="实例 + 配额">
      <div className="combined-card-head"><div><div className="eyebrow">CONTROL PLANE PULSE</div><h2>实例 + 配额</h2><p>从一个视图确认服务数量、OAuth 账户和配额健康度。</p></div><button className="button ghost" onClick={() => onNavigate('quotas')}>查看配额观察 →</button></div>
      <div className="combined-metrics"><div><span>实例</span><strong>{instances.length}<small> / 5</small></strong><em>{running ? running + ' 个运行中' : '暂无运行实例'}</em></div><div><span>OAuth 账户</span><strong>{accounts}</strong><em>{successful ? successful + ' 个成功快照' : '等待首次采集'}</em></div><div><span>低配额提醒</span><strong className={low ? 'warn-text' : ''}>{low}</strong><em>{low ? '请打开配额观察处理' : '当前没有低于 20% 的窗口'}</em></div></div>
    </section>
    <section className="overview-preview">
      <section className="section-heading"><div><div className="eyebrow">INSTANCE SUMMARY</div><h2>实例概览</h2><p>每个实例独立运行，状态与 OAuth 配额在这里汇合。</p></div><button className="button ghost" onClick={onRefresh}>重新同步</button></section>
      {loading && instances.length === 0 ? <LoadingState label="正在同步实例…" /> : instances.length === 0 ? <EmptyState onCreate={onCreate} /> : <div className="instance-list">{instances.map(instance => <InstanceCard key={instance.id} instance={instance} quotas={quotas[instance.id] ?? []} instanceBusy={instanceBusy} onAction={onAction} onDelete={onDelete} onConfigure={onConfigure} />)}</div>}
    </section>
    {versions.length > 0 && <section className="overview-version-preview"><VersionPanel versions={versions} instances={instances} upgradeState={upgradeState} busy={busy} onInstall={onInstall} onUpgrade={onUpgrade} onRecover={onRecover} onUninstall={onUninstall} /></section>}
  </>
}

function InstanceManagement({ instances, quotas, loading, instanceBusy, onCreate, onRefresh, onAction, onDelete, onConfigure }: { instances: Instance[]; quotas: Record<string, QuotaSnapshot[]>; loading: boolean; instanceBusy: Record<string, string>; onCreate: () => void; onRefresh: () => void; onAction: (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas') => void; onDelete: (instance: Instance) => void; onConfigure: (instance: Instance) => void }) {
  return <section className="module-pane instances-module"><section className="section-heading module-heading"><div><div className="eyebrow">CLIPROXYAPI INSTANCES</div><h1>CLIProxyAPI 实例管理</h1><p>创建、停止、重启和配置独立的 CLIProxyAPI 子实例。</p></div><div className="section-actions"><button className="button primary" onClick={onCreate}>+ 创建实例</button><button className="button ghost" onClick={onRefresh}>重新同步</button></div></section>{loading && instances.length === 0 ? <LoadingState label="正在同步实例…" /> : instances.length === 0 ? <EmptyState onCreate={onCreate} /> : <div className="instance-list">{instances.map(instance => <InstanceCard key={instance.id} instance={instance} quotas={quotas[instance.id] ?? []} instanceBusy={instanceBusy} onAction={onAction} onDelete={onDelete} onConfigure={onConfigure} />)}</div>}</section>
}

function QuotaObservation({ instances, quotas, settings, settingsLoaded, settingsLoading, settingsError, periodOpen, busy, instanceBusy, onTogglePeriod, onRefreshAll, onRefreshInstance, onCreate, onSettingsSaved, onSettingsError }: { instances: Instance[]; quotas: Record<string, QuotaSnapshot[]>; settings: QuotaSettings; settingsLoaded: boolean; settingsLoading: boolean; settingsError: string; periodOpen: boolean; busy: string | null; instanceBusy: Record<string, string>; onTogglePeriod: () => void; onRefreshAll: () => void; onRefreshInstance: (instance: Instance) => void; onCreate: () => void; onSettingsSaved: (settings: QuotaSettings) => void; onSettingsError: (message: string) => void }) {
  const snapshots = Object.values(quotas).flat()
  const successful = snapshots.filter(quota => quota.status === 'ok').length
  const stale = snapshots.filter(quota => quota.status === 'stale').length
  const accountCount = snapshots.filter(quota => quota.account_id !== '__discovery__').length
  return <section className="module-pane quotas-module"><section className="section-heading module-heading"><div><div className="eyebrow">QUOTA OBSERVATION</div><h1>配额观察</h1><p>从子实例读取 OAuth 配额，按周期刷新并在低于阈值时通知。</p></div><div className="section-actions quota-toolbar"><button className="button primary" disabled={!!busy || settingsLoading} onClick={onRefreshAll}>手动查看配额</button><button className="button ghost" aria-expanded={periodOpen} onClick={onTogglePeriod}>配额周期</button></div></section><div className="quota-overview-card"><div><span>成功快照</span><strong>{successful}</strong></div><div><span>OAuth 账户</span><strong>{accountCount}</strong></div><div><span>已过期</span><strong className={stale ? 'warn-text' : ''}>{stale}</strong></div><div><span>自动获取</span><strong>{settings.refresh_interval_minutes}<small> 分钟</small></strong></div></div>{settingsError && <div className="settings-inline-error" role="status">{settingsError}</div>}{periodOpen && <QuotaSettingsPanel settings={settings} loading={settingsLoading} loaded={settingsLoaded} onSaved={onSettingsSaved} onError={onSettingsError} />}{instances.length === 0 ? <EmptyState onCreate={onCreate} /> : <div className="quota-instance-list">{instances.map(instance => { const instanceQuotas = quotas[instance.id] ?? []; const instanceAction = instanceBusy[instance.id]; return <article className="quota-instance-card" key={instance.id}><div className="quota-instance-head"><div><div className="eyebrow">INSTANCE QUOTA</div><h2>{instance.name}</h2><p>{instance.id} · 端口 {instance.port}</p></div><button className="button ghost" disabled={!!busy || !!instanceAction} onClick={() => onRefreshInstance(instance)}>{instanceAction ? '读取中…' : '手动查看'}</button></div>{instanceQuotas.length ? <QuotaDetails quotas={instanceQuotas} open /> : <div className="quota-empty-message">尚未采集配额；点击“手动查看”从子实例读取。</div>}</article> })}</div>}</section>
}

function QuotaSettingsPanel({ settings, loading, loaded, onSaved, onError }: { settings: QuotaSettings; loading: boolean; loaded: boolean; onSaved: (settings: QuotaSettings) => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState<QuotaSettings>(settings)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(settings), [settings])
  return <section className="quota-settings-panel" aria-label="配额周期和 Webhook 通知设置"><div className="settings-panel-head"><div><div className="eyebrow">SCHEDULE & NOTIFICATIONS</div><h2>配额周期与通知</h2><p>{loaded ? '自动获取周期和告警规则会保存到总控配置。' : loading ? '正在读取当前配置…' : '使用默认配置，保存后生效。'}</p></div></div><form onSubmit={async event => { event.preventDefault(); setSaving(true); try { const { webhook_secret, webhook_url, ...settingsPayload } = draft; const payload = { ...settingsPayload, ...(webhook_url ? { webhook_url } : {}), ...(webhook_secret ? { webhook_secret } : {}) }; const response = await api.patch('/quota/settings', payload); onSaved({ ...draft, ...response, webhook_url: '', webhook_secret: '' } as QuotaSettings) } catch (cause) { onError(cause instanceof Error ? cause.message : '保存配额设置失败') } finally { setSaving(false) } }}><div className="settings-grid"><label>自动获取周期（分钟）<input aria-label="自动获取周期（分钟）" type="number" min="1" max="10080" value={draft.refresh_interval_minutes} onChange={event => setDraft({ ...draft, refresh_interval_minutes: Number(event.target.value) })} required /><small>默认 360 分钟，可手动查看即时刷新。</small></label><div className="webhook-section"><div className="eyebrow">WEBHOOK NOTIFICATION</div><h3>Webhook 通知</h3><label className="checkbox-label"><input type="checkbox" checked={draft.webhook_enabled} onChange={event => setDraft({ ...draft, webhook_enabled: event.target.checked })} />启用钉钉机器人通知</label><label>钉钉机器人 Webhook URL<input aria-label="钉钉机器人 Webhook URL" type="url" value={draft.webhook_url} onChange={event => setDraft({ ...draft, webhook_url: event.target.value })} placeholder={draft.webhook_url_configured ? '已配置；留空保持当前地址' : 'https://oapi.dingtalk.com/robot/send?access_token=…'} /><small>{draft.webhook_url_configured ? 'Webhook 地址已加密保存；输入新地址才会替换。' : '仅支持钉钉 HTTPS 机器人地址。'}</small></label><label className="checkbox-label"><input type="checkbox" checked={draft.webhook_signing_enabled} onChange={event => setDraft({ ...draft, webhook_signing_enabled: event.target.checked })} />启用 Webhook 加签</label><label>钉钉机器人加签密钥<PasswordInput aria-label="钉钉机器人加签密钥" value={draft.webhook_secret ?? ''} onChange={event => setDraft({ ...draft, webhook_secret: event.target.value })} autoComplete="new-password" placeholder={draft.webhook_secret_configured ? '留空保持当前密钥' : '请输入钉钉机器人加签密钥'} /><small>{draft.webhook_secret_configured ? '已配置密钥；留空保持当前密钥。' : '启用加签时必须配置密钥。'}</small></label><label>告警阈值（%）<input aria-label="告警阈值（%）" type="number" min="0" max="100" step="0.01" value={draft.alert_threshold_percent} onChange={event => setDraft({ ...draft, alert_threshold_percent: Number(event.target.value) })} required /><small>当剩余配额低于此百分比时发送通知。</small></label></div></div><div className="dialog-actions settings-actions"><button className="button primary" disabled={saving}>{saving ? '保存中…' : '保存配额设置'}</button></div></form></section>
}

function LogPage({ kind, instances }: { kind: 'runtime' | 'audit'; instances: Instance[] }) {
  const [items, setItems] = useState<Array<RuntimeLog | AuditLog>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState('all')
  const instanceNames = useMemo(() => Object.fromEntries(instances.map(instance => [instance.id, instance.name])), [instances])
  const refresh = async () => { setLoading(true); setError(''); try { const response = await api.get(`/logs/${kind}?limit=500`); setItems(response.items ?? []) } catch (cause) { setError(cause instanceof Error ? cause.message : '日志加载失败') } finally { setLoading(false) } }
  useEffect(() => { void refresh() }, [kind])
  const filtered = items.filter(item => {
    const state = kind === 'runtime' ? (item as RuntimeLog).level : (item as AuditLog).outcome
    if (stateFilter !== 'all' && state !== stateFilter) return false
    if (!query.trim()) return true
    return JSON.stringify(item).toLowerCase().includes(query.trim().toLowerCase())
  })
  const runtime = kind === 'runtime'
  const problemCount = items.filter(item => runtime ? (item as RuntimeLog).level === 'error' : (item as AuditLog).outcome === 'failed').length
  return <section className="module-pane logs-module"><section className="section-heading module-heading"><div><div className="eyebrow">{runtime ? 'RUNTIME TIMELINE' : 'AUDIT TRAIL'}</div><h1>{runtime ? '运行日志' : '审计日志'}</h1><p>{runtime ? '追踪总控、实例生命周期和后台任务的运行事件。' : '记录管理员登录、配置变更与实例操作的执行结果。'}</p></div><div className="section-actions"><button className="button ghost" disabled={loading} onClick={refresh}>{loading ? '刷新中…' : '刷新日志'}</button></div></section>
    <div className="log-summary" aria-label="日志摘要"><div><span>当前记录</span><strong>{items.length}</strong></div><div><span>{runtime ? '错误事件' : '失败操作'}</span><strong className={problemCount ? 'warn-text' : ''}>{problemCount}</strong></div><div><span>展示范围</span><strong>最近 500</strong></div></div>
    <div className="log-workbench"><div className="log-toolbar"><label className="log-search">搜索日志<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={runtime ? '消息、来源或实例 ID' : '操作者、动作或资源 ID'} /></label><label>状态<select value={stateFilter} onChange={event => setStateFilter(event.target.value)}><option value="all">全部</option>{runtime ? <><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></> : <><option value="success">成功</option><option value="failed">失败</option></>}</select></label><span className="log-result-count">显示 {filtered.length} 条</span></div>
      {error ? <div className="settings-inline-error" role="alert">{error}</div> : loading && !items.length ? <div className="log-empty">正在读取日志…</div> : !filtered.length ? <div className="log-empty">没有符合当前筛选条件的日志。</div> : <div className="log-table-wrap"><table className="log-table"><thead><tr><th>时间</th><th>状态</th>{runtime ? <><th>来源</th><th>实例</th><th>消息</th></> : <><th>操作者</th><th>动作</th><th>资源</th><th>来源地址</th><th>详情</th></>}</tr></thead><tbody>{filtered.map(item => runtime ? <RuntimeLogRow key={item.id} item={item as RuntimeLog} instanceNames={instanceNames} /> : <AuditLogRow key={item.id} item={item as AuditLog} />)}</tbody></table></div>}
    </div>
  </section>
}

function RuntimeLogRow({ item, instanceNames }: { item: RuntimeLog; instanceNames: Record<string, string> }) {
  return <tr><td className="log-time">{formatLogTime(item.created_at)}</td><td><span className={`log-badge ${item.level}`}>{runtimeLevelLabel(item.level)}</span></td><td>{sourceLabel(item.source)}</td><td className="log-resource">{item.instance_id ? (instanceNames[item.instance_id] || item.instance_id) : '—'}</td><td className="log-message">{item.message}</td></tr>
}

function AuditLogRow({ item }: { item: AuditLog }) {
  return <tr><td className="log-time">{formatLogTime(item.created_at)}</td><td><span className={`log-badge ${item.outcome}`}>{item.outcome === 'success' ? '成功' : '失败'}</span></td><td>{item.actor}</td><td className="log-action">{auditActionLabel(item.action)}</td><td className="log-resource">{item.resource_id || item.resource_type || '—'}</td><td className="log-address">{item.client_address || '—'}</td><td className="log-message">{item.detail || '—'}</td></tr>
}

function formatLogTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }) }
function runtimeLevelLabel(level: string) { return ({ info: '信息', warn: '警告', error: '错误' } as Record<string, string>)[level] ?? level }
function sourceLabel(source: string) { return ({ controller: '总控', instance: '实例', http: 'HTTP' } as Record<string, string>)[source] ?? source }
function auditActionLabel(action: string) { return ({ 'auth.login': '管理员登录', 'auth.logout': '管理员退出', 'auth.password.change': '修改管理员密码', 'instance.create': '创建实例', 'instance.update': '更新实例', 'instance.start': '启动实例', 'instance.stop': '停止实例', 'instance.restart': '重启实例', 'instance.quotas': '刷新实例配额', 'instance.delete.prepare': '准备删除实例', 'instance.delete': '删除实例', 'quota.settings.update': '更新配额设置', 'branding.update': '更新品牌设置', 'version.install': '安装版本', 'version.upgrade': '统一升级', 'version.uninstall': '卸载版本', 'version.recover': '恢复升级' } as Record<string, string>)[action] ?? action }

function Login({ branding, onLoggedIn }: { branding: BrandingSettings; onLoggedIn: (name: string) => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const currentAddress = typeof window !== 'undefined' ? window.location.origin : '当前页面地址'
  return <main className="login-wrap"><section className="login-brand" aria-hidden="true"><div className="brand-wordmark"><span>{branding.brand_name}</span></div><div className="brand-signature"><BrandIcon branding={branding} variant="dark" /><span>{branding.brand_name}</span></div></section><section className="login-stage"><div className="login-panel"><div className="login-logo"><BrandIcon branding={branding} variant="large" /></div><div className="login-heading"><div className="eyebrow">{branding.brand_subtitle || 'MANAGEMENT CENTER'}</div><h1 aria-label={`${branding.brand_name} 总控`}>{branding.page_title}</h1><p>{branding.page_description}</p></div><div className="language-row"><span>中文</span><span aria-hidden="true">⌄</span></div><p className="lead">登录以查看实例健康度与 OAuth 配额。</p><div className="address-card"><span>当前地址</span><strong>{currentAddress}</strong><small>总控服务使用当前页面地址建立连接</small></div><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const result = await api.post('/auth/login', { username, password }); onLoggedIn(result.username) } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败') } finally { setBusy(false) } }}><label>用户名<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label><label>管理员密码<PasswordInput value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required placeholder="请输入管理员密码" /></label>{error && <p className="form-error">{error}</p>}<button className="button primary wide" disabled={busy}>{busy ? '验证中…' : '进入总控'}</button></form><p className="login-security">仅限局域网访问 · 会话由总控服务保护</p></div><div className="login-note">{branding.copyright && <span>{branding.copyright}</span>}<span>v{APP_VERSION}</span></div></section></main>
}

function AdminSettingsDialog({ branding, onClose, onSaved, onBrandingSaved }: { branding: BrandingSettings; onClose: () => void; onSaved: () => void; onBrandingSaved: (settings: BrandingSettings) => void }) {
  const [draft, setDraft] = useState(branding)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [brandingError, setBrandingError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [brandingBusy, setBrandingBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  useEffect(() => setDraft(branding), [branding])
  const update = (field: keyof BrandingSettings, value: string) => setDraft(previous => ({ ...previous, [field]: value }))
  return <dialog open className="modal-backdrop"><div className="dialog settings-dialog"><button className="dialog-close" disabled={brandingBusy || passwordBusy} onClick={onClose} aria-label="关闭">×</button><div className="settings-icon" aria-hidden="true"><SettingsIcon /></div><div className="eyebrow">CONTROL CENTER SETTINGS</div><h2>管理员设置</h2><p>在这里管理总控身份和管理员安全设置。品牌修改会同步到登录页、总览横幅、网页标题与浏览器图标。</p><section className="settings-block"><div className="settings-block-heading"><div><h3>品牌与网页信息</h3><p>控制台所有可见的品牌文案都从这里读取。</p></div><BrandIcon branding={draft} /></div><form onSubmit={async event => { event.preventDefault(); setBrandingError(''); setBrandingBusy(true); try { const saved = await api.patch('/branding', draft) as BrandingSettings; onBrandingSaved({ ...DEFAULT_BRANDING, ...saved }) } catch (cause) { setBrandingError(cause instanceof Error ? cause.message : '品牌设置保存失败') } finally { setBrandingBusy(false) } }}><div className="settings-grid"><label>品牌名称<input aria-label="品牌名称" value={draft.brand_name} onChange={event => update('brand_name', event.target.value)} maxLength={48} required /></label><label>品牌副标题<input aria-label="品牌副标题" value={draft.brand_subtitle} onChange={event => update('brand_subtitle', event.target.value)} maxLength={64} placeholder="例如 CONTROL CENTER" /></label><label>登录页横幅标题<input aria-label="登录页横幅标题" value={draft.banner_title} onChange={event => update('banner_title', event.target.value)} maxLength={80} required /></label><label>网页标题<input aria-label="网页标题" value={draft.page_title} onChange={event => update('page_title', event.target.value)} maxLength={80} required /></label><label className="settings-wide">横幅描述<input aria-label="横幅描述" value={draft.banner_description} onChange={event => update('banner_description', event.target.value)} maxLength={180} required /></label><label className="settings-wide">网页描述<input aria-label="网页描述" value={draft.page_description} onChange={event => update('page_description', event.target.value)} maxLength={180} required /></label><label className="settings-wide">Copyright<input aria-label="Copyright" value={draft.copyright} onChange={event => update('copyright', event.target.value)} maxLength={160} placeholder="留空隐藏版权信息" /></label><label>图标<input aria-label="品牌图标" value={draft.icon} onChange={event => update('icon', event.target.value)} maxLength={32} placeholder="例如 ✦ 或 ◆" /></label></div><p className="settings-hint">图标支持 emoji 或短字符，会用于侧栏、登录页和浏览器 favicon；当前版本号显示为 v{APP_VERSION}。</p>{brandingError && <p className="form-error" role="alert">{brandingError}</p>}<div className="dialog-actions"><button type="button" className="button ghost" disabled={brandingBusy || passwordBusy} onClick={onClose}>取消</button><button className="button primary" disabled={brandingBusy || passwordBusy}>{brandingBusy ? '保存中…' : '保存品牌设置'}</button></div></form></section><section className="settings-block settings-security"><div className="settings-block-heading"><div><h3>管理员密码</h3><p>修改后当前会话保持有效，新密码立即生效。</p></div></div><form onSubmit={async event => { event.preventDefault(); setPasswordError(''); if (newPassword !== confirmPassword) { setPasswordError('两次输入的新密码不一致'); return } setPasswordBusy(true); try { await api.patch('/auth/password', { current_password: currentPassword, new_password: newPassword }); onSaved() } catch (cause) { setPasswordError(cause instanceof Error ? cause.message : '密码修改失败') } finally { setPasswordBusy(false) } }}><label>当前管理员密码<PasswordInput aria-label="当前管理员密码" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" autoFocus required placeholder="请输入当前密码" /></label><label>新管理员密码<PasswordInput aria-label="新管理员密码" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" required placeholder="请输入新密码" /></label><label>确认新管理员密码<PasswordInput aria-label="确认新管理员密码" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" required placeholder="再次输入新密码" /></label>{passwordError && <p className="form-error" role="alert">{passwordError}</p>}<div className="dialog-actions"><button type="button" className="button ghost" disabled={brandingBusy || passwordBusy} onClick={onClose}>取消</button><button className="button primary" disabled={brandingBusy || passwordBusy}>{passwordBusy ? '保存中…' : '保存新密码'}</button></div></form></section></div></dialog>
}

function BrandIcon({ branding, variant = '' }: { branding: BrandingSettings; variant?: string }) {
  const value = branding.icon.trim()
  if (value) return <span className={'brand-icon ' + variant} aria-hidden="true">{value}</span>
  return <span className={'brand-mark ' + variant} aria-hidden="true"><span /><span /><span /></span>
}

function escapeXml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function applyDocumentBranding(branding: BrandingSettings) {
  if (typeof document === 'undefined') return
  document.title = branding.page_title
  let description = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
  if (!description) {
    description = document.createElement('meta')
    description.name = 'description'
    document.head.append(description)
  }
  description.content = branding.page_description
  let favicon = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null
  if (!favicon) {
    favicon = document.createElement('link')
    favicon.rel = 'icon'
    document.head.append(favicon)
  }
  const mark = (branding.icon || branding.brand_name.slice(0, 1) || 'C').slice(0, 2)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#27356d"/><text x="32" y="42" fill="#72d5d4" font-size="28" font-family="sans-serif" font-weight="700" text-anchor="middle">' + escapeXml(mark) + '</text></svg>'
  favicon.href = 'data:image/svg+xml,' + encodeURIComponent(svg)
}

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

function PasswordInput(props: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  return <span className="password-field"><input {...props} type={visible ? 'text' : 'password'} /><button type="button" className="password-toggle" aria-label={visible ? '隐藏密码' : '显示密码'} title={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button></span>
}

function EyeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
}

function EyeOffIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 6.2A10.6 10.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17.6 17.6 0 0 1-3.1 3.9M6.1 6.9C3.8 8.3 2.5 12 2.5 12s3.5 6 9.5 6c1.1 0 2.1-.2 3-.5" /></svg>
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0L6.2 6.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></svg>
}

function LoadingState({ label }: { label: string }) {
  return <main className="loading-state" aria-live="polite"><span className="loading-spinner" />{label}</main>
}

function VersionPanel({ versions, instances, upgradeState, busy, onInstall, onUpgrade, onRecover, onUninstall }: { versions: VersionInstall[]; instances: Instance[]; upgradeState: UpgradeState; busy: string | null; onInstall: (tag: string) => void; onUpgrade: (tag: string) => void; onRecover: () => void; onUninstall: (version: VersionInstall) => void }) {
  const [tag, setTag] = useState('')
  const current = instances.length ? instances[0].version : ''
  const blocked = upgradeState.state === 'blocked'
  const locked = upgradeState.state !== 'idle' && upgradeState.state !== 'committed' && upgradeState.state !== 'rolled-back' && !blocked
  return <section className="version-panel" aria-label="版本管理"><div className="version-heading"><div><div className="eyebrow">VERSION CONTROL</div><h2>统一版本</h2><p>先安装并校验版本，再一次性切换全部 CPA 实例；升级完成后可清理旧版本缓存。</p></div><form className="version-install" onSubmit={event => { event.preventDefault(); onInstall(tag.trim()) }}><input value={tag} onChange={event => setTag(event.target.value)} placeholder="留空安装 latest" aria-label="版本标签" /><button className="button ghost" disabled={busy !== null || locked}>{busy === 'version:install' ? '安装中…' : '安装版本'}</button></form></div>{upgradeState.state !== 'idle' && <div className={'upgrade-banner ' + (blocked ? 'blocked' : '')}><span>升级状态：{upgradeStateLabel(upgradeState.state)}</span>{upgradeState.old_version && upgradeState.new_version && <small>{upgradeState.old_version} → {upgradeState.new_version}</small>}{upgradeState.message && <p>{upgradeState.message}</p>}{blocked && <button className="button ghost" disabled={busy !== null} onClick={onRecover}>{busy === 'version:recover' ? '恢复中…' : '重试回滚'}</button>}</div>}{versions.length === 0 ? <p className="version-empty">尚未安装 CPA 版本。Linux 首次启动会尝试准备 latest，也可以在这里重试。</p> : <div className="version-list">{versions.map(version => { const isCurrent = version.tag === current; const upgradeBusy = busy === 'version:upgrade:' + version.tag; const uninstallBusy = busy === 'version:uninstall:' + version.tag; return <div className="version-row" key={version.tag}><div><strong>{version.tag}</strong><small>{version.asset || '本地版本'} · {version.installed_at ? new Date(version.installed_at).toLocaleString('zh-CN') : '安装时间未知'}</small></div><div className="version-row-actions"><span className={'version-state ' + (isCurrent ? 'current' : version.usable ? 'ready' : 'bad')}>{isCurrent ? '当前运行' : version.usable ? '已安装' : '不可用'}</span>{version.usable && !isCurrent && instances.length > 0 && <button className="button ghost" disabled={busy !== null || locked} onClick={() => onUpgrade(version.tag)}>{upgradeBusy ? '升级中…' : '统一升级'}</button>}{!isCurrent && <button className="button ghost danger-outline version-uninstall" aria-label={'卸载版本 ' + version.tag} disabled={busy !== null || locked} onClick={() => onUninstall(version)}>{uninstallBusy ? '卸载中…' : '卸载版本'}</button>}</div></div> })}</div>}</section>
}

function upgradeStateLabel(state: string) {
  return ({ prepared: '准备中', 'stopping-old': '停止旧版本', 'old-stopped': '旧版本已停止', 'starting-new': '启动新版本', committed: '已完成', 'restoring-old': '正在回滚', 'rolled-back': '已回滚', blocked: '回滚受阻' } as Record<string, string>)[state] ?? state
}

function InstanceCard({ instance, quotas, instanceBusy, onAction, onDelete, onConfigure }: { instance: Instance; quotas: QuotaSnapshot[]; instanceBusy: Record<string, string>; onAction: (instance: Instance, action: 'start' | 'stop' | 'restart' | 'quotas') => void; onDelete: (instance: Instance) => void; onConfigure: (instance: Instance) => void }) {
  const running = instance.status?.ready
  const busy = instanceBusy[instance.id] || null
  const actionBusy = Boolean(busy)
  const thisActionBusy = actionBusy
  const managementUrl = instance.management_url
  const quotaLabel = useMemo(() => {
    if (!quotas.length) return '尚未采集'
    if (quotas.length === 1 && quotas[0].account_id === '__discovery__' && quotas[0].status === 'empty') return '0 个账户'
    if (quotas.some(q => q.status === 'failed')) return '查询失败'
    if (quotas.some(q => q.status === 'stale')) return '缓存已过期'
    if (quotas.some(q => q.status === 'unsupported')) return '部分不支持'
    const accountCount = quotas.filter(q => q.account_id !== '__discovery__').length
    const latest = quotas.reduce((value, q) => q.collected_at > value ? q.collected_at : value, '')
    return latest ? accountCount + ' 个账户 · ' + relativeTime(latest) : '无成功快照'
  }, [quotas])
  return <article className={'instance-card ' + (running ? 'is-running' : '')}><div className="card-top"><div className="instance-title"><span className={'status-orb ' + (running ? 'live' : '')} /><div><h3>{instance.name}</h3><p>{instance.id} · 端口 {instance.port}</p></div></div><span className={'state-pill ' + (running ? 'live' : '')}>{running ? '运行中' : stateLabel(instance.status?.state)}</span></div><div className="runway"><div className="runway-line"><span className={'runway-node ' + (running ? 'active' : '')} /><span className="runway-track" /><span className={'runway-node ' + (instance.status?.ready ? 'active' : '')} /></div><div className="runway-labels"><span>期望 <b>{instance.desired_state === 'running' ? '运行' : '停止'}</b></span><span>实际 <b>{stateLabel(instance.status?.state)}</b></span></div></div><div className="card-meta"><div><span>版本</span><strong>{instance.version || '未安装'}</strong></div><div><span>配额观察</span><strong className={quotas.some(q => q.status === 'failed' || q.status === 'stale') ? 'warn-text' : ''}>{quotaLabel}</strong></div></div><div className="card-status"><span className={instance.status?.management_ready ? 'ready-text' : 'muted-text'}>{instance.status?.management_ready ? '管理接口已就绪' : running ? (instance.status?.management_message || '管理接口未验证') : '实例未运行'}</span>{managementUrl && <button type="button" className="button ghost management-link" onClick={() => window.open(managementUrl, '_blank', 'noopener,noreferrer')}>CPA 管理 ↗</button>}</div><QuotaDetails quotas={quotas} /><div className="card-actions"><button className="button primary" disabled={actionBusy} onClick={() => onAction(instance, running ? 'restart' : 'start')}>{thisActionBusy ? '处理中…' : running ? '重启实例' : '启动实例'}</button><button className="button ghost" disabled={actionBusy || !running} onClick={() => onAction(instance, 'stop')}>停止</button><button className="button ghost" disabled={actionBusy} onClick={() => onAction(instance, 'quotas')}>刷新配额</button><button className="button ghost" disabled={actionBusy} onClick={() => onConfigure(instance)}>配置</button><button className="button ghost danger-outline" disabled={actionBusy} onClick={() => onDelete(instance)}>删除</button></div></article>
}

function QuotaDetails({ quotas, open }: { quotas: QuotaSnapshot[]; open?: boolean }) {
  if (!quotas.length) return null
  const accountCount = quotas.filter(quota => quota.account_id !== '__discovery__').length
  return <details className="quota-details" open={open}><summary>查看 OAuth 配额（{accountCount} 个账户）</summary><div className="quota-rows">{quotas.map(quota => <div className="quota-row" key={quota.account_id}><div className="quota-row-head"><strong>{quota.account_id === '__discovery__' ? 'OAuth 账户发现' : (quota.provider || 'OAuth') + ' · ' + quota.account_id}</strong><span className={'quota-state ' + quota.status}>{quotaStatusLabel(quota.status)}</span></div>{quota.values?.length ? <div className="quota-values">{quota.values.map((value, index) => <QuotaWindow key={value.name + '-' + index} value={value} />)}</div> : <p className="quota-message">{quota.message || '子实例未返回可展示的配额窗口。'}</p>}{validTimestamp(quota.collected_at) && <small className="quota-timestamp">最近成功采集于 {new Date(quota.collected_at).toLocaleString('zh-CN')}</small>}{validTimestamp(quota.attempted_at) && quota.status !== 'ok' && <small className="quota-timestamp">最近尝试于 {new Date(quota.attempted_at).toLocaleString('zh-CN')}</small>}</div>)}</div></details>
}

function QuotaWindow({ value }: { value: QuotaValue }) {
  const percent = quotaPercent(value)
  const tone = percent === null ? '' : percent <= 20 ? ' low' : percent < 60 ? ' warning' : ' healthy'
  const label = value.name || '默认窗口'
  return <div className="quota-window"><div className="quota-window-title">{label}</div><div className="quota-window-meta"><strong>{formatQuotaValue(value)}</strong>{value.reset_at && <span><time dateTime={value.reset_at}>{formatQuotaReset(value.reset_at)}</time><i aria-hidden="true"> · </i>{quotaResetRelative(value.reset_at)}</span>}</div>{percent !== null && <div className={'quota-progress' + tone} role="progressbar" aria-label={`${label} 剩余配额`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>}</div>
}

function quotaStatusLabel(status: string) {
  return ({ ok: '已更新', empty: '无账户', unsupported: '不支持', failed: '查询失败', stale: '已过期' } as Record<string, string>)[status] ?? status
}

function formatQuotaValue(value: QuotaValue) {
  const number = (item: number | undefined) => item === undefined ? '' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(item)
  const unit = value.unit ? ' ' + value.unit : ''
  if (value.unit === '%' && value.remaining !== undefined) return number(value.remaining) + '%'
  if (value.remaining !== undefined && value.total !== undefined) return ' ' + number(value.remaining) + ' / ' + number(value.total) + unit
  if (value.remaining !== undefined) return ' 剩余 ' + number(value.remaining) + unit
  if (value.total !== undefined) return ' 总量 ' + number(value.total) + unit
  return ' 未提供数值'
}

function formatQuotaReset(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
}

function quotaResetRelative(value: string) {
  const delta = Date.parse(value) - Date.now()
  if (!Number.isFinite(delta)) return '时间未知'
  if (delta <= 0) return '已到期'
  const minutes = Math.max(1, Math.round(delta / 60000))
  if (minutes < 60) return `${minutes}分钟后`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}小时后`
  return `${Math.round(hours / 24)}天后`
}

function CreateDialog({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (error: string) => void }) {
  const [name, setName] = useState('')
  const [port, setPort] = useState('8317')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog"><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button><div className="eyebrow">NEW INSTANCE</div><h2>创建 CPA 实例</h2><p>总控会为实例创建独立目录；账户和 API Key 在子实例管理页配置。</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api.post('/instances', { name, port: Number(port), ...(password ? { management_password: password } : {}) }); onCreated() } catch (cause) { onError(cause instanceof Error ? cause.message : '创建失败') } finally { setBusy(false) } }}><label>实例名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如 claude-work" required /></label><label>监听端口<input type="number" min="1024" max="65535" value={port} onChange={event => setPort(event.target.value)} required /></label><label>子实例管理密码（可选）<PasswordInput value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="留空使用默认密码 admin" /></label><div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? '创建中…' : '创建实例'}</button></div></form></div></dialog>
}

function EditDialog({ instance, onClose, onSaved, onError }: { instance: Instance; onClose: () => void; onSaved: () => void; onError: (error: string) => void }) {
  const [name, setName] = useState(instance.name)
  const [port, setPort] = useState(String(instance.port))
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog"><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button><div className="eyebrow">INSTANCE CONFIG</div><h2>配置 {instance.name}</h2><p>留空子实例管理密码则保持当前密码不变；账户与 API Key 继续在子实例管理页维护。</p><form onSubmit={async event => { event.preventDefault(); setBusy(true); try { await api.patch('/instances/' + instance.id, { name, port: Number(port), ...(password ? { management_password: password } : {}), expected_revision: instance.revision }); onSaved() } catch (cause) { onError(cause instanceof Error ? cause.message : '配置失败') } finally { setBusy(false) } }}><label>实例名称<input value={name} onChange={event => setName(event.target.value)} required /></label><label>监听端口<input type="number" min="1024" max="65535" value={port} onChange={event => setPort(event.target.value)} required /></label><label>新的子实例管理密码（可选）<PasswordInput value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="留空保持当前密码" /></label><div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? '保存中…' : '保存配置'}</button></div></form></div></dialog>
}

function DeleteDialog({ instance, challenge, onClose, onDeleted, onError }: { instance: Instance; challenge: string | null; onClose: () => void; onDeleted: () => void; onError: (error: string) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  return <dialog open className="modal-backdrop"><div className="dialog danger-dialog"><button className="dialog-close" onClick={onClose} aria-label="关闭">×</button><div className="danger-mark">!</div><div className="eyebrow">IRREVERSIBLE ACTION</div><h2>删除 {instance.name}？</h2><p>这会停止实例并清除它的配置、OAuth 认证数据、日志和注册信息。版本安装缓存和其他实例不会受影响。</p><label>输入总控管理员密码确认<PasswordInput aria-label="输入总控管理员密码确认删除" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" autoFocus required /></label><div className="dialog-actions"><button className="button ghost" onClick={onClose}>保留实例</button><button className="button danger" disabled={!challenge || !password || busy} onClick={async () => { setBusy(true); try { await api.post('/instances/' + instance.id + '/delete', { challenge_id: challenge, admin_password: password }); onDeleted() } catch (cause) { onError(cause instanceof Error ? cause.message : '删除失败') } finally { setBusy(false) } }}>{busy ? '删除中…' : '确认删除'}</button></div></div></dialog>
}

function UninstallVersionDialog({ version, busy, onClose, onConfirm }: { version: VersionInstall; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return <dialog open className="modal-backdrop"><div className="dialog danger-dialog"><button className="dialog-close" disabled={busy} onClick={onClose} aria-label="关闭">×</button><div className="danger-mark">!</div><div className="eyebrow">VERSION CLEANUP</div><h2>卸载 {version.tag}？</h2><p>将删除该版本的安装缓存。当前运行版本不会受影响；如果之后需要回滚到 {version.tag}，需要重新安装。</p><div className="dialog-actions"><button className="button ghost" disabled={busy} onClick={onClose}>保留版本</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? '卸载中…' : '确认卸载'}</button></div></div></dialog>
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-state"><div className="empty-mark"><span /><span /><span /></div><h3>还没有运行轨</h3><p>创建第一个实例后，端口、版本、状态和配额会在这里汇合。</p><button className="button primary" onClick={onCreate}>创建第一个实例</button></div>
}

function quotaPercent(value: QuotaValue) {
  const remaining = Number(value.remaining)
  const total = Number(value.total)
  if (!Number.isFinite(remaining) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(100, remaining / total * 100))
}

function stateLabel(state?: string) {
  return ({ running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', failed: '失败', unknown: '未知' } as Record<string, string>)[state ?? 'unknown'] ?? '未知'
}

function relativeTime(value: string) {
  const age = Date.now() - Date.parse(value)
  if (!Number.isFinite(age)) return '时间未知'
  const minutes = Math.floor(age / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  return Math.floor(minutes / 60) + ' 小时前'
}

function validTimestamp(value?: string) {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && parsed > 0
}

export { App }

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)



