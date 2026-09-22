const test = require('node:test')
const assert = require('node:assert/strict')
const { canEditShipment } = require('../services/ledger-repository')
const { setup, tenantId } = require('./helpers/shipment-correction-fixture')

for (const creator of ['admin', 'creator', 'owner']) {
  for (const actor of ['admin', 'owner']) {
    test(`开放发货由 ${creator} 录入，${actor} 可以修正`, () => {
      const c = setup(creator)
      const result = c.repositories[actor].updateShipment(tenantId, c.shipment.id, c.payload())
      assert.equal(result.freightCents, 325)
      assert.equal(result.createdByMemberId, c.members[creator].id)
    })
  }
}

for (const actor of ['creator', 'other']) {
  test(`${actor} 仅为原录入人或账期负责人，不获得客户发货修正权限`, () => {
    const c = setup('creator')
    const before = c.storage.read()
    assert.throws(() => c.repositories[actor].updateShipment(tenantId, c.shipment.id, c.payload({
      clientId: 'forged-client', tenantId: 'forged', role: 'admin', memberId: c.members.owner.id,
      ownerMemberId: c.members[actor].id, canEdit: true, isOwner: true
    })), /客户当前负责人/)
    assert.deepEqual(c.storage.read(), before)
  })
}

test('客户单独转移给 B 后 A 失权、B 获权，账期负责人及发货快照不被回写', () => {
  const c = setup()
  c.repositories.owner.updateShipment(tenantId, c.shipment.id, c.payload())
  const shipmentBefore = c.repositories.admin.getShipment(tenantId, c.shipment.id)
  const periodBefore = c.repositories.admin.getPeriodDetail(tenantId, c.shipment.periodId).period
  c.repositories.admin.updateClientOwner(tenantId, {
    confirmed: true, clientId: c.client.id, ownerMemberId: c.members.creator.id, updateOpenPeriod: false
  })
  assert.deepEqual(c.repositories.admin.getShipment(tenantId, c.shipment.id), shipmentBefore)
  assert.deepEqual(c.repositories.admin.getPeriodDetail(tenantId, c.shipment.periodId).period, periodBefore)
  assert.throws(() => c.repositories.owner.updateShipment(tenantId, c.shipment.id, c.payload()), /客户当前负责人/)
  c.repositories.creator.updateShipment(tenantId, c.shipment.id, c.payload())
  c.repositories.admin.updateShipment(tenantId, c.shipment.id, c.payload())
})

for (const status of ['closed', 'settled']) {
  for (const actor of ['admin', 'owner', 'creator']) {
    test(`${status} 历史发货拒绝 ${actor} 及伪造只读路由字段`, () => {
      const c = setup('creator')
      c.change(t => { t.billingPeriods[0].status = status })
      const before = c.storage.read()
      assert.throws(() => c.repositories[actor].updateShipment(tenantId, c.shipment.id, c.payload({
        readOnly: false, historical: false, periodId: 'forged-open', canEdit: true
      })), /已结清/)
      assert.deepEqual(c.storage.read(), before)
    })
  }
}

for (const invalid of ['disabled', 'pending', 'deleted', 'foreign-tenant']) {
  test(`领域修正重新读取 ${invalid} 成员，不能使用旧 actor 权限`, () => {
    const c = setup()
    c.change(t => {
      const member = t.memberships.find(m => m.id === c.members.owner.id)
      if (invalid === 'deleted') t.memberships = t.memberships.filter(m => m.id !== member.id)
      else if (invalid === 'foreign-tenant') member.tenantId = 'tenant_b'
      else member.status = invalid
    })
    const before = c.storage.read()
    assert.throws(() => c.repositories.owner.updateShipment(tenantId, c.shipment.id, c.payload()), /成员不存在或已停用/)
    assert.deepEqual(c.storage.read(), before)
  })
}

for (const [name, corrupt] of [
  ['shipment tenant', t => { t.shipments[0].tenantId = 'tenant_b' }],
  ['client tenant', t => { t.clients[0].tenantId = 'tenant_b' }],
  ['period tenant', t => { t.billingPeriods[0].tenantId = 'tenant_b' }],
  ['period client', t => { t.billingPeriods[0].clientId = 'other-client' }],
  ['missing client', t => { t.clients = [] }],
  ['missing period', t => { t.billingPeriods = [] }],
  ['unknown period status', t => { t.billingPeriods[0].status = 'unknown' }]
]) {
  test(`资源 ${name} 异常时管理员也不能通过合成开放账期修正`, () => {
    const c = setup()
    c.change(corrupt)
    const before = c.storage.read()
    assert.throws(() => c.repositories.admin.updateShipment(tenantId, c.shipment.id, c.payload()), /不属于|归属不一致|状态异常/)
    assert.deepEqual(c.storage.read(), before)
  })
}

test('旧月份账期和缺 periodId 的旧发货按真实已存账期兼容，读取不写回', () => {
  const c = setup()
  const legacyId = `legacy_${c.client.id}_2026-09`
  c.change(t => { delete t.shipments[0].periodId; t.billingPeriods[0].id = legacyId })
  const before = c.storage.read()
  assert.equal(c.repositories.admin.getShipmentEditContext(tenantId, c.shipment.id).period.id, legacyId)
  assert.deepEqual(c.storage.read(), before)
  c.repositories.owner.updateShipment(tenantId, c.shipment.id, c.payload())
  assert.equal(c.repositories.admin.getShipment(tenantId, c.shipment.id).periodId, undefined)
  c.change(t => { t.billingPeriods[0].status = 'closed' })
  assert.throws(() => c.repositories.admin.updateShipment(tenantId, c.shipment.id, c.payload()), /已结清/)
})

test('负责人修正重算商品、运费、账期与余额，并保留完整前后审计和实际操作人', () => {
  const c = setup('creator')
  c.repositories.other.recordPayment(tenantId, {
    confirmed: true, clientId: c.client.id, periodId: c.shipment.periodId, requestId: 'payment', amountYuan: '50'
  })
  const old = c.repositories.admin.getShipment(tenantId, c.shipment.id)
  const result = c.repositories.owner.updateShipment(tenantId, c.shipment.id, c.payload({
    items: [Object.assign({}, c.item, { quantityText: '12.5', unitPriceYuan: '8.88', lineAmountCents: 1 })],
    itemsSubtotalCents: 1, totalAmountCents: 1, operator: 'admin', performedByMemberId: c.members.admin.id
  }))
  assert.equal(result.itemsSubtotalCents, 11100)
  assert.equal(result.lines[0].lineAmountCents, 11100)
  assert.equal(result.freightCents, 325)
  assert.equal(result.totalAmountCents, 11425)
  const period = c.storage.read().tenants[tenantId].billingPeriods[0]
  assert.equal(period.totalAmountCents, 11425)
  assert.equal(period.receivedAmountCents, 5000)
  assert.equal(period.outstandingAmountCents, 6425)
  const audit = c.repositories.admin.getAuditLogs(tenantId, c.shipment.id).find(log => log.action === 'UPDATE_SHIPMENT')
  assert.deepEqual(audit.before, old)
  assert.deepEqual(audit.after, result)
  assert.equal(audit.reason, '核对数量修正')
  assert.equal(audit.performedByMemberId, c.members.owner.id)
  assert.equal(audit.performedByNameSnapshot, c.members.owner.displayName)
  assert.equal(result.createdByMemberId, c.members.creator.id)
})

test('原因、人工确认、已收款约束和非法运费继续拒绝，失败零写入', () => {
  const c = setup()
  c.repositories.other.recordPayment(tenantId, {
    confirmed: true, clientId: c.client.id, periodId: c.shipment.periodId, requestId: 'payment', amountYuan: '100'
  })
  for (const [extra, expected] of [
    [{ reason: ' ' }, /修正原因/], [{ confirmed: false }, /人工确认/],
    [{ items: [Object.assign({}, c.item, { quantityText: '1' })] }, /不能低于已收/],
    [{ freightYuan: '-1' }, /运费/], [{ freightYuan: '1.111' }, /运费/]
  ]) {
    const before = c.storage.read()
    assert.throws(() => c.repositories.owner.updateShipment(tenantId, c.shipment.id, c.payload(extra)), expected)
    assert.deepEqual(c.storage.read(), before)
  }
})

test('负责人修正不能顺带保存默认客户价；管理员仍可按原流程保存', () => {
  const c = setup()
  const payload = c.payload({ items: [Object.assign({}, c.item, { saveAsDefault: true })] })
  const before = c.storage.read()
  assert.throws(() => c.repositories.owner.updateShipment(tenantId, c.shipment.id, payload), /默认价格仅限管理员/)
  assert.deepEqual(c.storage.read(), before)
  c.repositories.admin.updateShipment(tenantId, c.shipment.id, payload)
  assert.equal(c.storage.read().tenants[tenantId].customerPrices.length, 1)
})

test('权限提示 helper 严格区分 active、当前客户负责人和开放账期', () => {
  const client = { ownerMemberId: 'owner' }
  const period = { status: 'open', ownerMemberId: 'other' }
  for (const [identity, expected] of [
    [{ memberId: 'owner', role: 'member', status: 'active' }, true],
    [{ memberId: 'other', role: 'member', status: 'active' }, false],
    [{ id: 'admin', role: 'admin', status: 'active' }, true],
    [{ id: 'admin', role: 'admin', status: 'disabled' }, false],
    [{ id: 'owner', role: 'member' }, false]
  ]) assert.equal(canEditShipment(identity, client, period), expected)
  assert.equal(canEditShipment({ role: 'admin', status: 'active' }, client, null), false)
})
