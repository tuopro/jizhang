const test = require('node:test')
const assert = require('node:assert/strict')

const { buildStatementExportDocument } = require('../services/statement-export')
const { paginateStatement, defaultMeasureText } = require('../services/statement-paginator')
const {
  requireActiveMembership,
  ACTIVE_MEMBER_ACTIONS
} = require('../cloudfunctions/ledger/services/access-control')

function line(id, label, quantity, unitPriceCents) {
  return {
    id,
    productId: `product_${id}`,
    productSnapshot: { label, name: label, color: '白色', toothType: '粗齿', height: 40, width: 40 },
    originalQuantity: quantity,
    originalUnit: '根',
    pricingQuantity: quantity,
    pricingUnit: '根',
    unitPriceCents,
    lineAmountCents: quantity * unitPriceCents
  }
}

function shipment(id, date, lines, freightCents) {
  const itemsSubtotalCents = lines.reduce((sum, item) => sum + item.lineAmountCents, 0)
  return {
    id,
    tenantId: 'tenant_a',
    clientId: 'client_a',
    clientNameSnapshot: '成交时客户名称',
    periodId: 'period_a',
    shipmentDate: date,
    status: 'posted',
    lines,
    itemsSubtotalCents,
    freightCents,
    totalAmountCents: itemsSubtotalCents + freightCents,
    createdByNameSnapshot: '历史录入人'
  }
}

function payment(id, date, amountCents) {
  return {
    id,
    tenantId: 'tenant_a',
    clientId: 'client_a',
    clientNameSnapshot: '成交时客户名称',
    periodId: 'period_a',
    paymentDate: date,
    amountCents,
    method: '银行转账',
    note: id,
    createdByNameSnapshot: '历史收款人',
    status: 'posted'
  }
}

function buildInput(options) {
  const settings = options || {}
  const shipments = settings.shipments || []
  const payments = settings.payments || []
  const itemsSubtotalCents = shipments.reduce((sum, item) => sum + item.itemsSubtotalCents, 0)
  const freightCents = shipments.reduce((sum, item) => sum + item.freightCents, 0)
  const shipmentTotalCents = itemsSubtotalCents + freightCents
  const receivedCents = payments.reduce((sum, item) => sum + item.amountCents, 0)
  return {
    enterprise: { id: 'tenant_a', name: '德赛塑料' },
    client: { id: 'client_a', name: '当前客户名称' },
    period: {
      id: 'period_a', clientId: 'client_a', sequenceNo: 6,
      status: settings.status || 'open',
      startAt: '2026-09-01T00:00:00.000Z',
      closedAt: settings.closedAt || '',
      ownerNameSnapshot: '历史负责人',
      itemsSubtotalCents, freightCents, shipmentTotalCents, receivedCents,
      outstandingCents: Math.max(0, shipmentTotalCents - receivedCents)
    },
    shipments,
    payments,
    generatedAt: '2026-09-21T00:00:00.000Z'
  }
}

test('当前账期导出保留多次发货、单次多商品、运费、多次收款和部分收款', () => {
  const shipments = [
    shipment('s1', '2026-09-02', [line('l1', '成交快照产品A', 2, 1000), line('l2', '成交快照产品B', 3, 500)], 600),
    shipment('s2', '2026-09-10', [line('l3', '成交快照产品C', 1, 2500)], 0)
  ]
  const payments = [payment('p1', '2026-09-12', 1000), payment('p2', '2026-09-18', 1500)]
  const document = buildStatementExportDocument(buildInput({ shipments, payments }))
  assert.equal(document.header.status, 'open')
  assert.equal(document.header.endDateLabel, '截至日期')
  assert.equal(document.counts.shipments, 2)
  assert.equal(document.counts.shipmentLines, 3)
  assert.equal(document.counts.payments, 2)
  assert.deepEqual(document.totals, {
    itemsSubtotalCents: 6000,
    freightCents: 600,
    shipmentTotalCents: 6600,
    receivedCents: 2500,
    outstandingCents: 4100
  })
  const pages = paginateStatement(document, { measureText: defaultMeasureText })
  assert.ok(pages.length >= 2)
  assert.equal(pages[pages.length - 1].blocks.some(block => block.type === 'grand-summary'), true)
})

test('已全部收款但未人工结清时仍显示进行中，不被导出逻辑自动结清', () => {
  const shipments = [shipment('s1', '2026-09-02', [line('l1', '产品', 1, 1000)], 0)]
  const payments = [payment('p1', '2026-09-03', 1000)]
  const document = buildStatementExportDocument(buildInput({ shipments, payments, status: 'open' }))
  assert.equal(document.totals.outstandingCents, 0)
  assert.equal(document.header.status, 'open')
  assert.equal(document.header.statusText, '进行中')
})

test('已结清历史账期使用结清日期、客户/负责人/操作人快照和成交价格', () => {
  const historicalLine = line('l1', '历史成交名称', 2, 1234)
  const shipments = [shipment('s1', '2026-08-02', [historicalLine], 100)]
  const payments = [payment('p1', '2026-08-20', 2568)]
  const input = buildInput({
    shipments,
    payments,
    status: 'closed',
    closedAt: '2026-08-20T00:00:00.000Z'
  })
  input.client.name = '后来修改的客户名称'
  input.currentProduct = { id: historicalLine.productId, name: '后来修改的产品名称', priceCents: 999999 }
  const document = buildStatementExportDocument(input)
  assert.equal(document.header.status, 'closed')
  assert.equal(document.header.customerName, '成交时客户名称')
  assert.equal(document.header.endDate, '2026-08-20')
  assert.equal(document.header.endDateLabel, '结清日期')
  assert.equal(document.header.ownerNameSnapshot, '历史负责人')
  assert.equal(document.shipments[0].createdByNameSnapshot, '历史录入人')
  assert.equal(document.payments[0].createdByNameSnapshot, '历史收款人')
  assert.equal(document.shipments[0].lines[0].productSnapshot.name, '历史成交名称')
  assert.equal(document.shipments[0].lines[0].unitPriceCents, 1234)
})

test('空账期可生成零金额导出数据，不制造不存在的商品或收款', () => {
  const document = buildStatementExportDocument(buildInput({ shipments: [], payments: [] }))
  assert.deepEqual(document.counts, { shipments: 0, shipmentLines: 0, payments: 0 })
  assert.deepEqual(document.shipments, [])
  assert.deepEqual(document.payments, [])
  assert.equal(document.totals.shipmentTotalCents, 0)
})

test('active admin 与 active member 均可调用只读导出，disabled 和陌生微信仍被统一拒绝', () => {
  const admin = { id: 'admin', tenantId: 'tenant_a', role: 'admin', status: 'active' }
  const member = { id: 'member', tenantId: 'tenant_a', role: 'member', status: 'active' }
  assert.equal(requireActiveMembership(admin), admin)
  assert.equal(requireActiveMembership(member), member)
  assert.ok(ACTIVE_MEMBER_ACTIONS.has('getStatementExportMeta'))
  assert.ok(ACTIVE_MEMBER_ACTIONS.has('createStatementExcel'))
  assert.throws(() => requireActiveMembership(Object.assign({}, member, { status: 'disabled' })), error => error.code === 'MEMBERSHIP_DISABLED')
  assert.throws(() => requireActiveMembership(null), error => error.code === 'MEMBERSHIP_REQUIRED')
})
