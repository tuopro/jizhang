const EXPORT_PREFIX = 'statement-exports/'
const EXPORT_KEY = /^statement-exports\/[a-f0-9]{24}\/[a-f0-9]{24}\/[0-9]{10,16}-[a-f0-9]{24}\.xlsx$/
const MISSING_CODES = new Set(['-503003', 'STORAGE_FILE_NONEXIST', 'TCB_STORAGE_FILE_NOT_EXISTS', 'NoSuchKey'])
function isExportKey(key) { return typeof key === 'string' && EXPORT_KEY.test(key) }
function parseExportFileID(fileID) {
  if (typeof fileID !== 'string') return null
  const match = /^cloud:\/\/([a-zA-Z0-9_.-]+)\/(.+)$/.exec(fileID)
  return match && isExportKey(match[2]) ? { authority: match[1], key: match[2] } : null
}
function isMissing(error) {
  return Boolean(error && MISSING_CODES.has(String(error.code || error.errCode || error.status)))
}
function safeCode(error) {
  const code = String(error && (error.code || error.errCode || error.status) || '')
  if (/^-?\d{1,9}$/.test(code) || MISSING_CODES.has(code) ||
    ['CLEANUP_TIMEOUT', 'CLEANUP_UNCONFIRMED', 'CLEANUP_FAILED', 'GC_CREDENTIALS_UNAVAILABLE',
      'GC_STORAGE_UNAVAILABLE', 'GC_INVALID_PAGE', 'GC_INVALID_CURSOR', 'GC_TIMEOUT',
      'AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'ExpiredToken', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return code
  return 'UNKNOWN'
}
function serviceError(code, message) { return Object.assign(new Error(message), { code }) }
module.exports = { EXPORT_PREFIX, isExportKey, parseExportFileID, isMissing, safeCode, serviceError }
