const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readStatementExportSource } = require('./statement-export-cloud')
const { buildStatementExportDocument } = require('./statement-export')

function scopeHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24)
}

function randomName() {
  return `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.xlsx`
}

function safeDownloadName(document) {
  const customer = String(document.header.customerName || '客户账单')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 36)
  return `${customer}_${document.header.periodTitle.replace(/\s+/g, '')}_对账单.xlsx`
}

function cloudPrefix(membership) {
  return `statement-exports/${scopeHash(membership.tenantId)}/${scopeHash(membership.id)}/`
}

function assertOwnedExportFile(membership, fileID) {
  const value = String(fileID || '')
  const expected = `/${cloudPrefix(membership)}`
  if (!value.startsWith('cloud://') || !value.includes(expected) || !value.toLowerCase().endsWith('.xlsx')) {
    throw new Error('临时账单文件不存在或无权清理')
  }
  return value
}

async function createStatementExcel(database, cloud, membership, payload, options) {
  const settings = options || {}
  const generatedAt = new Date().toISOString()
  const source = await readStatementExportSource(database, membership.tenantId, payload, generatedAt)
  const document = buildStatementExportDocument(source)
  const localPath = path.join(settings.tempDirectory || os.tmpdir(), `ledger-${crypto.randomBytes(12).toString('hex')}.xlsx`)
  let fileID = ''
  try {
    const writeWorkbook = settings.writeWorkbook || require('./statement-excel').writeStatementWorkbook
    await writeWorkbook(document, localPath)
    const cloudPath = `${cloudPrefix(membership)}${randomName()}`
    const response = await cloud.uploadFile({ cloudPath, fileContent: fs.readFileSync(localPath) })
    fileID = response && response.fileID || ''
    if (!fileID) throw new Error('临时 Excel 文件上传失败')
    return {
      fileID,
      fileName: safeDownloadName(document),
      generatedAt,
      sourceVersion: document.sourceVersion,
      expiresHint: '下载完成后立即删除云端临时文件；未下载完成时可重新生成'
    }
  } finally {
    try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath) } catch (error) {}
  }
}

async function cleanupStatementExportFile(cloud, membership, payload) {
  const fileID = assertOwnedExportFile(membership, payload && payload.fileID)
  const response = await cloud.deleteFile({ fileList: [fileID] })
  const result = response && response.fileList && response.fileList[0]
  if (result && result.status !== 0 && result.status !== '0') {
    throw new Error('云端临时账单文件清理失败')
  }
  return { cleaned: true }
}

module.exports = {
  scopeHash,
  cloudPrefix,
  assertOwnedExportFile,
  createStatementExcel,
  cleanupStatementExportFile
}
