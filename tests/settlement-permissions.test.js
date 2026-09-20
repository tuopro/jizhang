const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createMemoryStorage } = require('../services/storage')
const { createLedgerRepository, canCloseBillingPeriod } = require('../services/ledger-repository')
const { buildProductId } = require('../data/product-specs')
const { assertMutationPermission } = require('../cloudfunctions/ledger/services/member-security')

const projectRoot = path.resolve(__dirname, '..')

function setup() {
  const storage = createMemoryStorage()
  let id = 0
  const makeId = prefix => `${prefix}_${++id}`
  const now = () => new Date('2026-09-20T08:00:00.000Z')
  const members = {
    admin: { id: 'member_admin', tenantId: 'tenant_a', displayName: '郑晓拓', role: 'admin', status: 'active' },
    owner: { id: 'member_owner', tenantId: 'tenant_a', displayName: '王小明', role: 'member', status: 'active' },
    other: { id: 'member_other', tenantId: 'tenant_a', displayName: '李小红', role: 'member', status: 'active' }
  }
  const repositoryFor = actor => createLedgerRepository(storage, { makeId, now, actor })
  const context = {
    storage,
    admin: repositoryFor(members.admin),
    owner: repositoryFor(members.owner),
    other: repositoryFor(members.other),
    members,
    productId: buildProductId(40, 40, '粗齿', '白色')
  }
  context.admin.initializeTenant('tenant_a', {
    enterprise: { id: 'tenant_a', name: '德赛线槽', defaultUnit: '米' },
    memberships: Object.values(members),
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  return context
}

function createOpenPeriod(context, options) {
  const config = options || {}
  const client = context.admin.saveClient('tenant_a', { confirmed: true, name: config.name || '结清测试客户' })
  if (config.clientOwnerId && config.clientOwnerId !== client.ownerMemberId) {
    context.admin.updateClientOwner('tenant_a', {
      confirmed: true, clientId: client.id, ownerMemberId: config.clientOwnerId, updateOpenPeriod: false
    })
  }
  const shipment = context.admin.postShipment('tenant_a', {
    confirmed: true,
    requestId: `shipment_${client.id}`,
    clientId: client.id,
    shipmentDate: '2026-09-20',
    items: [{
      productId: context.productId,
      quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '10'
    }]
  })
  const currentPeriod = context.admin.getPeriodDetail('tenant_a', shipment.periodId).period
  if (config.periodOwnerId && config.periodOwnerId !== currentPeriod.ownerMemberId) {
    context.admin.updateBillingPeriodOwner('tenant_a', {
      confirmed: true, periodId: shipment.periodId, ownerMemberId: config.periodOwnerId
    })
  }
  return { client, shipment, periodId: shipment.periodId }
}

function pay(context, repository, entry, amountYuan, requestId) {
  return repository.recordPayment('tenant_a', {
    confirmed: true,
    requestId,
    clientId: entry.client.id,
    periodId: entry.periodId,
    amountYuan,
    paymentDate: '2026-09-20',
    method: '银行转账'
  })
}

function close(repository, entry, requestId, extra) {
  return repository.closeBillingPeriod('tenant_a', Object.assign({
    confirmed: true,
    requestId,
    clientId: entry.client.id,
    periodId: entry.periodId,
    closedDate: '2026-09-20'
  }, extra || {}))
}

test('admin可以结清企业内任意负责人账期', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.owner, entry, '100', 'admin-any-payment')
  assert.equal(close(context.admin, entry, 'admin-any-close').status, 'settled')
})

test('member是当前账期负责人时可以结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.owner, entry, '100', 'owner-payment')
  assert.equal(close(context.owner, entry, 'owner-close').status, 'settled')
})

test('member是客户负责人但不是账期负责人时不能结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, {
    clientOwnerId: context.members.owner.id,
    periodOwnerId: context.members.other.id
  })
  pay(context, context.owner, entry, '100', 'client-owner-only-payment')
  assert.throws(() => close(context.owner, entry, 'client-owner-only-close'), /该账期由李小红负责/)
})

test('member既不是客户负责人也不是账期负责人时不能结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.other, entry, '100', 'other-payment')
  assert.throws(() => close(context.other, entry, 'other-close'), /仅账期负责人或管理员可以结清/)
})

test('账期负责人收款至0后可以主动结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  const payment = pay(context, context.owner, entry, '100', 'owner-zero-payment')
  assert.equal(payment.remainingCents, 0)
  assert.equal(payment.needsSettlementConfirmation, true)
  assert.equal(close(context.owner, entry, 'owner-zero-close').status, 'settled')
})

test('账期负责人余额未清零时仍不能结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.owner, entry, '40', 'owner-partial-payment')
  assert.throws(() => close(context.owner, entry, 'owner-partial-close'), /剩余应收不为0/)
})

test('非负责人即使余额为0也不能结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.other, entry, '100', 'non-owner-zero-payment')
  assert.throws(() => close(context.other, entry, 'non-owner-zero-close'), /仅账期负责人或管理员可以结清/)
})

test('前端伪造ownerMemberId不能获得结清权限', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.other, entry, '100', 'forged-owner-payment')
  assert.throws(() => close(context.other, entry, 'forged-owner-close', {
    ownerMemberId: context.members.other.id
  }), /仅账期负责人或管理员可以结清/)
})

test('前端伪造role为admin不能获得结清权限', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.other, entry, '100', 'forged-role-payment')
  assert.throws(() => close(context.other, entry, 'forged-role-close', {
    role: 'admin', memberId: context.members.owner.id
  }), /仅账期负责人或管理员可以结清/)
})

test('admin代为结清时审计记录实际admin操作人', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.owner, entry, '100', 'admin-audit-payment')
  close(context.admin, entry, 'admin-audit-close')
  const audit = context.admin.getAuditLogs('tenant_a', entry.periodId).find(item => item.action === 'CLOSE_BILLING_PERIOD')
  assert.equal(audit.performedByMemberId, context.members.admin.id)
  assert.equal(audit.performedByNameSnapshot, '郑晓拓')
  assert.equal(audit.after.ownerMemberId, context.members.owner.id)
})

test('member本人结清时审计记录实际member操作人', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.owner, entry, '100', 'member-audit-payment')
  close(context.owner, entry, 'member-audit-close')
  const audit = context.admin.getAuditLogs('tenant_a', entry.periodId).find(item => item.action === 'CLOSE_BILLING_PERIOD')
  assert.equal(audit.performedByMemberId, context.members.owner.id)
  assert.equal(audit.performedByNameSnapshot, '王小明')
  assert.equal(audit.after.ownerMemberId, context.members.owner.id)
})

test('已结清账期不能使用新请求重复结清', () => {
  const context = setup()
  const entry = createOpenPeriod(context, { periodOwnerId: context.members.owner.id })
  pay(context, context.owner, entry, '100', 'repeat-payment')
  close(context.owner, entry, 'repeat-close-first')
  assert.throws(() => close(context.owner, entry, 'repeat-close-second'), /本期已经结清/)
})

test('云函数入口允许member发起结清，但前端与领域服务统一按账期负责人判断', () => {
  assert.doesNotThrow(() => assertMutationPermission({ role: 'member' }, 'closeBillingPeriod', [{}]))
  assert.equal(canCloseBillingPeriod({ role: 'admin', memberId: 'admin' }, { ownerMemberId: 'owner' }), true)
  assert.equal(canCloseBillingPeriod({ role: 'member', memberId: 'owner' }, { ownerMemberId: 'owner' }), true)
  assert.equal(canCloseBillingPeriod({ role: 'member', memberId: 'other' }, { ownerMemberId: 'owner' }), false)

  const ledgerPage = fs.readFileSync(path.join(projectRoot, 'pages/client-ledger/client-ledger.js'), 'utf8')
  const paymentPage = fs.readFileSync(path.join(projectRoot, 'pages/payment-form/payment-form.js'), 'utf8')
  const cloudDomain = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/ledger/services/ledger-repository.js'), 'utf8')
  assert.match(ledgerPage, /canCloseBillingPeriod\(identity, period\)/)
  assert.match(paymentPage, /canCloseBillingPeriod\(identity, latestPeriod\)/)
  assert.match(cloudDomain, /canCloseBillingPeriod\(actor, resolvedPeriod\)/)
  assert.match(cloudDomain, /const actor = currentActor\(tenant\)/)
})
