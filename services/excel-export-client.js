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

async function cleanupWithRetry(repository, tenantId, fileID) {
  if (!fileID || !repository || typeof repository.cleanupStatementExportFile !== 'function') return false
  try {
    await repository.cleanupStatementExportFile(tenantId, fileID)
    return true
  } catch (firstError) {
    try {
      await repository.cleanupStatementExportFile(tenantId, fileID)
      return true
    } catch (secondError) {
      return false
    }
  }
}

async function createAndDownloadExcel(repository, tenantId, clientId, periodId, api, onProgress) {
  if (!repository || typeof repository.createStatementExcel !== 'function') {
    throw new Error('Excel 导出仅支持正式云端账本')
  }
  let exportInfo = null
  let downloaded = null
  try {
    if (onProgress) onProgress('正在云端生成 Excel…')
    exportInfo = await repository.createStatementExcel(tenantId, clientId, periodId)
    if (!exportInfo || !exportInfo.fileID) throw new Error('云端未返回 Excel 临时文件')
    if (onProgress) onProgress('正在下载 Excel…')
    downloaded = await call(api, 'downloadFile', { fileID: exportInfo.fileID })
    if (!downloaded || !downloaded.tempFilePath) throw new Error('Excel 下载失败')
  } finally {
    if (exportInfo && exportInfo.fileID) {
      if (onProgress) onProgress('正在清理云端临时文件…')
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
