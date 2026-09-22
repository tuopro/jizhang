const test = require('node:test')
const assert = require('node:assert/strict')

const { paginateStatement, defaultMeasureText } = require('../services/statement-paginator')
const { renderStatementPage } = require('../services/statement-image-renderer')

function mockContext() {
  const texts = []
  return {
    texts,
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textBaseline: '', textAlign: '',
    save() {}, restore() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText(value, x, y) { texts.push({ value: String(value), x, y }) }
  }
}

function sampleDocument() {
  return {
    header: {
      enterpriseName: '德赛塑料', customerName: '审核客户', periodTitle: '第 3 期', sequenceNo: 3,
      status: 'closed', statusText: '已结清', startDate: '2026-09-01', endDate: '2026-09-20',
      endDateLabel: '结清日期', generatedAt: '2026-09-21T00:00:00.000Z'
    },
    totals: {
      itemsSubtotalCents: 10000, freightCents: 500, shipmentTotalCents: 10500,
      receivedCents: 10000, outstandingCents: 500
    },
    counts: { shipments: 1, shipmentLines: 1, payments: 1 },
    shipments: [{
      id: 'shipment_12345678', clientId: 'client_a', periodId: 'period_a', shipmentDate: '2026-09-02',
      logistics: { provider: '专线', raw: '德赛专线' }, note: '客户仓库签收',
      lines: [{
        id: 'line_1', productSnapshot: { label: '40×40 / 粗齿 / 白色' },
        originalQuantity: 10, originalUnit: '根', pricingQuantity: 10, pricingUnit: '根',
        unitPriceCents: 1000, lineAmountCents: 10000
      }],
      itemsSubtotalCents: 10000, freightCents: 500, totalAmountCents: 10500
    }],
    payments: [{
      id: 'payment_1', paymentDate: '2026-09-10', method: '微信', amountCents: 10000,
      note: '首款', createdByNameSnapshot: '王小明'
    }]
  }
}

test('Canvas 绘制每页重复企业、客户、账期、日期和页码，金额保持右侧列', () => {
  const document = sampleDocument()
  const pages = paginateStatement(document, { measureText: defaultMeasureText })
  pages.forEach(page => {
    const context = mockContext()
    const result = renderStatementPage(context, document, page)
    const values = context.texts.map(item => item.value)
    assert.ok(values.includes('德赛塑料'))
    assert.ok(values.includes('客户：审核客户'))
    assert.ok(values.some(value => value.includes('第 3 期')))
    assert.ok(values.includes(`第 ${page.pageNumber} / ${page.totalPages} 页`))
    assert.ok(result.bottom <= result.contentBottom)
  })
})

test('Canvas 使用成交快照产品名和成交单价，不读取当前产品字段', () => {
  const document = sampleDocument()
  const page = paginateStatement(document, { measureText: defaultMeasureText })[0]
  const context = mockContext()
  renderStatementPage(context, document, page)
  const values = context.texts.map(item => item.value)
  assert.ok(values.includes('40×40 / 粗齿 / 白色'))
  assert.ok(values.includes('¥10.00'))
  assert.ok(values.includes('¥100.00'))
})
