const { EXPORT_PREFIX, isExportKey, safeCode, serviceError } = require('./export-file-policy')
const { CURSOR_KEY, validMarker } = require('./gc')
function bounded(operation) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(serviceError('GC_TIMEOUT', 'Storage operation timed out')), 8000)
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
function requireRuntime(env) {
  // No static credentials, dotenv, user input, local profile, or metadata fallback.
  if (env.TENCENTCLOUD_RUNENV !== 'SCF' || !env.TENCENTCLOUD_SESSIONTOKEN ||
    !env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY) {
    throw serviceError('GC_CREDENTIALS_UNAVAILABLE', 'Official temporary runtime identity is required')
  }
  const envId = env.TCB_ENV || env.SCF_NAMESPACE
  if (!envId || !/^[a-zA-Z0-9_-]+$/.test(envId)) throw serviceError('GC_STORAGE_UNAVAILABLE', 'Current environment is unavailable')
  return envId
}
async function createStorageAdapter(cloud, env = process.env, Manager = require('@cloudbase/manager-node')) {
  const envId = requireRuntime(env)
  // Official Manager SDK obtains rotating credentials from SCF environment vars.
  const manager = new Manager({ envId, region: env.TENCENTCLOUD_REGION })
  await bounded(() => manager.currentEnvironment().lazyInit())
  const storage = manager.storage
  const config = storage.getStorageConfig()
  if (config.env !== envId || !config.bucket || !config.region) throw serviceError('GC_STORAGE_UNAVAILABLE', 'Storage scope unavailable')
  const basePath = String(config.basePath || '').replace(/^\/+|\/+$/g, '')
  if (basePath.split('/').some(part => part === '.' || part === '..') || /[\\%?#\x00-\x20]/.test(basePath)) {
    throw serviceError('GC_STORAGE_UNAVAILABLE', 'Storage scope invalid')
  }
  const physical = key => basePath ? `${basePath}/${key}` : key
  const logical = key => {
    if (basePath && !String(key || '').startsWith(`${basePath}/`)) throw serviceError('GC_INVALID_PAGE', 'Object outside environment')
    return basePath ? key.slice(basePath.length + 1) : key
  }
  const cos = storage.getCos(20)
  const callCos = (method, options) => bounded(() => new Promise((resolve, reject) => {
    cos[method](Object.assign({ Bucket: config.bucket, Region: config.region }, options), (error, result) => error ? reject(error) : resolve(result))
  }))
  return {
    async listPage(marker, limit) {
      if (!validMarker(marker) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw serviceError('GC_INVALID_PAGE', 'Invalid list request')
      const response = await callCos('getBucket', { Prefix: physical(EXPORT_PREFIX), Marker: marker ? physical(marker) : '', MaxKeys: limit })
      if (![true, false, 'true', 'false'].includes(response && response.IsTruncated) || !Array.isArray(response.Contents)) {
        throw serviceError('GC_INVALID_PAGE', 'Invalid list response')
      }
      return { files: response.Contents.map(file => ({ Key: logical(file.Key), LastModified: file.LastModified, ETag: file.ETag })),
        hasMore: response.IsTruncated === true || response.IsTruncated === 'true', nextMarker: response.NextMarker ? logical(response.NextMarker) : '' }
    },
    async head(key) {
      if (!isExportKey(key)) throw serviceError('GC_INVALID_PAGE', 'Invalid export key')
      const response = await callCos('headObject', { Key: physical(key) })
      return { LastModified: response.headers && response.headers['last-modified'], ETag: response.headers && response.headers.etag }
    },
    async deleteBatch(keys) {
      if (!Array.isArray(keys) || !keys.length || keys.length > 20 || keys.some(key => !isExportKey(key))) throw serviceError('GC_INVALID_PAGE', 'Invalid delete batch')
      const fileList = keys.map(key => storage.cloudPathToFileId(key))
      const response = await bounded(() => cloud.deleteFile({ fileList }))
      return keys.map((key, index) => {
        const result = response && Array.isArray(response.fileList) && response.fileList.find(item => item.fileID === fileList[index])
        return { key, status: result ? result.status : 'CLEANUP_UNCONFIRMED' }
      })
    },
    async loadCursor() {
      try {
        const response = await callCos('getObject', { Key: physical(CURSOR_KEY) })
        const body = response.Body && response.Body.toString()
        if (!body || body.length > 4096) return ''
        const parsed = JSON.parse(body)
        return parsed.version === 1 && validMarker(parsed.marker) ? parsed.marker : ''
      } catch (error) {
        if (error.code === 'NoSuchKey' || error.statusCode === 404) return ''
        if (error instanceof SyntaxError) return ''
        throw error
      }
    },
    async saveCursor(marker) {
      if (!validMarker(marker)) throw serviceError('GC_INVALID_CURSOR', 'Invalid cursor')
      await callCos('putObject', { Key: physical(CURSOR_KEY), ContentType: 'application/json',
        Body: JSON.stringify({ version: 1, marker }) })
    }
  }
}
module.exports = { requireRuntime, createStorageAdapter, bounded, safeCode }
