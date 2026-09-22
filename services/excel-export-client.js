function call(api, method, options) {
  return new Promise((resolve, reject) => {
    const target = method === 'downloadFile' ? api && api.cloud : api
    if (!target || typeof target[method] !== 'function') {
      reject(new Error(`当前微信版本不支持 ${method}`))
      return
    }
    target[method](Object.assign({}, options || {}, { success: resolve, fail: reject }))
  })
}

const CLEANUP_TIMEOUT_MS = 6000

function reportCleanupFailure(error, attempt) {
  const value = String(error && (error.code || error.errCode) || '')
  const code = /^-?\d{1,9}$/.test(value) || ['CLEANUP_TIMEOUT', 'CLEANUP_UNCONFIRMED'].includes(value) ? value : 'CLEANUP_FAILED'
  console.warn('[excel-temp-cleanup]', { attempt, code })
}

function boundedCleanup(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('cleanup timeout'), { code: 'CLEANUP_TIMEOUT' })), timeoutMs)
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

async function cleanupWithRetry(repository, tenantId, fileID, timeoutMs = CLEANUP_TIMEOUT_MS) {
  if (!fileID || !repository || typeof repository.cleanupStatementExportFile !== 'function') return false
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await boundedCleanup(() => repository.cleanupStatementExportFile(tenantId, fileID), timeoutMs)
      if (!result || result.cleaned !== true) throw Object.assign(new Error('cleanup unconfirmed'), { code: 'CLEANUP_UNCONFIRMED' })
      return true
    } catch (error) { reportCleanupFailure(error, attempt) }
  }
  return false
}

async function createAndDownloadExcel(repository, tenantId, clientId, periodId, api, onProgress) {
  if (!repository || typeof repository.createStatementExcel !== 'function') {
    throw new Error('Excel 导出仅支持正式云端账本')
  }
  let exportInfo = null
  let downloaded = null
  // An unloaded page or presentation callback must never interrupt cleanup.
  const progress = text => { try { if (onProgress) onProgress(text) } catch (error) {} }
  try {
    progress('正在云端生成 Excel…')
    exportInfo = await repository.createStatementExcel(tenantId, clientId, periodId)
    if (!exportInfo || !exportInfo.fileID) throw new Error('云端未返回 Excel 临时文件')
    progress('正在下载 Excel…')
    downloaded = await call(api, 'downloadFile', { fileID: exportInfo.fileID })
    if (!downloaded || typeof downloaded.tempFilePath !== 'string' || !downloaded.tempFilePath) throw new Error('Excel 下载失败')
  } finally {
    if (exportInfo && exportInfo.fileID) {
      progress('正在准备本地文件…')
      exportInfo.cloudFileCleaned = await cleanupWithRetry(repository, tenantId, exportInfo.fileID)
    }
  }
  return {
    filePath: downloaded.tempFilePath,
    fileName: exportInfo.fileName || '客户对账单.xlsx',
    generatedAt: exportInfo.generatedAt,
    cloudFileCleaned: exportInfo.cloudFileCleaned
  }
}

function openExcelFile(api, filePath) {
  if (!filePath) return Promise.reject(new Error('Excel 临时文件不存在，请重新生成'))
  return call(api, 'openDocument', { filePath, fileType: 'xlsx', showMenu: true })
}

function shareExcelFile(api, filePath, fileName) {
  if (!filePath) return Promise.reject(new Error('Excel 临时文件不存在，请重新生成'))
  return call(api, 'shareFileMessage', { filePath, fileName: fileName || '客户对账单.xlsx' })
}

module.exports = {
  call,
  cleanupWithRetry,
  createAndDownloadExcel,
  openExcelFile,
  shareExcelFile
}
