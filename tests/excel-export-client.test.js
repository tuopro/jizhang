const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  createAndDownloadExcel,
  openExcelFile,
  shareExcelFile
} = require('../services/excel-export-client')

test('Excel 下载完成后立即清理所属云端临时文件', async () => {
  const calls = []
  const repository = {
    createStatementExcel(tenantId, clientId, periodId) {
      calls.push(['create', tenantId, clientId, periodId])
      return Promise.resolve({ fileID: 'cloud://env/file.xlsx', fileName: '第1期.xlsx' })
    },
    cleanupStatementExportFile(tenantId, fileID) {
      calls.push(['cleanup', tenantId, fileID])
      return Promise.resolve({ cleaned: true })
    }
  }
  const api = {
    cloud: { downloadFile({ fileID, success }) { calls.push(['download', fileID]); success({ tempFilePath: '/tmp/file.xlsx' }) } }
  }
  const result = await createAndDownloadExcel(repository, 'tenant_a', 'client_a', 'period_a', api)
  assert.equal(result.filePath, '/tmp/file.xlsx')
  assert.equal(result.cloudFileCleaned, true)
  assert.deepEqual(calls.map(item => item[0]), ['create', 'download', 'cleanup'])
})

test('Excel 下载失败仍清理云端临时文件，失败不会触发账务写入 action', async () => {
  const calls = []
  const repository = {
    createStatementExcel() { calls.push('createStatementExcel'); return Promise.resolve({ fileID: 'cloud://env/file.xlsx' }) },
    cleanupStatementExportFile() { calls.push('cleanupStatementExportFile'); return Promise.resolve({ cleaned: true }) },
    postShipment() { calls.push('postShipment') },
    recordPayment() { calls.push('recordPayment') }
  }
  const api = { cloud: { downloadFile({ fail }) { fail(new Error('network down')) } } }
  await assert.rejects(createAndDownloadExcel(repository, 'tenant_a', 'client_a', 'period_a', api), /network down/)
  assert.deepEqual(calls, ['createStatementExcel', 'cleanupStatementExportFile'])
})

test('Excel 可直接打开并使用微信文件消息发送', async () => {
  const calls = []
  const api = {
    openDocument(options) { calls.push(['open', options.fileType, options.showMenu]); options.success({}) },
    shareFileMessage(options) { calls.push(['share', options.fileName]); options.success({}) }
  }
  await openExcelFile(api, '/tmp/file.xlsx')
  await shareExcelFile(api, '/tmp/file.xlsx', '正式账单.xlsx')
  assert.deepEqual(calls, [['open', 'xlsx', true], ['share', '正式账单.xlsx']])
})

test('对账单页面防止连续点击重复生成图片或 Excel', () => {
  const source = fs.readFileSync(path.join(__dirname, '../pages/statement/statement.js'), 'utf8')
  assert.match(source, /if \(!period \|\| this\.data\.openingImageExport\) return/)
  assert.match(source, /if \(!period \|\| this\.data\.exportingExcel \|\| !this\.repository\) return/)
})
