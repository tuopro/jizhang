const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ExcelJS = require('../cloudfunctions/ledger/node_modules/exceljs')
const { buildStatementExportDocument } = require('../services/statement-export')
const {
  MONEY_FORMAT,
  writeStatementWorkbook
} = require('../cloudfunctions/ledger/services/statement-excel')
const {
  cloudPrefix,
  assertOwnedExportFile,
  createStatementExcel
} = require('../cloudfunctions/ledger/services/statement-export-file')

function source() {
  const firstLine = {
    id: 'line_1', productId: 'product_old',
    productSnapshot: {
      name: '历史成交产品', label: '40×40 / 粗齿 / 白色', height: 40, width: 40,
      color: '白色', toothType: '粗齿', productType: 'wire-duct', lengthDescription: '1.2米/根'
    },
    originalQuantity: 10, originalUnit: '根', pricingQuantity: 12, pricingUnit: '米',
    conversion: { fromUnit: '根', toUnit: '米', multiplier: 1.2 },
    unitPriceCents: 1234, lineAmountCents: 14808
  }
  const secondLine = {
    id: 'line_2', productId: 'product_other',
    productSnapshot: { label: '60mm盖子 / 黑色', width: 60, color: '黑色', productType: 'cover' },
    originalQuantity: 2, originalUnit: '根', pricingQuantity: 2, pricingUnit: '根',
    unitPriceCents: 500, lineAmountCents: 1000
  }
  return {
    enterprise: { id: 'tenant_a', name: '德赛塑料' },
    client: { id: 'client_a', name: '当前客户名' },
    period: {
      id: 'period_a', clientId: 'client_a', sequenceNo: 4, status: 'closed',
      startAt: '2026-09-01T00:00:00.000Z', closedAt: '2026-09-20T00:00:00.000Z',
      itemsSubtotalCents: 15808, freightCents: 500, shipmentTotalCents: 16308,
      receivedCents: 16000, outstandingCents: 308, ownerNameSnapshot: '历史负责人'
    },
    shipments: [{
      id: 'shipment_1789980614269_example_suffix', tenantId: 'tenant_a', clientId: 'client_a', clientNameSnapshot: '历史客户名',
      periodId: 'period_a', shipmentDate: '2026-09-02', status: 'posted', lines: [firstLine, secondLine],
      itemsSubtotalCents: 15808, freightCents: 500, totalAmountCents: 16308,
      logistics: { provider: '专线', raw: '德赛专线 123' }, note: '历史发货备注',
      createdByNameSnapshot: '历史录入人'
    }],
    payments: [{
      id: 'payment_1', tenantId: 'tenant_a', clientId: 'client_a', clientNameSnapshot: '历史客户名',
      periodId: 'period_a', paymentDate: '2026-09-19', amountCents: 16000,
      method: '银行转账', note: '历史收款备注', createdByNameSnapshot: '历史收款人', status: 'posted'
    }],
    generatedAt: '2026-09-21T00:00:00.000Z'
  }
}

test('Excel 正式账单包含三个 Sheet、数值金额和真实成交快照字段', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-excel-test-'))
  const filePath = path.join(directory, 'statement.xlsx')
  try {
    const document = buildStatementExportDocument(source())
    await writeStatementWorkbook(document, filePath)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['账单汇总', '发货明细', '收款明细'])

    const summary = workbook.getWorksheet('账单汇总')
    assert.equal(summary.getCell('B3').value, '德赛塑料')
    assert.equal(summary.getCell('D3').value, '历史客户名')
    assert.equal(summary.getCell('B6').value, 158.08)
    assert.equal(typeof summary.getCell('B6').value, 'number')
    assert.equal(summary.getCell('B6').numFmt, MONEY_FORMAT)
    assert.equal(summary.getCell('B8').value, 3.08)
    assert.equal(summary.getCell('B6').alignment.horizontal, 'right')
    assert.equal(summary.getCell('A3').fill.fgColor.argb, 'FFEAF1F7')

    const shipments = workbook.getWorksheet('发货明细')
    assert.equal(shipments.getRow(2).getCell(3).value, '历史成交产品')
    assert.match(shipments.getRow(2).getCell(4).value, /40×40mm/)
    assert.equal(shipments.getRow(2).getCell(12).value, 12.34)
    assert.equal(typeof shipments.getRow(2).getCell(12).value, 'number')
    assert.equal(shipments.getRow(2).getCell(15).value, 5)
    assert.equal(shipments.getRow(3).getCell(15).value, '')
    assert.equal(shipments.getRow(2).getCell(20).value, '历史录入人')
    assert.equal(shipments.getRow(1).height, 26)
    shipments.getRow(1).eachCell(cell => {
      assert.equal(cell.font.bold, true)
      assert.equal(cell.font.color.argb, 'FFFFFFFF')
      assert.equal(cell.fill.fgColor.argb, 'FF173F67')
      assert.equal(cell.alignment.horizontal, 'center')
      assert.equal(cell.alignment.vertical, 'middle')
    })
    assert.equal(shipments.getColumn(2).width, 30)
    assert.equal(shipments.getColumn(3).width, 38)
    assert.equal(shipments.getColumn(4).width, 25)
    assert.equal(shipments.getRow(2).getCell(2).alignment.horizontal, 'center')
    assert.equal(shipments.getRow(2).getCell(2).alignment.wrapText, true)
    assert.equal(shipments.getRow(2).getCell(3).alignment.horizontal, 'left')
    assert.equal(shipments.getRow(2).getCell(3).alignment.wrapText, true)
    assert.equal(shipments.getRow(2).getCell(7).alignment.horizontal, 'right')
    assert.equal(shipments.getRow(2).getCell(8).alignment.horizontal, 'center')
    assert.equal(shipments.getRow(2).getCell(12).alignment.horizontal, 'right')
    assert.equal(shipments.getRow(2).getCell(3).font.color.argb, 'FF1F2937')
    assert.equal(shipments.getRow(2).getCell(3).fill.fgColor.argb, 'FFFFFFFF')
    assert.equal(shipments.getRow(2).getCell(3).border.bottom.color.argb, 'FFD1D5DB')
    assert.equal(shipments.views[0].state, 'frozen')
    assert.equal(shipments.views[0].ySplit, 1)

    const payments = workbook.getWorksheet('收款明细')
    assert.equal(payments.getRow(2).getCell(3).value, 160)
    assert.equal(typeof payments.getRow(2).getCell(3).value, 'number')
    assert.equal(payments.getRow(2).getCell(4).value, '银行转账')
    assert.equal(payments.getRow(2).getCell(6).value, '历史收款人')
    payments.getRow(1).eachCell(cell => {
      assert.equal(cell.font.bold, true)
      assert.equal(cell.font.color.argb, 'FFFFFFFF')
      assert.equal(cell.fill.fgColor.argb, 'FF173F67')
      assert.equal(cell.alignment.horizontal, 'center')
      assert.equal(cell.alignment.vertical, 'middle')
    })
    assert.equal(payments.getRow(2).getCell(3).alignment.horizontal, 'right')
    assert.equal(payments.getRow(2).getCell(5).alignment.horizontal, 'left')
    assert.equal(payments.views[0].state, 'frozen')
    assert.equal(payments.views[0].ySplit, 1)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('云端文件路径按 tenant 和 member 隔离，不能清理其他成员文件', () => {
  const memberA = { id: 'member_a', tenantId: 'tenant_a' }
  const memberB = { id: 'member_b', tenantId: 'tenant_a' }
  const fileID = `cloud://env.bucket/${cloudPrefix(memberA)}1789990000000-0123456789abcdef01234567.xlsx`
  assert.equal(assertOwnedExportFile(memberA, fileID), fileID)
  assert.throws(() => assertOwnedExportFile(memberB, fileID), /无权清理/)
  assert.throws(() => assertOwnedExportFile(memberA, 'https://public.example/file.xlsx'), /无权清理/)
})

function fakeDatabase(seed) {
  return {
    collection(name) {
      const rows = seed[name] || []
      return {
        doc(id) {
          return { async get() {
            const value = rows.find(item => item.id === id)
            if (!value) throw new Error('not found')
            return { data: value }
          } }
        },
        where(criteria) {
          let offset = 0
          let limit = 100
          const query = {
            skip(value) { offset = value; return query },
            limit(value) { limit = value; return query },
            async get() {
              return { data: rows.filter(item => Object.keys(criteria).every(key => item[key] === criteria[key])).slice(offset, offset + limit) }
            }
          }
          return query
        }
      }
    }
  }
}

test('Excel 临时文件上传失败不会修改账务数据且会清理本地临时文件', async () => {
  const input = source()
  const seed = {
    enterprises: [Object.assign({ tenantId: 'tenant_a' }, input.enterprise)],
    clients: [Object.assign({ tenantId: 'tenant_a', active: true }, input.client)],
    billing_periods: [Object.assign({ tenantId: 'tenant_a' }, input.period)],
    shipments: input.shipments,
    payments: input.payments
  }
  const before = JSON.stringify(seed)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-excel-fail-'))
  const cloud = { async uploadFile() { throw new Error('upload failed') } }
  try {
    await assert.rejects(createStatementExcel(
      fakeDatabase(seed), cloud, { id: 'member_a', tenantId: 'tenant_a' },
      { clientId: 'client_a', periodId: 'period_a' },
      {
        tempDirectory: directory,
        async writeWorkbook(document, filePath) { fs.writeFileSync(filePath, 'temporary') }
      }
    ), /upload failed/)
    assert.equal(JSON.stringify(seed), before)
    assert.deepEqual(fs.readdirSync(directory), [])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
