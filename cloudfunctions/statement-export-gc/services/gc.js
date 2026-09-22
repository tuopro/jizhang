const { EXPORT_PREFIX, isExportKey, isMissing, safeCode, serviceError } = require('./export-file-policy')
const AGE_MS = 48 * 60 * 60 * 1000
const LIMITS = Object.freeze({ pageSize: 100, maxScanned: 1000, maxDeleted: 200, batchSize: 20, maxRunMs: 40000 })
const CURSOR_KEY = `${EXPORT_PREFIX}.gc-cursor.json`
function validMarker(marker) {
  return typeof marker === 'string' && marker.length <= 1024 && (marker === '' ||
    (marker.startsWith(EXPORT_PREFIX) && !/[\\%\x00-\x20?#]/.test(marker) && !marker.split('/').some(part => part === '.' || part === '..')))
}
function lastModifiedMillis(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2}|GMT)$/.test(value)) return NaN
  return Date.parse(value)
}
function oldEnough(value, cutoff) {
  const time = lastModifiedMillis(value)
  return Number.isFinite(time) && time <= cutoff
}
// Only internal test dependencies may replace clock/limits; the cloud entry never
// forwards an event or request parameter to this function.
async function runGc(storage, dependencies = {}) {
  const clock = dependencies.clock || Date.now
  const limits = Object.assign({}, LIMITS, dependencies.limits)
  const startedAt = clock()
  const cutoff = startedAt - AGE_MS
  const stats = { scanned: 0, candidates: 0, deleted: 0, failed: 0, missing: 0, changed: 0, hasMore: false }
  const log = dependencies.log || (entry => console.warn('[statement-export-gc]', entry))
  let marker = await storage.loadCursor()
  if (!validMarker(marker)) { log({ code: 'GC_INVALID_CURSOR' }); marker = '' }
  let deleteAttempts = 0
  while (stats.scanned < limits.maxScanned && deleteAttempts < limits.maxDeleted && clock() - startedAt < limits.maxRunMs) {
    const pageLimit = Math.min(limits.pageSize, limits.maxScanned - stats.scanned)
    const page = await storage.listPage(marker, pageLimit)
    if (!page || !Array.isArray(page.files) || page.files.length > pageLimit || typeof page.hasMore !== 'boolean') throw serviceError('GC_INVALID_PAGE', 'Invalid storage page')
    let previous = marker
    for (const file of page.files) {
      if (!file || !validMarker(file.Key) || !file.Key || file.Key <= previous) throw serviceError('GC_INVALID_PAGE', 'Invalid storage order')
      previous = file.Key
    }
    if (page.hasMore && (!page.files.length || page.nextMarker !== previous)) throw serviceError('GC_INVALID_PAGE', 'Invalid continuation')
    let processed = 0
    while (processed < page.files.length && deleteAttempts < limits.maxDeleted && clock() - startedAt < limits.maxRunMs) {
      // Batch size also bounds rechecks and partial failures within one iteration.
      const rows = page.files.slice(processed, processed + Math.min(limits.batchSize, limits.maxDeleted - deleteAttempts))
      const candidates = rows.filter(file => isExportKey(file.Key) && oldEnough(file.LastModified, cutoff))
      stats.scanned += rows.length
      stats.candidates += candidates.length
      const rechecked = await Promise.all(candidates.map(async file => {
        try {
          const current = await storage.head(file.Key)
          if (!current || !oldEnough(current.LastModified, cutoff) ||
            lastModifiedMillis(current.LastModified) !== lastModifiedMillis(file.LastModified) ||
            (file.ETag && current.ETag !== file.ETag)) {
            stats.changed += 1
            return null
          }
          return file.Key
        } catch (error) {
          if (isMissing(error)) stats.missing += 1
          else { stats.failed += 1; log({ code: safeCode(error) }) }
          return null
        }
      }))
      const keys = rechecked.filter(Boolean)
      if (keys.length) {
        deleteAttempts += keys.length
        try {
          const results = await storage.deleteBatch(keys)
          keys.forEach(key => {
            const item = Array.isArray(results) && results.find(result => result.key === key)
            if (item && (item.status === 0 || item.status === '0' || isMissing(item))) stats.deleted += 1
            else { stats.failed += 1; log({ code: item ? safeCode(item) : 'CLEANUP_UNCONFIRMED' }) }
          })
        } catch (error) { stats.failed += keys.length; log({ code: safeCode(error) }) }
      }
      processed += rows.length
      marker = rows[rows.length - 1].Key
    }
    const complete = processed === page.files.length && !page.hasMore
    // Persist after every bounded page so cold starts continue without a database.
    await storage.saveCursor(complete ? '' : marker)
    stats.hasMore = !complete
    if (complete || processed < page.files.length) return stats
  }
  stats.hasMore = true
  return stats
}
module.exports = { AGE_MS, LIMITS, CURSOR_KEY, validMarker, lastModifiedMillis, oldEnough, runGc }
