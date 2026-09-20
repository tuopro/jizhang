const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createMemoryStorage } = require('../services/storage')
const { createLedgerRepository } = require('../services/ledger-repository')
const { buildProductId } = require('../data/product-specs')

function setup(initialNow) {
  let id = 0
  let nowText = initialNow || '2026-09-01T08:00:00.000Z'
  const storage = createMemoryStorage()
  const repository = createLedgerRepository(storage, {
    now: () => new Date(nowText),
    makeId: prefix => `${prefix}_${++id}`
  })
  repository.initializeTenant('tenant_a', {
    enterprise: { id: 'tenant_a', name: '德赛线槽', defaultUnit: '米' },
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  const client = repository.saveClient('tenant_a', { confirmed: true, name: '跨月客户' })
  const productId = buildProductId(40, 40, '粗齿', '白色')
  return {
    repository,
    storage,
    client,
    productId,
    setNow(value) { nowText = value }
  }
}

function postShipment(context, date, requestId, quantity, price) {
  return context.repository.postShipment('tenant_a', {
    confirmed: true,
    requestId,
    clientId: context.client.id,
    shipmentDate: date,
    items: [{
      productId: context.productId,
      quantityText: String(quantity == null ? 100 : quantity),
      orderUnit: '米', pricingUnit: '米', unitPriceYuan: String(price == null ? 100 : price)
    }]
  })
}

function pay(context, periodId, date, requestId, amountYuan) {
  return context.repository.recordPayment('tenant_a', {
    confirmed: true, requestId, clientId: context.client.id, periodId,
    paymentDate: date, amountYuan: String(amountYuan), method: '银行转账'
  })
}

function close(context, periodId, date, requestId) {
  return context.repository.closeBillingPeriod('tenant_a', {
    confirmed: true, requestId, clientId: context.client.id, periodId, closedDate: date
  })
}

test('9月1日开始发货、9月15日确认结清，形成一个9/1至9/15账期', () => {
  const context = setup()
  const shipment = postShipment(context, '2026-09-01', 'half-month-shipment')
  pay(context, shipment.periodId, '2026-09-15', 'half-month-payment', '10000')
  const period = close(context, shipment.periodId, '2026-09-15', 'half-month-close')
  assert.equal(period.startDate, '2026-09-01')
  assert.equal(period.closedDate, '2026-09-15')
  assert.equal(period.status, 'settled')
  assert.equal(context.repository.getStatement('tenant_a', context.client.id, period.id).periodLabel, '2026-09-01 ～ 2026-09-15')
})

test('9月18日至10月3日是一个跨月账期，不按月份拆成两张账单', () => {
  const context = setup()
  const first = postShipment(context, '2026-09-18', 'cross-month-1', 50, 100)
  const second = postShipment(context, '2026-09-25', 'cross-month-2', 50, 100)
  assert.equal(first.periodId, second.periodId)
  pay(context, first.periodId, '2026-10-03', 'cross-month-payment', '10000')
  close(context, first.periodId, '2026-10-03', 'cross-month-close')
  const periods = context.repository.listBillingPeriods('tenant_a', context.client.id, 'settled')
  assert.equal(periods.length, 1)
  assert.equal(periods[0].startDate, '2026-09-18')
  assert.equal(periods[0].closedDate, '2026-10-03')
})

test('欠10000先收6000，账期继续进行', () => {
  const context = setup()
  const shipment = postShipment(context, '2026-09-01', 'partial-shipment')
  const payment = pay(context, shipment.periodId, '2026-09-10', 'partial-payment', '6000')
  assert.equal(payment.remainingCents, 400000)
  assert.equal(payment.periodStatus, 'open')
  assert.equal(context.repository.getClientLedger('tenant_a', context.client.id).period.id, shipment.periodId)
})

test('再收4000余额归零时不能静默关闭，只返回需要人工确认', () => {
  const context = setup()
  const shipment = postShipment(context, '2026-09-01', 'zero-shipment')
  pay(context, shipment.periodId, '2026-09-10', 'zero-payment-1', '6000')
  const finalPayment = pay(context, shipment.periodId, '2026-09-15', 'zero-payment-2', '4000')
  assert.equal(finalPayment.remainingCents, 0)
  assert.equal(finalPayment.needsSettlementConfirmation, true)
  assert.equal(finalPayment.periodStatus, 'open')
  assert.equal(context.repository.listBillingPeriods('tenant_a', context.client.id, 'settled').length, 0)
})

test('余额为0选择暂不结清时仍保持open，后续发货继续记在同一期', () => {
  const context = setup()
  const first = postShipment(context, '2026-09-01', 'defer-shipment-1')
  pay(context, first.periodId, '2026-09-15', 'defer-payment', '10000')
  const second = postShipment(context, '2026-09-16', 'defer-shipment-2', 10, 100)
  assert.equal(second.periodId, first.periodId)
  const ledger = context.repository.getClientLedger('tenant_a', context.client.id)
  assert.equal(ledger.period.status, 'open')
  assert.equal(ledger.shipmentCount, 2)
  assert.equal(ledger.outstandingCents, 100000)
})

test('只有用户确认结清后账期才进入历史并保存完整汇总', () => {
  const context = setup()
  const shipment = postShipment(context, '2026-09-01', 'manual-close-shipment')
  pay(context, shipment.periodId, '2026-09-15', 'manual-close-payment', '10000')
  assert.equal(context.repository.listBillingPeriods('tenant_a', context.client.id, 'settled').length, 0)
  const period = close(context, shipment.periodId, '2026-09-15', 'manual-close')
  assert.equal(period.shipmentCount, 1)
  assert.equal(period.goodsSubtotalCents, 1000000)
  assert.equal(period.totalAmountCents, 1000000)
  assert.equal(period.receivedAmountCents, 1000000)
  assert.equal(period.outstandingAmountCents, 0)
  assert.equal(context.repository.getAuditLogs('tenant_a', period.id)[0].action, 'CLOSE_BILLING_PERIOD')
})

test('结清后再发货自动创建客户下一期，ID不依赖月份', () => {
  const context = setup()
  const first = postShipment(context, '2026-09-01', 'sequence-shipment-1')
  pay(context, first.periodId, '2026-09-15', 'sequence-payment', '10000')
  const closed = close(context, first.periodId, '2026-09-15', 'sequence-close')
  const next = postShipment(context, '2026-09-18', 'sequence-shipment-2', 10, 100)
  const nextPeriod = context.repository.getClientLedger('tenant_a', context.client.id).period
  assert.notEqual(next.periodId, closed.id)
  assert.equal(closed.sequenceNo, 1)
  assert.equal(nextPeriod.sequenceNo, 2)
  assert.match(nextPeriod.id, /^billing_period_/)
  assert.doesNotMatch(nextPeriod.id, /2026-09/)
})

test('历史账单页面使用期号与开始至结清日期，不用自然月命名', () => {
  const historySource = fs.readFileSync(path.join(__dirname, '../pages/history/history.js'), 'utf8')
  const historyMarkup = fs.readFileSync(path.join(__dirname, '../pages/history/history.wxml'), 'utf8')
  assert.match(historySource, /第\$\{period\.sequenceNo\}期/)
  assert.match(historySource, /period\.startDate.*period\.closedDate/)
  assert.doesNotMatch(historySource, /periodKey\.replace/)
  assert.match(historyMarkup, /已结清/)
})

test('当前对账单默认覆盖整个进行中账期，包含跨月发货与收款', () => {
  const context = setup()
  const first = postShipment(context, '2026-09-18', 'statement-shipment-1', 50, 100)
  postShipment(context, '2026-10-02', 'statement-shipment-2', 50, 100)
  pay(context, first.periodId, '2026-10-03', 'statement-payment', '6000')
  context.setNow('2026-10-03T08:00:00.000Z')
  const statement = context.repository.getStatement('tenant_a', context.client.id)
  assert.equal(statement.period.id, first.periodId)
  assert.equal(statement.periodLabel, '2026-09-18 ～ 2026-10-03')
  assert.equal(statement.shipments.length, 2)
  assert.equal(statement.payments.length, 1)
})

test('旧月份账期可继续读取并派生客户期号，查询不会静默重写原数据', () => {
  const context = setup()
  const shipment = postShipment(context, '2026-09-01', 'legacy-source')
  const root = context.storage.read()
  const tenant = root.tenants.tenant_a
  const period = tenant.billingPeriods.find(item => item.id === shipment.periodId)
  period.id = 'legacy_client_2026-09_1'
  period.periodKey = '2026-09'
  delete period.sequenceNo
  delete period.startAt
  tenant.shipments[0].periodId = period.id
  context.storage.write(root)
  const before = JSON.stringify(context.storage.read())
  const listed = context.repository.listBillingPeriods('tenant_a', context.client.id)
  assert.equal(listed[0].sequenceNo, 1)
  assert.equal(listed[0].periodKey, '2026-09')
  assert.equal(JSON.stringify(context.storage.read()), before)
})

