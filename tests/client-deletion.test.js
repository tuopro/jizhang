const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createMemoryStorage } = require('../services/storage')
const { createLedgerRepository } = require('../services/ledger-repository')
const { buildProductId } = require('../data/product-specs')

const projectRoot = path.resolve(__dirname, '..')

function setup() {
  const storage = createMemoryStorage()
  let id = 0
  const makeId = prefix => `${prefix}_${++id}`
  const now = () => new Date('2026-09-20T08:00:00.000Z')
  const adminActor = { id: 'member_admin', tenantId: 'tenant_a', displayName: '郑晓拓', role: 'admin', status: 'active' }
  const memberActor = { id: 'member_b', tenantId: 'tenant_a', displayName: '王小明', role: 'member', status: 'active' }
  const repoFor = actor => createLedgerRepository(storage, { makeId, now, actor })
  const admin = repoFor(adminActor)
  const member = repoFor(memberActor)
  admin.initializeTenant('tenant_a', {
    enterprise: { id: 'tenant_a', name: '德赛线槽', defaultUnit: '米' },
    memberships: [adminActor, memberActor],
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  admin.initializeTenant('tenant_b', {
    enterprise: { id: 'tenant_b', name: '其他企业', defaultUnit: '米' },
    memberships: [{ id: 'member_other', tenantId: 'tenant_b', displayName: '其他管理员', role: 'admin', status: 'active' }],
    clients: [{ id: 'client_other', tenantId: 'tenant_b', name: '其他企业客户', active: true }],
    customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  return { storage, admin, member, productId: buildProductId(40, 40, '粗齿', '白色') }
}

function createClient(repository, name) {
  return repository.saveClient('tenant_a', { confirmed: true, name })
}

function postShipment(context, repository, client, requestId) {
  return repository.postShipment('tenant_a', {
    confirmed: true, requestId, clientId: client.id, shipmentDate: '2026-09-20',
    items: [{ productId: context.productId, quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '10' }]
  })
}

function addRawRelation(context, field, record) {
  const root = context.storage.read()
  root.tenants.tenant_a[field].push(record)
  context.storage.write(root)
}

test('普通成员可以删除空客户，客户消失并保留DELETE_EMPTY_CLIENT审计', () => {
  const context = setup()
  const client = createClient(context.member, '测试空客户')
  const preview = context.member.getClientDeletePreview('tenant_a', client.id)
  assert.equal(preview.hasBusinessData, false)
  assert.equal(preview.canDelete, true)
  const result = context.member.deleteClient('tenant_a', { confirmed: true, clientId: client.id })
  assert.equal(result.action, 'DELETE_EMPTY_CLIENT')
  assert.equal(context.member.getClient('tenant_a', client.id), null)
  const audit = context.admin.getAuditLogs('tenant_a', client.id).find(item => item.action === 'DELETE_EMPTY_CLIENT')
  assert.equal(audit.clientNameSnapshot, '测试空客户')
  assert.equal(audit.deletedByMemberId, 'member_b')
  assert.equal(audit.deletedByNameSnapshot, '王小明')
})

test('普通成员不能删除存在shipment的客户，即使本人是客户负责人或伪造role=admin', () => {
  const context = setup()
  const client = createClient(context.member, '成员有账客户')
  postShipment(context, context.member, client, 'member-shipment')
  assert.equal(client.ownerMemberId, 'member_b')
  assert.throws(() => context.member.deleteClient('tenant_a', {
    confirmed: true, clientId: client.id, role: 'admin', confirmationName: client.name
  }), /普通成员不能删除/)
  assert.ok(context.member.getClient('tenant_a', client.id))
})

test('普通成员会分别被payment、billing_period和customer_price任一关联阻止', () => {
  const relationCases = [
    ['payments', { id: 'payment_raw', tenantId: 'tenant_a', clientId: '', periodId: 'period_raw', amountCents: 100, status: 'posted' }],
    ['billingPeriods', { id: 'period_raw', tenantId: 'tenant_a', clientId: '', status: 'open' }],
    ['customerPrices', { id: 'price_raw', tenantId: 'tenant_a', clientId: '', productId: 'product_raw', unit: '米', unitPriceCents: 100, active: true }]
  ]
  relationCases.forEach(([field, record], index) => {
    const context = setup()
    const client = createClient(context.member, `关联客户${index}`)
    record.clientId = client.id
    addRawRelation(context, field, record)
    const preview = context.member.getClientDeletePreview('tenant_a', client.id)
    assert.equal(preview.hasBusinessData, true)
    assert.equal(preview.canDelete, false)
    assert.throws(() => context.member.deleteClient('tenant_a', {
      confirmed: true, clientId: client.id, confirmationName: client.name
    }), /普通成员不能删除/)
  })
})

test('管理员可以删除空客户', () => {
  const context = setup()
  const client = createClient(context.admin, '管理员空客户')
  const result = context.admin.deleteClient('tenant_a', { confirmed: true, clientId: client.id })
  assert.equal(result.action, 'DELETE_EMPTY_CLIENT')
  assert.equal(context.admin.getClient('tenant_a', client.id), null)
})

test('管理员删除有账客户前预览发货、收款、账期、价格、进行中账期和未收金额', () => {
  const context = setup()
  const client = createClient(context.admin, '杭州测试电气')
  const shipment = postShipment(context, context.admin, client, 'preview-shipment')
  context.admin.recordPayment('tenant_a', {
    confirmed: true, requestId: 'preview-payment', clientId: client.id, periodId: shipment.periodId,
    amountYuan: '40', paymentDate: '2026-09-20', method: '银行转账'
  })
  context.admin.saveCustomerPrice('tenant_a', {
    confirmed: true, clientId: client.id, productId: context.productId, unit: '米', unitPriceYuan: '10'
  })
  const preview = context.admin.getClientDeletePreview('tenant_a', client.id)
  assert.deepEqual({
    shipments: preview.shipmentCount,
    payments: preview.paymentCount,
    periods: preview.billingPeriodCount,
    prices: preview.customerPriceCount,
    open: preview.openPeriodCount,
    outstanding: preview.outstandingAmountCents
  }, { shipments: 1, payments: 1, periods: 1, prices: 1, open: 1, outstanding: 6000 })
  assert.equal(preview.requiresStrongConfirmation, true)
})

test('管理员必须准确输入客户名称，才能彻底删除有正式账务的客户', () => {
  const context = setup()
  const client = createClient(context.admin, '强确认客户')
  postShipment(context, context.admin, client, 'strong-confirm-shipment')
  assert.throws(() => context.admin.deleteClient('tenant_a', {
    confirmed: true, clientId: client.id, confirmationName: '输错名称'
  }), /准确输入客户名称/)
  assert.ok(context.admin.getClient('tenant_a', client.id))
})

test('管理员彻底删除客户及全部专属账务，但保留旧审计和最终删除摘要', () => {
  const context = setup()
  const client = createClient(context.admin, '完整删除客户')
  const shipment = postShipment(context, context.admin, client, 'full-delete-shipment')
  context.admin.recordPayment('tenant_a', {
    confirmed: true, requestId: 'full-delete-payment', clientId: client.id, periodId: shipment.periodId,
    amountYuan: '30', method: '现金'
  })
  context.admin.saveCustomerPrice('tenant_a', {
    confirmed: true, clientId: client.id, productId: context.productId, unit: '米', unitPriceYuan: '10'
  })
  const result = context.admin.deleteClient('tenant_a', {
    confirmed: true, clientId: client.id, confirmationName: client.name,
    shipmentCount: 0, paymentCount: 0, role: 'member'
  })
  assert.equal(result.action, 'DELETE_CLIENT_WITH_LEDGER')
  assert.equal(result.shipmentCount, 1)
  assert.equal(result.paymentCount, 1)
  assert.equal(result.billingPeriodCount, 1)
  assert.equal(result.customerPriceCount, 1)
  assert.equal(context.admin.getClient('tenant_a', client.id), null)
  assert.equal(context.admin.getShipment('tenant_a', shipment.id), null)
  assert.equal(context.admin.listPayments('tenant_a', client.id).length, 0)
  assert.equal(context.admin.listBillingPeriods('tenant_a', client.id).length, 0)
  assert.throws(() => context.admin.listCustomerPrices('tenant_a', client.id), /无权管理该客户价格/)
  assert.equal(context.storage.read().tenants.tenant_a.customerPrices.filter(price => price.clientId === client.id).length, 0)
  const logs = context.admin.getAuditLogs('tenant_a', client.id)
  assert.ok(logs.some(item => item.action === 'CREATE_CLIENT'))
  const audit = logs.find(item => item.action === 'DELETE_CLIENT_WITH_LEDGER')
  assert.equal(audit.clientNameSnapshot, '完整删除客户')
  assert.equal(audit.deletedByMemberId, 'member_admin')
  assert.equal(audit.shipmentCount, 1)
})

test('删除客户A不影响客户B、企业共享标准产品和企业共享自定义产品', () => {
  const context = setup()
  const clientA = createClient(context.admin, '客户A')
  const clientB = createClient(context.admin, '客户B')
  const custom = context.admin.createCustomProduct('tenant_a', { confirmed: true, name: '共享定制线槽' })
  postShipment(context, context.admin, clientA, 'client-a-shipment')
  postShipment(context, context.admin, clientB, 'client-b-shipment')
  context.admin.deleteClient('tenant_a', {
    confirmed: true, clientId: clientA.id, confirmationName: clientA.name
  })
  assert.ok(context.admin.getClient('tenant_a', clientB.id))
  assert.equal(context.admin.listShipments('tenant_a', clientB.id).length, 1)
  assert.ok(context.admin.listProducts('tenant_a').some(item => item.id === context.productId))
  assert.ok(context.admin.listCustomProducts('tenant_a').some(item => item.id === custom.id))
})

test('删除客户不会删除enterprise、memberships或邀请类数据结构', () => {
  const context = setup()
  const client = createClient(context.admin, '共享数据保护客户')
  const memberIdentity = items => items.map(item => ({ id: item.id, role: item.role, status: item.status, displayName: item.displayName }))
  const beforeMembers = memberIdentity(context.admin.listMembers('tenant_a'))
  const beforeEnterprise = context.admin.getEnterprise('tenant_a')
  context.admin.deleteClient('tenant_a', { confirmed: true, clientId: client.id })
  assert.deepEqual(context.admin.getEnterprise('tenant_a'), beforeEnterprise)
  assert.deepEqual(memberIdentity(context.admin.listMembers('tenant_a')), beforeMembers)
  const root = context.storage.read()
  assert.equal(Object.prototype.hasOwnProperty.call(root.tenants.tenant_a, 'memberInvites'), false)
})

test('tenant A管理员即使知道tenant B clientId也无法预览或删除', () => {
  const context = setup()
  assert.throws(() => context.admin.getClientDeletePreview('tenant_b', 'client_other'), /企业数据空间不存在/)
  assert.throws(() => context.admin.deleteClient('tenant_b', {
    confirmed: true, clientId: 'client_other', confirmationName: '其他企业客户'
  }), /企业数据空间不存在/)
  assert.ok(context.admin.getClient('tenant_b', 'client_other'))
})

test('preview后新增业务时deleteClient重新统计，普通成员和管理员空客户快捷确认都不能绕过', () => {
  const context = setup()
  const memberClient = createClient(context.member, '并发成员客户')
  assert.equal(context.member.getClientDeletePreview('tenant_a', memberClient.id).hasBusinessData, false)
  postShipment(context, context.admin, memberClient, 'concurrent-member-shipment')
  assert.throws(() => context.member.deleteClient('tenant_a', {
    confirmed: true, clientId: memberClient.id
  }), /普通成员不能删除/)

  const adminClient = createClient(context.admin, '并发管理员客户')
  assert.equal(context.admin.getClientDeletePreview('tenant_a', adminClient.id).hasBusinessData, false)
  postShipment(context, context.member, adminClient, 'concurrent-admin-shipment')
  assert.throws(() => context.admin.deleteClient('tenant_a', {
    confirmed: true, clientId: adminClient.id
  }), /重新预览/)
})

test('删除后旧clientId、periodId和shipmentId读取安全返回不存在', () => {
  const context = setup()
  const client = createClient(context.admin, '旧链接客户')
  const shipment = postShipment(context, context.admin, client, 'old-link-shipment')
  context.admin.deleteClient('tenant_a', {
    confirmed: true, clientId: client.id, confirmationName: client.name
  })
  assert.equal(context.admin.getClient('tenant_a', client.id), null)
  assert.equal(context.admin.getShipment('tenant_a', shipment.id), null)
  assert.equal(context.admin.getPeriodDetail('tenant_a', shipment.periodId), null)
  assert.equal(context.admin.getStatement('tenant_a', client.id, shipment.periodId), null)
})

test('云函数删除由服务端身份和事务控制，前端不能提交tenantId、memberId或role决定权限', () => {
  const cloudIndex = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/ledger/index.js'), 'utf8')
  const security = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/ledger/services/member-security.js'), 'utf8')
  assert.match(cloudIndex, /READ_ACTIONS = new Set\(\['getClientDeletePreview'/)
  assert.match(cloudIndex, /transaction\.collection\(collectionName\)\.doc\(item\.id\)\.remove\(\)/)
  assert.match(cloudIndex, /await persistChanges\(transaction, tenantId, before, finalSnapshot\)/)
  assert.match(security, /'deleteClient'/)
  assert.doesNotMatch(cloudIndex, /event\s*\.\s*(tenantId|memberId|role)/)
})

test('客户删除页面提供影响统计、欠款警告、名称完全匹配和危险操作区', () => {
  const page = fs.readFileSync(path.join(projectRoot, 'pages/client-ledger/client-ledger.js'), 'utf8')
  const markup = fs.readFileSync(path.join(projectRoot, 'pages/client-ledger/client-ledger.wxml'), 'utf8')
  assert.match(page, /value === this\.data\.deletePreview\.clientName/)
  assert.match(page, /getClientDeletePreview/)
  assert.match(markup, /发货记录/)
  assert.match(markup, /收款记录/)
  assert.match(markup, /进行中账期/)
  assert.match(markup, /仍有未收款/)
  assert.match(markup, /彻底删除/)
  assert.match(markup, /删除客户/)
})
