const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createMemoryStorage } = require('../services/storage')
const { createLedgerRepository } = require('../services/ledger-repository')
const { buildProductId } = require('../data/product-specs')
const { validateInvite, validateDisplayName, assertMutationPermission } = require('../cloudfunctions/ledger/services/member-security')

const root = path.resolve(__dirname, '..')

function setup() {
  const storage = createMemoryStorage()
  let id = 0
  let nowText = '2026-09-19T06:32:00.000Z'
  const makeId = prefix => `${prefix}_${++id}`
  const members = [
    { id: 'member_a', tenantId: 'tenant_a', displayName: '郑晓拓', role: 'admin', status: 'active' },
    { id: 'member_b', tenantId: 'tenant_a', displayName: '王小明', role: 'member', status: 'active' },
    { id: 'member_c', tenantId: 'tenant_a', displayName: '李小红', role: 'member', status: 'active' }
  ]
  const repositoryFor = actor => createLedgerRepository(storage, {
    now: () => new Date(nowText), makeId, actor
  })
  const admin = repositoryFor(members[0])
  admin.initializeTenant('tenant_a', {
    enterprise: { id: 'tenant_a', name: '德赛线槽', defaultUnit: '米' },
    memberships: members,
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  admin.initializeTenant('tenant_b', {
    enterprise: { id: 'tenant_b', name: '其他企业', defaultUnit: '米' },
    memberships: [{ id: 'member_x', tenantId: 'tenant_b', displayName: '其他人', role: 'admin', status: 'active' }],
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  })
  return {
    storage, admin, memberB: repositoryFor(members[1]), memberC: repositoryFor(members[2]),
    productId: buildProductId(40, 40, '粗齿', '白色'),
    setNow(value) { nowText = value }
  }
}

function createClient(repository, name) {
  return repository.saveClient('tenant_a', { confirmed: true, name })
}

function ship(repository, clientId, productId, requestId, date) {
  return repository.postShipment('tenant_a', {
    confirmed: true, requestId, clientId, shipmentDate: date || '2026-09-19',
    items: [{ productId, quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '10' }]
  })
}

test('A或B创建客户时默认由真实当前成员负责，且双方仍共享查看全部客户', () => {
  const context = setup()
  const aClient = createClient(context.admin, '杭州客户')
  const bClient = createClient(context.memberB, '宁波客户')
  assert.equal(aClient.ownerMemberId, 'member_a')
  assert.equal(aClient.ownerNameSnapshot, '郑晓拓')
  assert.equal(bClient.ownerMemberId, 'member_b')
  assert.equal(bClient.ownerNameSnapshot, '王小明')
  assert.deepEqual(context.admin.listClients('tenant_a').map(item => item.id).sort(), context.memberB.listClients('tenant_a').map(item => item.id).sort())
  assert.deepEqual(context.memberB.listClients('tenant_a').filter(item => item.ownerMemberId === 'member_b').map(item => item.id), [bClient.id])
})

test('不同tenant继续绝对隔离，负责人字段不能替代tenant边界', () => {
  const context = setup()
  const client = createClient(context.admin, '企业A客户')
  assert.equal(context.admin.getClient('tenant_b', client.id), null)
  assert.equal(context.admin.listClients('tenant_b').length, 0)
})

test('新账期继承客户当前负责人，发货操作人可以是另一成员', () => {
  const context = setup()
  const client = createClient(context.admin, '跨成员客户')
  const shipment = ship(context.memberB, client.id, context.productId, 'member-b-shipment')
  const period = context.admin.getPeriodDetail('tenant_a', shipment.periodId).period
  assert.equal(period.ownerMemberId, 'member_a')
  assert.equal(period.ownerNameSnapshot, '郑晓拓')
  assert.equal(shipment.createdByMemberId, 'member_b')
  assert.equal(shipment.createdByNameSnapshot, '王小明')
})

test('B给A负责客户登记收款时账期负责人不变，payment记录B为登记人', () => {
  const context = setup()
  const client = createClient(context.admin, '收款客户')
  const shipment = ship(context.admin, client.id, context.productId, 'payment-source')
  const payment = context.memberB.recordPayment('tenant_a', {
    confirmed: true, requestId: 'payment-by-b', clientId: client.id, periodId: shipment.periodId,
    amountYuan: '100', paymentDate: '2026-09-19', method: '银行转账'
  })
  assert.equal(payment.createdByMemberId, 'member_b')
  assert.equal(payment.createdByNameSnapshot, '王小明')
  assert.equal(context.admin.getPeriodDetail('tenant_a', shipment.periodId).period.ownerMemberId, 'member_a')
})

test('客户负责人和当前账期负责人可以独立不同', () => {
  const context = setup()
  const client = createClient(context.admin, '独立负责人客户')
  const shipment = ship(context.admin, client.id, context.productId, 'independent-owner')
  context.admin.updateBillingPeriodOwner('tenant_a', {
    confirmed: true, periodId: shipment.periodId, ownerMemberId: 'member_b'
  })
  assert.equal(context.admin.getClient('tenant_a', client.id).ownerMemberId, 'member_a')
  assert.equal(context.admin.getPeriodDetail('tenant_a', shipment.periodId).period.ownerMemberId, 'member_b')
})

test('修改客户负责人可明确选择只改客户或连同当前账期一起转移', () => {
  const context = setup()
  const client = createClient(context.admin, '转移客户')
  const shipment = ship(context.admin, client.id, context.productId, 'transfer-owner')
  context.admin.updateClientOwner('tenant_a', {
    confirmed: true, clientId: client.id, ownerMemberId: 'member_b', updateOpenPeriod: false
  })
  assert.equal(context.admin.getClient('tenant_a', client.id).ownerMemberId, 'member_b')
  assert.equal(context.admin.getPeriodDetail('tenant_a', shipment.periodId).period.ownerMemberId, 'member_a')
  context.admin.updateClientOwner('tenant_a', {
    confirmed: true, clientId: client.id, ownerMemberId: 'member_c', updateOpenPeriod: true
  })
  assert.equal(context.admin.getClient('tenant_a', client.id).ownerMemberId, 'member_c')
  assert.equal(context.admin.getPeriodDetail('tenant_a', shipment.periodId).period.ownerMemberId, 'member_c')
  assert.equal(context.admin.getAuditLogs('tenant_a', client.id)[0].performedByMemberId, 'member_a')
})

test('已结清历史账期负责人快照不随客户转移或成员改名变化', () => {
  const context = setup()
  const client = createClient(context.admin, '历史快照客户')
  const shipment = ship(context.admin, client.id, context.productId, 'history-owner')
  context.admin.recordPayment('tenant_a', {
    confirmed: true, requestId: 'history-payment', clientId: client.id, periodId: shipment.periodId,
    amountYuan: '100', paymentDate: '2026-09-19', method: '银行转账'
  })
  context.admin.closeBillingPeriod('tenant_a', {
    confirmed: true, requestId: 'history-close', clientId: client.id,
    periodId: shipment.periodId, closedDate: '2026-09-19'
  })
  context.admin.updateClientOwner('tenant_a', {
    confirmed: true, clientId: client.id, ownerMemberId: 'member_b', updateOpenPeriod: true
  })
  context.admin.updateMemberDisplayName('tenant_a', {
    confirmed: true, memberId: 'member_a', displayName: '郑先生'
  })
  context.admin.updateMemberDisplayName('tenant_a', {
    confirmed: true, memberId: 'member_b', displayName: '王明'
  })
  const history = context.admin.getPeriodDetail('tenant_a', shipment.periodId).period
  assert.equal(history.ownerMemberId, 'member_a')
  assert.equal(history.ownerNameSnapshot, '郑晓拓')
  assert.equal(context.admin.listClients('tenant_a').find(item => item.id === client.id).ownerDisplayName, '王明')
  assert.equal(context.admin.getShipment('tenant_a', shipment.id).createdByNameSnapshot, '郑晓拓')
})

test('下一期重新继承届时客户负责人，不继承上一期临时负责人', () => {
  const context = setup()
  const client = createClient(context.admin, '下一期客户')
  const first = ship(context.admin, client.id, context.productId, 'next-period-1')
  context.admin.updateBillingPeriodOwner('tenant_a', { confirmed: true, periodId: first.periodId, ownerMemberId: 'member_b' })
  context.admin.recordPayment('tenant_a', { confirmed: true, requestId: 'next-pay', clientId: client.id, periodId: first.periodId, amountYuan: '100', method: '现金' })
  context.admin.closeBillingPeriod('tenant_a', { confirmed: true, requestId: 'next-close', clientId: client.id, periodId: first.periodId, closedDate: '2026-09-19' })
  context.setNow('2026-09-20T06:00:00.000Z')
  const second = ship(context.memberB, client.id, context.productId, 'next-period-2', '2026-09-20')
  const nextPeriod = context.admin.getPeriodDetail('tenant_a', second.periodId).period
  assert.equal(nextPeriod.ownerMemberId, 'member_a')
  assert.equal(second.createdByMemberId, 'member_b')
})

test('账目修正和结清审计保存真实操作成员，不采信业务记录负责人', () => {
  const context = setup()
  const client = createClient(context.admin, '审计客户')
  const shipment = ship(context.memberB, client.id, context.productId, 'audit-source')
  context.admin.updateShipment('tenant_a', shipment.id, {
    confirmed: true, reason: '数量录入有误',
    items: [{ productId: context.productId, quantityText: '20', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '10' }]
  })
  context.memberB.recordPayment('tenant_a', { confirmed: true, requestId: 'audit-pay', clientId: client.id, periodId: shipment.periodId, amountYuan: '200', method: '现金' })
  context.admin.closeBillingPeriod('tenant_a', { confirmed: true, requestId: 'audit-close', clientId: client.id, periodId: shipment.periodId, closedDate: '2026-09-19' })
  const shipmentAudit = context.admin.getAuditLogs('tenant_a', shipment.id).find(item => item.action === 'UPDATE_SHIPMENT')
  const closeAudit = context.admin.getAuditLogs('tenant_a', shipment.periodId).find(item => item.action === 'CLOSE_BILLING_PERIOD')
  assert.equal(shipmentAudit.performedByMemberId, 'member_a')
  assert.equal(closeAudit.performedByMemberId, 'member_a')
})

test('停用仍负责客户的成员必须先选择接替人，转移后历史姓名仍保留', () => {
  const context = setup()
  const client = createClient(context.memberB, '离职成员客户')
  const shipment = ship(context.memberB, client.id, context.productId, 'disabled-history')
  assert.throws(() => context.admin.setMemberStatus('tenant_a', {
    confirmed: true, memberId: 'member_b', status: 'disabled'
  }), /请先选择接替成员/)
  context.admin.setMemberStatus('tenant_a', {
    confirmed: true, memberId: 'member_b', status: 'disabled', replacementMemberId: 'member_c'
  })
  assert.equal(context.admin.getClient('tenant_a', client.id).ownerMemberId, 'member_c')
  assert.equal(context.admin.getPeriodDetail('tenant_a', shipment.periodId).period.ownerMemberId, 'member_c')
  assert.equal(context.admin.getShipment('tenant_a', shipment.id).createdByNameSnapshot, '王小明')
  assert.throws(() => context.memberB.saveClient('tenant_a', { confirmed: true, name: '停用后客户' }), /已停用/)
})

test('企业至少保留一个有效管理员且不能停用当前登录管理员', () => {
  const context = setup()
  assert.throws(() => context.admin.setMemberStatus('tenant_a', {
    confirmed: true, memberId: 'member_a', status: 'disabled'
  }), /不能停用当前登录的管理员|至少保留一个有效管理员/)
})

test('旧客户负责人不会静默迁移，只能通过管理员确认的批量动作补齐并审计', () => {
  const context = setup()
  const raw = context.storage.read()
  raw.tenants.tenant_a.clients.push({ id: 'legacy_client', tenantId: 'tenant_a', name: '旧客户', active: true })
  context.storage.write(raw)
  assert.equal(context.admin.getClient('tenant_a', 'legacy_client').ownerMemberId, undefined)
  const result = context.admin.assignUnownedClients('tenant_a', {
    confirmed: true, memberId: 'member_a', includeOpenPeriods: true
  })
  assert.equal(result.assignedCount, 1)
  assert.equal(context.admin.getClient('tenant_a', 'legacy_client').ownerMemberId, 'member_a')
  assert.equal(context.admin.getAuditLogs('tenant_a', 'legacy_client')[0].action, 'ASSIGN_LEGACY_CLIENT_OWNER')
})

test('云函数邀请与身份安全边界由真实OPENID和membership决定', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  const security = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/services/member-security.js'), 'utf8')
  assert.match(source, /crypto\.randomBytes\(24\)/)
  assert.match(source, /status: 'active', expiresAt/)
  assert.match(security, /role: 'member'/)
  assert.match(security, /status: 'active'/)
  assert.match(source, /stableId\('member', openid\)/)
  assert.match(source, /currentMembership\.tenantId !== tenantId/)
  assert.doesNotMatch(source, /event\s*\.\s*tenantId/)
  assert.doesNotMatch(source, /payload\s*\.\s*(tenantId|role|memberId)/)
})

test('无效、过期、作废和旧used状态的邀请码都被服务端规则拒绝', () => {
  const now = new Date('2026-09-19T08:00:00.000Z').getTime()
  assert.throws(() => validateInvite(null, now), /无效/)
  assert.throws(() => validateInvite({ status: 'active', expiresAt: '2026-09-19T07:59:59.000Z' }, now), /过期/)
  assert.throws(() => validateInvite({ status: 'revoked', expiresAt: '2026-09-20T08:00:00.000Z' }, now), /作废/)
  assert.throws(() => validateInvite({ status: 'used', expiresAt: '2026-09-20T08:00:00.000Z' }, now), /失效/)
  assert.equal(validateInvite({ status: 'active', expiresAt: '2026-09-20T08:00:00.000Z' }, now).status, 'active')
})

test('企业显示姓名必须明确填写且长度合法', () => {
  assert.equal(validateDisplayName(' 王小明 '), '王小明')
  assert.throws(() => validateDisplayName('王'), /2到20个字符/)
})

test('任何无membership微信用户都不会自动创建企业或管理员', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  assert.doesNotMatch(source, /ensureInitialAdmin|stableId\('tenant',\s*openid\)/)
  assert.match(source, /requireActiveMembership\(await getMembership\(context\.OPENID\)\)/)
})

test('普通成员可发起本人负责账期的结清，其它高风险操作仍由管理员权限拦截', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  assert.match(source, /requireActiveMembership/)
  const member = { role: 'member' }
  assert.doesNotThrow(() => assertMutationPermission(member, 'postShipment', []))
  assert.doesNotThrow(() => assertMutationPermission(member, 'recordPayment', []))
  assert.doesNotThrow(() => assertMutationPermission(member, 'closeBillingPeriod', []))
  assert.doesNotThrow(() => assertMutationPermission(member, 'saveClient', [{ name: '新客户' }]))
  assert.throws(() => assertMutationPermission(member, 'saveClient', [{ id: 'client_1' }]), /仅限管理员/)
  assert.doesNotThrow(() => assertMutationPermission(member, 'updateShipment', [])) // 客户归属由事务内领域校验。
})

test('成员列表快照不会向前端暴露openid，邀请token也不进入企业账本快照', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  const sanitizer = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/services/client-snapshot.js'), 'utf8')
  assert.match(source, /clientSnapshot/)
  assert.match(sanitizer, /'openid'/)
  assert.match(sanitizer, /'token'/)
  assert.match(source, /member_invites/)
})
