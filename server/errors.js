export class AppError extends Error {
  constructor(message, status = 500, code = 'error') {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
  }
}

export const notFound = message => new AppError(message || 'not found', 404, 'not_found')
export const conflict = message => new AppError(message || 'conflict', 409, 'conflict')
export const invalid = message => new AppError(message || 'invalid request', 400, 'invalid')
export const unauthorized = message => new AppError(message || 'invalid credentials', 401, 'unauthorized')
export const forbidden = message => new AppError(message || 'forbidden', 403, 'forbidden')

export function statusForError(error) {
  if (error?.status) return error.status
  if (error?.code === 'ERR_NOT_FOUND') return 404
  if (error?.code === 'ERR_CONFLICT') return 409
  if (error?.code === 'ERR_INVALID_CREDENTIALS') return 401
  if (error?.code === 'ERR_AUTHENTICATION') return 401
  if (error?.code === 'ERR_RATE_LIMITED') return 429
  if (error?.code === 'ERR_INVALID_INSTANCE') return 400
  if (error?.code === 'ERR_PORT_UNAVAILABLE') return 409
  if (error?.code === 'ERR_START_NOT_CONFIRMED' || error?.code === 'ERR_STOP_NOT_CONFIRMED') return 409
  if (error?.code === 'ERR_NOT_INITIALIZED') return 503
  if (error?.code === 'ERR_DELETE_NOT_SAFE') return 409
  if (error?.code === 'ERR_UNSUPPORTED') return 501
  return 500
}
