const test = require('node:test')
const assert = require('node:assert/strict')

const { parseOrderText } = require('../services/order-parser')
const { createMemoryStorage } = require('../services/storage')
const { createLedgerRepository } = require('../services/ledger-repository')
const { buildProductId, buildCoverProductId } = require('../data/product-specs')
const { DEMO_TENANT_ID, DEMO_CLIENT_ID, createDemoSeed } = require('../data/demo-seed')
const { centsToYuan } = require('../utils/money')

function createTestRepository() {
  let idCounter = 0
  return createLedgerRepository(createMemoryStorage(), {
    now: () => new Date('2026-09-18T08:00:00.000Z'),
    makeId: prefix => `${prefix}_${++idCounter}`
  })
}

test('第一阶段核心验收闭环：缺价补充、保存客户价并入账3020元', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const parsed = parseOrderText('40×40开口灰色 100米\n60×40细齿灰色 50米\n80×60开口灰色 30米')
  assert.equal(parsed.items.length, 3)

  const prices = parsed.items.map(item =>
    repository.getCustomerPrice(DEMO_TENANT_ID, DEMO_CLIENT_ID, item.productId, item.unit)
  )
  assert.equal(centsToYuan(prices[0].unitPriceCents), '12.50')
  assert.equal(centsToYuan(prices[1].unitPriceCents), '18.60')
  assert.equal(prices[2], null)
  const white4040Price = repository.getCustomerPrice(
    DEMO_TENANT_ID,
    DEMO_CLIENT_ID,
    buildProductId(40, 40, '粗齿', '白色'),
    '米'
  )
  assert.equal(white4040Price.unitPriceCents, 680)

  const shipment = repository.postShipment(DEMO_TENANT_ID, {
    requestId: 'acceptance-request-1',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    shipmentDate: '2026-09-18',
    sourceText: parsed.normalizedText,
    items: [
      { productId: parsed.items[0].productId, quantityText: '100', unit: '米', unitPriceYuan: '12.50', saveAsDefault: false },
      { productId: parsed.items[1].productId, quantityText: '50', unit: '米', unitPriceYuan: '18.60', saveAsDefault: false },
      { productId: parsed.items[2].productId, quantityText: '30', unit: '米', unitPriceYuan: '28.00', saveAsDefault: true }
    ]
  })

  assert.equal(shipment.totalAmountCents, 302000)
  assert.deepEqual(shipment.lines.map(line => line.lineAmountCents), [125000, 93000, 84000])
  assert.equal(repository.getDashboard(DEMO_TENANT_ID).totalOutstandingCents, 302000)

  const savedPrice = repository.getCustomerPrice(
    DEMO_TENANT_ID,
    DEMO_CLIENT_ID,
    buildProductId(80, 60, '粗齿', '灰色'),
    '米'
  )
  assert.equal(savedPrice.unitPriceCents, 2800)
  assert.equal(repository.getAuditLogs(DEMO_TENANT_ID).length, 1)
})

test('同一防重复编号不会重复入账', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const payload = {
    requestId: 'same-request',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    items: [
      {
        productId: buildProductId(40, 40, '粗齿', '灰色'),
        quantityText: '100',
        unit: '米',
        unitPriceYuan: '12.50',
        saveAsDefault: false
      }
    ]
  }
  const first = repository.postShipment(DEMO_TENANT_ID, payload)
  const second = repository.postShipment(DEMO_TENANT_ID, payload)
  assert.equal(first.id, second.id)
  assert.equal(repository.listShipments(DEMO_TENANT_ID).length, 1)
})

test('未明确人工确认、缺价格或不存在产品时整笔拒绝', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const base = {
    requestId: 'invalid-request',
    clientId: DEMO_CLIENT_ID,
    items: [{
      productId: buildProductId(40, 40, '粗齿', '灰色'),
      quantityText: '100',
      unit: '米',
      unitPriceYuan: '12.50'
    }]
  }
  assert.throws(() => repository.postShipment(DEMO_TENANT_ID, base), /人工确认/)
  assert.throws(() => repository.postShipment(DEMO_TENANT_ID, Object.assign({}, base, {
    confirmed: true,
    requestId: 'missing-price',
    items: [Object.assign({}, base.items[0], { unitPriceYuan: '' })]
  })), /缺少有效单价/)
  assert.equal(repository.listShipments(DEMO_TENANT_ID).length, 0)
})

test('企业数据空间严格隔离', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  repository.initializeTenant('tenant_b', {
    enterprise: { id: 'tenant_b', name: 'B公司', defaultUnit: '米' },
    clients: [{ id: 'client_b', name: 'B客户', active: true }],
    customerPrices: [],
    shipments: [],
    auditLogs: []
  })

  assert.equal(repository.getClient('tenant_b', DEMO_CLIENT_ID), null)
  assert.equal(repository.getClient(DEMO_TENANT_ID, 'client_b'), null)
  assert.equal(repository.listShipments('tenant_b').length, 0)
  assert.equal(repository.listClients(DEMO_TENANT_ID).length, 1)
  assert.equal(repository.listClients('tenant_b').length, 1)
})

test('旧试运行数据非覆盖式补入白色演示价', () => {
  const seed = createDemoSeed()
  const whiteProductId = buildProductId(40, 40, '粗齿', '白色')
  seed.customerPrices = seed.customerPrices.filter(price => price.productId !== whiteProductId)
  const storage = createMemoryStorage({
    schemaVersion: 1,
    tenants: { [DEMO_TENANT_ID]: seed }
  })
  const repository = createLedgerRepository(storage)
  repository.initializeDemoTenant()
  assert.equal(repository.getCustomerPrice(
    DEMO_TENANT_ID,
    DEMO_CLIENT_ID,
    whiteProductId,
    '米'
  ).unitPriceCents, 680)

  const root = storage.read()
  root.tenants[DEMO_TENANT_ID].customerPrices.find(price =>
    price.productId === whiteProductId
  ).unitPriceCents = 720
  storage.write(root)
  repository.initializeDemoTenant()
  assert.equal(repository.getCustomerPriceForProduct(
    DEMO_TENANT_ID,
    DEMO_CLIENT_ID,
    whiteProductId
  ).unitPriceCents, 720)
})

test('历史发货保留成交价快照，后续调价不会回写旧记录', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const productId = buildProductId(80, 60, '粗齿', '灰色')
  repository.postShipment(DEMO_TENANT_ID, {
    requestId: 'history-1',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    items: [{ productId, quantityText: '30', unit: '米', unitPriceYuan: '28.00', saveAsDefault: true }]
  })
  repository.postShipment(DEMO_TENANT_ID, {
    requestId: 'history-2',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    items: [{ productId, quantityText: '10', unit: '米', unitPriceYuan: '30.00', saveAsDefault: true }]
  })

  const shipments = repository.listShipments(DEMO_TENANT_ID)
  const firstShipment = shipments.find(item => item.requestId === 'history-1')
  const secondShipment = shipments.find(item => item.requestId === 'history-2')
  assert.equal(firstShipment.lines[0].unitPriceCents, 2800)
  assert.equal(secondShipment.lines[0].unitPriceCents, 3000)
  assert.equal(repository.getCustomerPrice(DEMO_TENANT_ID, DEMO_CLIENT_ID, productId, '米').unitPriceCents, 3000)
})

test('自定义产品经人工确认后入库、防重，并可按根保存客户专属价', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const firstParse = parseOrderText('白色装潢1525，1.3米长的50根')
  const draft = firstParse.items[0].customProductDraft

  assert.throws(() => repository.createCustomProduct(DEMO_TENANT_ID, draft), /人工确认/)
  const product = repository.createCustomProduct(DEMO_TENANT_ID, Object.assign({ confirmed: true }, draft))
  assert.equal(product.unitLengthMeters, 1.3)
  assert.ok(Array.isArray(product.aliases))
  assert.ok(Array.isArray(product.recognitionKeywords))
  const duplicate = repository.createCustomProduct(DEMO_TENANT_ID, {
    confirmed: true,
    name: '白色 装潢 1525 - 1.3米/根'
  })
  assert.equal(duplicate.id, product.id)
  assert.equal(repository.listCustomProducts(DEMO_TENANT_ID).length, 1)

  const secondParse = parseOrderText('白色装潢1525，1.3米的200根', {
    customProducts: repository.listCustomProducts(DEMO_TENANT_ID)
  })
  assert.equal(secondParse.items[0].productId, product.id)

  const shipment = repository.postShipment(DEMO_TENANT_ID, {
    requestId: 'custom-root-price',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    sourceText: secondParse.normalizedText,
    items: [{
      productId: product.id,
      sourceText: secondParse.items[0].sourceText,
      quantityText: '200',
      orderUnit: '根',
      pricingUnit: '根',
      unitPriceYuan: '12.50',
      saveAsDefault: true
    }]
  })
  assert.equal(shipment.totalAmountCents, 250000)
  assert.equal(shipment.lines[0].originalUnit, '根')
  assert.equal(shipment.lines[0].pricingUnit, '根')
  assert.equal(shipment.lines[0].productSnapshot.name, '白色装潢1525 1.3米长')
  assert.equal(shipment.lines[0].productSnapshot.unitLengthMeters, 1.3)
  assert.equal(repository.getCustomerPriceForProduct(
    DEMO_TENANT_ID,
    DEMO_CLIENT_ID,
    product.id
  ).unit, '根')
})

test('自定义规格单根长度只提供人工换算依据，不会绕过单位锁定', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const product = repository.createCustomProduct(DEMO_TENANT_ID, {
    confirmed: true,
    name: '白色40×40-1.2米长',
    aliases: ['4040白1.2'],
    recognitionKeywords: ['4040白1.2'],
    height: 40,
    width: 40,
    color: '白色',
    unitLengthMeters: 1.2,
    lengthDescription: '1.2米/根'
  })
  const base = {
    requestId: 'custom-length-conversion',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    items: [{
      productId: product.id,
      quantityText: '1000',
      orderUnit: '根',
      pricingUnit: '米',
      unitPriceYuan: '2.90'
    }]
  }
  assert.throws(() => repository.postShipment(DEMO_TENANT_ID, base), /必须人工填写换算关系/)

  const shipment = repository.postShipment(DEMO_TENANT_ID, Object.assign({}, base, {
    requestId: 'custom-length-conversion-confirmed',
    items: [Object.assign({}, base.items[0], { conversionRateText: '1.2' })]
  }))
  assert.equal(shipment.totalAmountCents, 348000)
  assert.equal(shipment.lines[0].pricingQuantity, 1200)
  assert.equal(shipment.lines[0].productSnapshot.unitLengthMeters, 1.2)
  assert.deepEqual(shipment.lines[0].productSnapshot.aliases, ['4040白1.2'])
})

test('单位不一致时仓储服务也会拒绝猜测，并保存人工换算快照', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const productId = buildProductId(40, 40, '粗齿', '灰色')
  const base = {
    requestId: 'unit-mismatch',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    items: [{
      productId,
      quantityText: '50',
      orderUnit: '根',
      pricingUnit: '米',
      unitPriceYuan: '6.80'
    }]
  }
  assert.throws(() => repository.postShipment(DEMO_TENANT_ID, base), /必须人工填写换算关系/)

  const shipment = repository.postShipment(DEMO_TENANT_ID, Object.assign({}, base, {
    requestId: 'unit-converted',
    items: [Object.assign({}, base.items[0], { conversionRateText: '2' })]
  }))
  assert.equal(shipment.totalAmountCents, 68000)
  assert.equal(shipment.lines[0].pricingQuantity, 100)
  assert.deepEqual(shipment.lines[0].conversion, {
    fromUnit: '根',
    toUnit: '米',
    multiplier: 2
  })
})

test('盖子可复用原记账闭环并保存产品类型快照', () => {
  const repository = createTestRepository()
  repository.initializeDemoTenant()
  const shipment = repository.postShipment(DEMO_TENANT_ID, {
    requestId: 'cover-product',
    confirmed: true,
    clientId: DEMO_CLIENT_ID,
    items: [{
      productId: buildCoverProductId(60, '黑色'),
      quantityText: '20',
      orderUnit: '米',
      pricingUnit: '米',
      unitPriceYuan: '2.50',
      saveAsDefault: true
    }]
  })
  assert.equal(shipment.totalAmountCents, 5000)
  assert.equal(shipment.lines[0].productSnapshot.label, '60mm盖子 / 黑色')
  assert.equal(shipment.lines[0].productSnapshot.productType, 'cover')
})
