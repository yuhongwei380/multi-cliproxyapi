import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_LOG_FILE, DEFAULT_LOG_LEVEL, DEFAULT_LOG_RETENTION_DAYS, ServiceLogger, normalizeLogLevel, parseLogRetentionDays } from './logging.js'

test('service logger defaults to info and dual-writes filtered messages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-cpa-logging-'))
  const file = path.join(directory, 'multi-cpa.log')
  const consoleLines = []
  const logger = new ServiceLogger({
    filePath: file,
    clock: () => new Date('2026-09-16T08:09:10.000Z'),
    consoleImpl: {
      log: (...args) => consoleLines.push(['log', ...args]),
      warn: (...args) => consoleLines.push(['warn', ...args]),
      error: (...args) => consoleLines.push(['error', ...args])
    }
  })

  assert.equal(DEFAULT_LOG_LEVEL, 'info')
  assert.equal(DEFAULT_LOG_FILE, '/var/log/multi-cpa.log')
  assert.equal(DEFAULT_LOG_RETENTION_DAYS, 7)
  assert.equal(logger.debug('hidden'), false)
  assert.equal(logger.info('started', { port: 8787 }), true)
  assert.equal(logger.warn('degraded'), true)
  assert.equal(logger.error(new Error('failed')), true)

  const contents = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(contents, /hidden/)
  assert.match(contents, /2026-09-16T08:09:10\.000Z \[INFO\] started \{"port":8787\}/)
  assert.match(contents, /\[WARN\] degraded/)
  assert.match(contents, /\[ERROR\] Error: failed/)
  assert.equal(consoleLines.length, 3)
})

test('log level and retention settings accept the supported values', () => {
  assert.equal(normalizeLogLevel('DEBUG'), 'debug')
  assert.equal(normalizeLogLevel(' info '), 'info')
  assert.equal(parseLogRetentionDays('7'), 7)
  assert.equal(parseLogRetentionDays(14), 14)
  assert.throws(() => normalizeLogLevel('verbose'), /debug, info, warn, error/)
  assert.throws(() => parseLogRetentionDays(0), /between 1 and 365/)
  assert.throws(() => parseLogRetentionDays(366), /between 1 and 365/)
})
