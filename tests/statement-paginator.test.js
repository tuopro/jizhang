const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PAGE_LAYOUT,
  wrapText,
  paginateStatement
} = require('../services/statement-paginator')

function measureText(value, size) {
  return Array.from(String(value)).reduce((sum, character) =>
    sum + (/^[A-Za-z0-9 .,/()-]$/.test(character) ? size * 0.55 : size), 0)
}

function line(id, name) {
  return {
    id,
    productSnapshot: { label: name, name },
    originalQuantity: 10,
    originalUnit: '根',
    pricingQuantity: 10,
    pricingUnit: '根',
    unitPriceCents: 100,
    lineAmountCents: 1000
  }
}

function shipment(id, lineCount, name) {
  const lines = Array.from({ length: lineCount }, (_, index) => line(`${id}_${index}`, name || `40×40 / 粗齿 / 白色 ${index + 1}`))
  return {
    id,
    clientId: 'client_a',
    periodId: 'period_a',
    shipmentDate: '2026-09-20',
    clientNameSnapshot: '客户A',
    logistics: { provider: '专线', raw: '' },
    note: '',
    lines,
    itemsSubtotalCents: lines.length * 1000,
    freightCents: 500,
    totalAmountCents: lines.length * 1000 + 500
  }
}

function payment(id, note) {
  return {
    id,
    clientId: 'client_a',
    periodId: 'period_a',
    paymentDate: '2026-09-21',
    amountCents: 100,
    method: '微信',
    note: note || '',
    createdByNameSnapshot: '王小明'
  }
}

function document(overrides) {
  const value = Object.assign({ shipments: [shipment('s1', 1)], payments: [] }, overrides || {})
  const itemsSubtotalCents = value.shipments.reduce((sum, item) => sum + item.itemsSubtotalCents, 0)
  const freightCents = value.shipments.reduce((sum, item) => sum + item.freightCents, 0)
  const receivedCents = value.payments.reduce((sum, item) => sum + item.amountCents, 0)
  return {
    header: {
      enterpriseName: '德赛塑料', customerName: '测试客户', sequenceNo: 2,
      periodTitle: '第 2 期', status: 'open', statusText: '进行中',
      startDate: '2026-09-20', endDate: '2026-09-21', endDateLabel: '截至日期',
      generatedAt: '2026-09-21T00:00:00.000Z'
    },
    totals: {
      itemsSubtotalCents, freightCents,
      shipmentTotalCents: itemsSubtotalCents + freightCents,
      receivedCents,
      outstandingCents: Math.max(0, itemsSubtotalCents + freightCents - receivedCents)
    },
    counts: {
      shipments: value.shipments.length,
      shipmentLines: value.shipments.reduce((sum, item) => sum + item.lines.length, 0),
      payments: value.payments.length
    },
    shipments: value.shipments,
    payments: value.payments
  }
}

test('产品名称使用实际文字测量换行，动态增加商品行高度', () => {
  const short = wrapText('40×40 白色', PAGE_LAYOUT.productColumnWidth, measureText, 29, '400')
  const long = wrapText('非常长的特殊定制产品名称'.repeat(8), PAGE_LAYOUT.productColumnWidth, measureText, 29, '400')
  assert.equal(short.length, 1)
  assert.ok(long.length > 4)
  const pages = paginateStatement(document({ shipments: [shipment('long', 1, '非常长的特殊定制产品名称'.repeat(8))] }), { measureText })
  const segment = pages.flatMap(page => page.blocks).find(block => block.type === 'shipment-segment')
  assert.ok(segment.lineLayouts[0].height > PAGE_LAYOUT.shipmentRowMinHeight)
})

test('能放入新页的完整 shipment 会整体移动，不拆商品行', () => {
  const shipments = [shipment('first', 10), shipment('second', 3)]
  const pages = paginateStatement(document({ shipments }), { measureText })
  const secondSegments = pages.map((page, pageIndex) => ({
    pageIndex,
    blocks: page.blocks.filter(block => block.type === 'shipment-segment' && block.shipment.id === 'second')
  })).filter(item => item.blocks.length)
  assert.equal(secondSegments.length, 1)
  assert.equal(secondSegments[0].blocks[0].lineLayouts.length, 3)
  assert.equal(secondSegments[0].blocks[0].continuedFromPrevious, false)
  assert.equal(secondSegments[0].blocks[0].continuesNext, false)
})

test('单笔超长 shipment 按完整商品行拆页，后续段标记续且只在末段显示小计', () => {
  const pages = paginateStatement(document({ shipments: [shipment('huge', 30)] }), { measureText })
  const segments = pages.flatMap(page => page.blocks).filter(block => block.type === 'shipment-segment')
  assert.ok(segments.length >= 2)
  assert.equal(segments[0].continuedFromPrevious, false)
  assert.equal(segments[0].continuesNext, true)
  assert.equal(segments[0].showSummary, false)
  assert.equal(segments[segments.length - 1].continuedFromPrevious, true)
  assert.equal(segments[segments.length - 1].showSummary, true)
  assert.equal(segments.reduce((sum, item) => sum + item.lineLayouts.length, 0), 30)
  segments.forEach(segment => segment.lineLayouts.forEach(layout => assert.ok(layout.height > 0)))
})

test('收款记录按动态高度分页，最后一页始终包含账单汇总', () => {
  const payments = Array.from({ length: 35 }, (_, index) => payment(`p${index}`, index % 3 === 0 ? '客户分批付款备注'.repeat(5) : ''))
  const pages = paginateStatement(document({ payments }), { measureText })
  const paymentPages = pages.filter(page => page.tableType === 'payments')
  assert.ok(paymentPages.length >= 2)
  assert.equal(pages.flatMap(page => page.blocks).filter(block => block.type === 'payment-row').length, 35)
  assert.equal(pages[pages.length - 1].blocks.some(block => block.type === 'grand-summary'), true)
  pages.forEach(page => assert.ok(page.blocks.reduce((sum, block) => sum + block.height, page.contentTop) <= page.contentBottom))
})

test('空发货、空收款仍生成可单独阅读的一页和零金额汇总', () => {
  const pages = paginateStatement(document({ shipments: [], payments: [] }), { measureText })
  assert.equal(pages.length, 1)
  const types = pages[0].blocks.map(block => block.type)
  assert.ok(types.includes('empty-shipments'))
  assert.ok(types.includes('empty-payments'))
  assert.ok(types.includes('grand-summary'))
})

test('超过图片安全行数时明确引导 Excel，不生成无限页', () => {
  const tooMany = [shipment('too-many', 801)]
  assert.throws(
    () => paginateStatement(document({ shipments: tooMany }), { measureText }),
    error => error.code === 'IMAGE_EXPORT_TOO_LARGE'
  )
})
