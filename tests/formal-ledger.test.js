const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createMemoryStorage } = require('../services/storage')
const { createLedgerRepository } = require('../services/ledger-repository')
const { buildProductId } = require('../data/product-specs')

function setup() {
  let id = 0
  const storage = createMemoryStorage()
  const repository = createLedgerRepository(storage, {
    now: () => new Date('2026-09-18T08:00:00.000Z'),
    makeId: prefix => `${prefix}_${++id}`
  })
  repository.initializeTenant('tenant_a', {
    enterprise: { id: 'tenant_a', name: '德赛线槽', defaultUnit: '米' },
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  const client = repository.saveClient('tenant_a', {
    confirmed: true, name: '杭州客户', contact: '王经理', phone: '13800000000', settlementDay: 30, note: ''
  })
  return { repository, storage, client, productId: buildProductId(40, 40, '粗齿', '白色') }
}

function freightShipmentPayload(client, productId, overrides) {
  return Object.assign({
    confirmed: true,
    requestId: 'freight-shipment',
    clientId: client.id,
    shipmentDate: '2026-09-19',
    items: [{ productId, quantityText: '100', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '18.00' }]
  }, overrides || {})
}

test('运费为空时按0元入账，总金额等于商品合计', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-empty', freightYuan: ''
  }))
  assert.equal(shipment.itemsSubtotalCents, 180000)
  assert.equal(shipment.freightCents, 0)
  assert.equal(shipment.totalAmountCents, 180000)
})

test('运费120元与商品1800元合计1920元，服务端不信任前端总额', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-120', freightYuan: '120',
    itemsSubtotalCents: 1, totalAmountCents: 1
  }))
  assert.equal(shipment.itemsSubtotalCents, 180000)
  assert.equal(shipment.freightCents, 12000)
  assert.equal(shipment.totalAmountCents, 192000)
  assert.equal(repository.getClientLedger('tenant_a', client.id).outstandingCents, 192000)
})

test('运费小数12.50元正确保存为1250分', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-decimal', freightYuan: '12.50'
  }))
  assert.equal(shipment.freightCents, 1250)
  assert.equal(shipment.totalAmountCents, 181250)
})

test('负数运费必须禁止入账', () => {
  const { repository, client, productId } = setup()
  assert.throws(() => repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-negative-yuan', freightYuan: '-1'
  })), /运费必须/)
  assert.throws(() => repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-negative-cents', freightCents: -1
  })), /运费必须/)
  assert.equal(repository.listShipments('tenant_a').length, 0)
})

test('修改已入账运费后本期应收、剩余应收和审计快照同步更新', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-edit', freightYuan: '120'
  }))
  repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'freight-edit-payment', clientId: client.id,
    amountYuan: '1000', method: '银行转账'
  })
  const revised = repository.updateShipment('tenant_a', shipment.id, {
    confirmed: true, reason: '原运费录错，改为80元', freightYuan: '80',
    items: [{ productId, quantityText: '100', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '18.00' }]
  })
  assert.equal(revised.itemsSubtotalCents, 180000)
  assert.equal(revised.freightCents, 8000)
  assert.equal(revised.totalAmountCents, 188000)
  const ledger = repository.getClientLedger('tenant_a', client.id)
  assert.equal(ledger.shipmentTotalCents, 188000)
  assert.equal(ledger.receivedCents, 100000)
  assert.equal(ledger.outstandingCents, 88000)
  const audit = repository.getAuditLogs('tenant_a', shipment.id).find(item => item.action === 'UPDATE_SHIPMENT')
  assert.equal(audit.before.freightCents, 12000)
  assert.equal(audit.after.freightCents, 8000)
  assert.equal(audit.reason, '原运费录错，改为80元')

  const preserved = repository.updateShipment('tenant_a', shipment.id, {
    confirmed: true, reason: '只修正备注时保留原运费',
    items: [{ productId, quantityText: '100', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '18.00' }]
  })
  assert.equal(preserved.freightCents, 8000)
  assert.equal(preserved.totalAmountCents, 188000)
})

test('升级前的历史发货自动补齐商品合计和0元运费，原总额不变', () => {
  const { repository, storage, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'legacy-shipment'
  }))
  const root = storage.read()
  const stored = root.tenants.tenant_a.shipments.find(item => item.id === shipment.id)
  delete stored.itemsSubtotalCents
  delete stored.freightCents
  storage.write(root)

  const legacy = repository.getShipment('tenant_a', shipment.id)
  assert.equal(legacy.itemsSubtotalCents, 180000)
  assert.equal(legacy.freightCents, 0)
  assert.equal(legacy.totalAmountCents, 180000)
})

test('对账单和已结清历史账单保留商品、运费与最终金额快照', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-history', freightYuan: '120'
  }))
  const currentStatement = repository.getStatement('tenant_a', client.id, shipment.periodId)
  assert.equal(currentStatement.shipments[0].itemsSubtotalCents, 180000)
  assert.equal(currentStatement.shipments[0].freightCents, 12000)
  assert.equal(currentStatement.shipments[0].totalAmountCents, 192000)
  assert.equal(currentStatement.totals.itemsSubtotalCents, 180000)
  assert.equal(currentStatement.totals.freightCents, 12000)
  assert.equal(currentStatement.totals.shipmentTotalCents, 192000)

  repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'freight-history-payment', clientId: client.id,
    amountYuan: '1920', paymentDate: '2026-09-19', method: '银行转账'
  })
  repository.closeBillingPeriod('tenant_a', {
    confirmed: true, requestId: 'close-freight-history', clientId: client.id,
    periodId: shipment.periodId, closedDate: '2026-09-19'
  })
  const history = repository.getStatement('tenant_a', client.id, shipment.periodId)
  assert.equal(history.period.status, 'settled')
  assert.equal(history.shipments[0].freightCents, 12000)
  assert.equal(history.totals.shipmentTotalCents, 192000)

  const statementMarkup = fs.readFileSync(path.join(__dirname, '../pages/statement/statement.wxml'), 'utf8')
  const historyMarkup = fs.readFileSync(path.join(__dirname, '../pages/history/history.wxml'), 'utf8')
  assert.match(statementMarkup, /商品小计/)
  assert.match(statementMarkup, /运费/)
  assert.match(statementMarkup, /本次合计/)
  assert.match(historyMarkup, /含运费/)
})

test('客户收款使用含运费后的总金额，归零后仍需人工确认结清', () => {
  const { repository, client, productId } = setup()
  repository.postShipment('tenant_a', freightShipmentPayload(client, productId, {
    requestId: 'freight-settlement', freightYuan: '120'
  }))
  const goodsPayment = repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'goods-only-payment', clientId: client.id,
    amountYuan: '1800', method: '银行转账'
  })
  assert.equal(goodsPayment.remainingCents, 12000)
  assert.equal(goodsPayment.periodStatus, 'open')
  const freightPayment = repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'freight-only-payment', clientId: client.id, paymentDate: '2026-09-19',
    amountYuan: '120', method: '微信'
  })
  assert.equal(freightPayment.remainingCents, 0)
  assert.equal(freightPayment.periodStatus, 'open')
  assert.equal(freightPayment.needsSettlementConfirmation, true)
  repository.closeBillingPeriod('tenant_a', {
    confirmed: true, requestId: 'close-freight-settlement', clientId: client.id,
    periodId: freightPayment.periodId, closedDate: '2026-09-19'
  })
  assert.equal(repository.listBillingPeriods('tenant_a', client.id, 'settled').length, 1)
})

test('正式闭环：客户价、持续发货、部分收款、全额结清、历史和新账期', () => {
  const { repository, client, productId } = setup()
  repository.saveCustomerPrice('tenant_a', {
    confirmed: true, clientId: client.id, productId, unit: '米', unitPriceYuan: '6.80'
  })
  const first = repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'shipment-1', clientId: client.id, shipmentDate: '2026-09-18',
    items: [{ productId, quantityText: '100', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  })
  const second = repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'shipment-2', clientId: client.id, shipmentDate: '2026-09-20',
    items: [{ productId, quantityText: '50', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  })
  assert.equal(first.periodId, second.periodId)
  const initialLedger = repository.getClientLedger('tenant_a', client.id)
  assert.equal(initialLedger.shipmentCount, 2)
  assert.equal(initialLedger.shipmentTotalCents, 102000)
  assert.equal(initialLedger.receivedCents, 0)
  assert.equal(initialLedger.outstandingCents, 102000)

  const partial = repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'payment-1', clientId: client.id, amountYuan: '500.00',
    paymentDate: '2026-09-30', method: '银行转账', note: '第一次'
  })
  assert.equal(partial.remainingCents, 52000)
  assert.equal(partial.periodStatus, 'open')

  const final = repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'payment-2', clientId: client.id, amountYuan: '520.00',
    paymentDate: '2026-10-02', method: '微信', note: '尾款'
  })
  assert.equal(final.remainingCents, 0)
  assert.equal(final.periodStatus, 'open')
  assert.equal(final.needsSettlementConfirmation, true)
  assert.equal(repository.listBillingPeriods('tenant_a', client.id, 'settled').length, 0)
  repository.closeBillingPeriod('tenant_a', {
    confirmed: true, requestId: 'close-period-1', clientId: client.id,
    periodId: first.periodId, closedDate: '2026-10-02'
  })
  assert.equal(repository.getClientLedger('tenant_a', client.id).outstandingCents, 0)
  assert.equal(repository.listBillingPeriods('tenant_a', client.id, 'settled').length, 1)

  const history = repository.getStatement('tenant_a', client.id, first.periodId)
  assert.equal(history.shipments.length, 2)
  assert.equal(history.payments.length, 2)
  assert.equal(history.totals.shipmentTotalCents, 102000)
  assert.equal(history.totals.receivedCents, 102000)

  const next = repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'shipment-3', clientId: client.id, shipmentDate: '2026-10-03',
    items: [{ productId, quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '7.00' }]
  })
  assert.notEqual(next.periodId, first.periodId)
  assert.equal(repository.getClientLedger('tenant_a', client.id).outstandingCents, 7000)
  assert.equal(history.shipments[0].lines[0].unitPriceCents, 680)
})

test('账目修正保留前后审计，已结清后禁止修改且不能低于已收款', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'shipment-edit', clientId: client.id,
    items: [{ productId, quantityText: '100', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  })
  repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'payment-part', clientId: client.id, amountYuan: '500', method: '现金'
  })
  assert.throws(() => repository.updateShipment('tenant_a', shipment.id, {
    confirmed: true, reason: '数量录错',
    items: [{ productId, quantityText: '50', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  }), /不能低于已收款/)

  const revised = repository.updateShipment('tenant_a', shipment.id, {
    confirmed: true, reason: '数量录错，应为80米',
    items: [{ productId, quantityText: '80', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  })
  assert.equal(revised.totalAmountCents, 54400)
  const updateLog = repository.getAuditLogs('tenant_a', shipment.id).find(item => item.action === 'UPDATE_SHIPMENT')
  assert.equal(updateLog.reason, '数量录错，应为80米')
  assert.equal(updateLog.before.totalAmountCents, 68000)
  assert.equal(updateLog.after.totalAmountCents, 54400)

  repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'payment-final', clientId: client.id,
    paymentDate: '2026-09-19', amountYuan: '44', method: '微信'
  })
  repository.closeBillingPeriod('tenant_a', {
    confirmed: true, requestId: 'close-after-edit', clientId: client.id,
    periodId: shipment.periodId, closedDate: '2026-09-19'
  })
  assert.throws(() => repository.updateShipment('tenant_a', shipment.id, {
    confirmed: true, reason: '再次修改',
    items: [{ productId, quantityText: '81', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  }), /已结清/)
})

test('收款校验企业、客户和剩余金额边界', () => {
  const { repository, client, productId } = setup()
  repository.initializeTenant('tenant_b', {
    enterprise: { id: 'tenant_b', name: 'B企业' }, clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'shipment-boundary', clientId: client.id,
    items: [{ productId, quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  })
  assert.throws(() => repository.recordPayment('tenant_a', {
    confirmed: true, requestId: 'too-much', clientId: client.id, amountYuan: '69', method: '银行转账'
  }), /不能超过/)
  assert.throws(() => repository.recordPayment('tenant_b', {
    confirmed: true, requestId: 'cross-tenant', clientId: client.id, amountYuan: '10', method: '银行转账'
  }), /客户不存在/)
})

test('标准和自定义产品都可按企业停用，且历史成交快照不受影响', () => {
  const { repository, client, productId } = setup()
  const shipment = repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'before-disable', clientId: client.id,
    items: [{ productId, quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  })
  repository.setProductActive('tenant_a', productId, false)
  assert.equal(repository.listProducts('tenant_a').some(item => item.id === productId), false)
  assert.equal(repository.listProducts('tenant_a', { includeInactive: true }).find(item => item.id === productId).active, false)
  assert.equal(repository.getShipment('tenant_a', shipment.id).lines[0].productSnapshot.label, '40×40 / 粗齿 / 白色')
  assert.throws(() => repository.postShipment('tenant_a', {
    confirmed: true, requestId: 'after-disable', clientId: client.id,
    items: [{ productId, quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '6.80' }]
  }), /已停用/)
  repository.setProductActive('tenant_a', productId, true)
  assert.equal(repository.listProducts('tenant_a').some(item => item.id === productId), true)
})
