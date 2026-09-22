const cloud = require('wx-server-sdk')
const { runGc } = require('./services/gc')
const { createStorageAdapter } = require('./services/storage-adapter')
const { safeCode } = require('./services/export-file-policy')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
// Event is intentionally unused. Type/TriggerName are not trusted authority.
exports.main = async () => {
  try {
    if (cloud.getWXContext().OPENID) return { ok: false, code: 'GC_CLIENT_CALL_REJECTED' }
    const storage = await createStorageAdapter(cloud)
    const result = await runGc(storage)
    console.log('[statement-export-gc]', result)
    return { ok: true, ...result }
  } catch (error) {
    const code = safeCode(error)
    console.warn('[statement-export-gc]', { code })
    return { ok: false, code }
  }
}
