import fs from 'node:fs'

export const DEFAULT_LOG_LEVEL = 'info'
export const DEFAULT_LOG_FILE = '/var/log/multi-cpa.log'
export const DEFAULT_LOG_RETENTION_DAYS = 7

const LEVELS = ['debug', 'info', 'warn', 'error']
const LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]))

export function normalizeLogLevel(value = DEFAULT_LOG_LEVEL) {
  const level = String(value || DEFAULT_LOG_LEVEL).trim().toLowerCase()
  if (!LEVEL_RANK.has(level)) throw new Error(`log level must be one of ${LEVELS.join(', ')}`)
  return level
}

export function parseLogRetentionDays(value = DEFAULT_LOG_RETENTION_DAYS) {
  const days = Number(value)
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('log retention days must be an integer between 1 and 365')
  return days
}

function formatValue(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

export class ServiceLogger {
  constructor({ filePath = '', level = DEFAULT_LOG_LEVEL, clock = () => new Date(), consoleImpl = console } = {}) {
    this.filePath = filePath || ''
    this.level = normalizeLogLevel(level)
    this.clock = clock
    this.console = consoleImpl
    this.fileErrorReported = false
  }
  enabled(level) { return LEVEL_RANK.get(level) >= LEVEL_RANK.get(this.level) }
  write(level, args) {
    if (!this.enabled(level)) return false
    const message = args.map(formatValue).join(' ')
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
    this.console?.[method]?.('multi-cpa', ...args)
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, `${this.clock().toISOString()} [${level.toUpperCase()}] ${message}\n`, { encoding: 'utf8', mode: 0o640 })
      } catch (error) {
        if (!this.fileErrorReported) {
          this.fileErrorReported = true
          this.console?.error?.('multi-cpa', `file log unavailable: ${error.message}`)
        }
      }
    }
    return true
  }
  debug(...args) { return this.write('debug', args) }
  info(...args) { return this.write('info', args) }
  warn(...args) { return this.write('warn', args) }
  error(...args) { return this.write('error', args) }
}
