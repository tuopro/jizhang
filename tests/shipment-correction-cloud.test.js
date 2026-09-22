const test = require('node:test')
const assert = require('node:assert/strict')
const { copy, tenantId } = require('./helpers/shipment-correction-fixture')

const { cloudHarness } = require('./helpers/cloud-ledger-harness')

async function denied(h, extra, expected, id) {
  const before = h.read()
  const response = await h.save(extra, id)
  assert.equal(response.ok, false, JSON.stringify(response))
  assert.match(response.error, expected)
  assert.deepEqual(h.read(), before, 'rejection must preserve data and audit')
  assert.equal(h.commits, 0)
}

for (const actor of ['admin', 'owner']) {
  test(`真实 OPENID 的 ${actor} 可修正他人录入，前端伪造身份不会影响审计`, async () => {
    const h = cloudHarness('creator')
    h.openid = h.c.members[actor].openid
    const before = h.read().tenants[tenantId]
    const response = await h.save({
      tenantId: 'tenant_b', memberId: 'forged-member', role: 'admin', ownerMemberId: 'forged-owner',
      clientId: 'forged-client', periodId: 'forged-period', performedByMemberId: 'forged-operator',
      canEdit: true, isOwner: true, readOnly: false, historical: false,
      itemsSubtotalCents: 1, totalAmountCents: 1,
      items: [Object.assign({}, h.c.item, { quantityText: '20', lineAmountCents: 1 })]
    })
    assert.equal(response.ok, true, response.error)
    const after = h.read().tenants[tenantId]
    assert.equal(after.shipments[0].itemsSubtotalCents, 20000)
    assert.equal(after.shipments[0].totalAmountCents, 20325)
    assert.equal(after.billingPeriods[0].totalAmountCents, 20325)
    assert.equal(after.shipments[0].clientId, h.c.client.id)
    assert.equal(after.shipments[0].periodId, h.c.shipment.periodId)
    const audit = after.auditLogs.find(log => log.action === 'UPDATE_SHIPMENT')
    assert.equal(audit.performedByMemberId, h.c.members[actor].id)
    assert.deepEqual(audit.before, before.shipments[0])
    assert.deepEqual(audit.after, after.shipments[0])
    assert.deepEqual(after.customerPrices, before.customerPrices)
    assert.ok(h.security.some(request => request.openid === h.openid))
    for (const name of ['memberships', 'shipments', 'clients', 'billing_periods']) {
      assert.ok(h.queries.some(q => q.scope === 'transaction-1' && q.name === name && q.criteria?.tenantId === tenantId))
    }
    assert.ok(h.queries.some(q => q.scope === 'outside' && q.name === 'memberships'))
    assert.equal(h.commits, 1)
  })
}

test('非负责人不能伪造另一个自己负责的 clientId 借权修正', async () => {
  const h = cloudHarness('creator')
  h.openid = h.c.members.creator.openid
  h.change(t => { t.clients.push(Object.assign({}, t.clients[0], { id: 'my-client', ownerMemberId: h.c.members.creator.id })) })
  await denied(h, {
    clientId: 'my-client', memberId: h.c.members.owner.id, role: 'admin',
    ownerMemberId: h.c.members.creator.id, canEdit: true, isOwner: true
  }, /客户当前负责人/)
})

test('异常或缺失的真实成员 role 不能回退成管理员', async () => {
  for (const role of ['', 'unknown']) {
    const h = cloudHarness()
    h.change(t => { t.memberships.find(m => m.id === h.c.members.owner.id).role = role })
    await denied(h, { role: 'admin' }, /客户当前负责人/)
  }
})

test('云端对实际客户与账期关系做校验，不能借合成开放账期授权', async () => {
  for (const invalid of ['mismatch', 'missing', 'unknown-status']) {
    const h = cloudHarness()
    h.openid = h.c.members.admin.openid
    h.change(t => {
      if (invalid === 'mismatch') t.billingPeriods[0].clientId = 'different-client'
      if (invalid === 'missing') t.billingPeriods = []
      if (invalid === 'unknown-status') t.billingPeriods[0].status = 'unknown'
    })
    await denied(h, { clientId: h.c.client.id, readOnly: false }, /归属不一致|状态异常/)
  }
})

for (const actor of ['admin', 'owner', 'creator']) {
  for (const status of ['settled', 'closed']) {
    test(`云端 ${status} 账期拒绝 ${actor} 的强制保存`, async () => {
      const h = cloudHarness('creator')
      h.openid = h.c.members[actor].openid
      h.change(t => { t.billingPeriods[0].status = status })
      await denied(h, { readOnly: false, historical: false, canEdit: true }, /已结清/)
    })
  }
}

for (const state of ['disabled', 'deleted', 'unknown', 'no-openid']) {
  test(`云端 ${state} 微信成员拒绝 shipment 修正`, async () => {
    const h = cloudHarness()
    if (state === 'disabled') h.change(t => { t.memberships.find(m => m.id === h.c.members.owner.id).status = 'disabled' })
    if (state === 'deleted') h.change(t => { t.memberships = t.memberships.filter(m => m.id !== h.c.members.owner.id) })
    if (state === 'unknown') h.openid = 'stranger'
    if (state === 'no-openid') h.openid = ''
    await denied(h, { role: 'admin' }, /停用|尚未加入|无法取得/)
    assert.equal(h.attempts, 0)
  })
}

for (const [name, change] of [
  ['owner 转移', (t, h) => { t.clients[0].ownerMemberId = h.c.members.creator.id }],
  ['账期结清', t => { t.billingPeriods[0].status = 'settled' }],
  ['成员停用', (t, h) => { t.memberships.find(m => m.id === h.c.members.owner.id).status = 'disabled' }],
  ['成员删除', (t, h) => { t.memberships = t.memberships.filter(m => m.id !== h.c.members.owner.id) }],
  ['成员企业变化', (t, h) => { t.memberships.find(m => m.id === h.c.members.owner.id).tenantId = 'tenant_b' }]
]) {
  test(`页面打开及入口身份校验之后发生 ${name}，最终事务拒绝旧权限`, async () => {
    const h = cloudHarness()
    const opened = await h.main({ action: 'bootstrap' })
    assert.equal(opened.ok, true)
    let expected
    h.beforeTransaction = () => { h.change(t => change(t, h)); expected = h.read() }
    const response = await h.save()
    assert.equal(response.ok, false)
    assert.match(response.error, /客户当前负责人|已结清|停用|尚未加入|身份已失效/)
    assert.deepEqual(h.read(), expected)
    assert.equal(h.commits, 0)
  })
}

for (const transition of ['owner', 'settled']) {
  test(`事务读取后并发 ${transition} 导致数据库冲突重试，重试继续检查权限`, async () => {
    const h = cloudHarness()
    let expected
    h.beforeCommit = () => {
      h.change(t => {
        if (transition === 'owner') t.clients[0].ownerMemberId = h.c.members.creator.id
        else t.billingPeriods[0].status = 'settled'
      })
      expected = h.read()
    }
    const response = await h.save()
    assert.equal(response.ok, false)
    assert.match(response.error, /客户当前负责人|已结清/)
    assert.deepEqual(h.read(), expected)
    assert.equal(h.attempts, 2)
    assert.equal(h.commits, 0)
  })
}

test('云端客户转移后 B 立即获权，原 A 不能再保存', async () => {
  const h = cloudHarness()
  h.change(t => { t.clients[0].ownerMemberId = h.c.members.creator.id })
  await denied(h, {}, /客户当前负责人/)
  h.openid = h.c.members.creator.openid
  assert.equal((await h.save()).ok, true)
})

test('跨 tenant shipment、client 与 period 查询不能绕过服务端租户过滤', async () => {
  for (const field of ['shipments', 'clients', 'billingPeriods']) {
    const h = cloudHarness()
    h.change((t, root) => {
      root.tenants.tenant_b = { enterprise: { id: 'tenant_b' }, [field]: [Object.assign({}, t[field][0], { tenantId: 'tenant_b' })] }
      t[field] = []
    })
    await denied(h, { tenantId: 'tenant_b' }, /不属于|归属不一致/)
  }
})

test('member 即使是客户负责人也不能借修正写入默认价，msgSecCheck 拒绝会整体回滚', async () => {
  const h = cloudHarness()
  await denied(h, { items: [Object.assign({}, h.c.item, { saveAsDefault: true })] }, /默认价格仅限管理员/)
  h.rejectText = true
  await denied(h, { note: '需要审核的备注' }, /内容|调整|安全/)
  assert.ok(h.security.length > 0)
})

test('云端修正保留确认、原因和已收款约束', async () => {
  const h = cloudHarness()
  h.change(t => { t.payments.push({ id: 'payment', tenantId, clientId: h.c.client.id, periodId: h.c.shipment.periodId, amountCents: 10000, status: 'posted' }) })
  await denied(h, { reason: '' }, /修正原因/)
  await denied(h, { confirmed: false }, /人工确认/)
  await denied(h, { items: [Object.assign({}, h.c.item, { quantityText: '1' })] }, /不能低于已收/)
})

test('客户负责人和账期负责人结清权限仍独立，其它管理员 action 仍拒绝 member', async () => {
  const h = cloudHarness()
  for (const action of ['updateCustomProduct', 'setCustomProductActive', 'setProductActive', 'updateEnterprise', 'updateClientOwner', 'updateBillingPeriodOwner', 'updateMemberDisplayName', 'setMemberStatus', 'assignUnownedClients']) {
    const before = h.read()
    const response = await h.main({ action, payload: { args: [{ confirmed: true }] } })
    assert.equal(response.ok, false, action)
    assert.match(response.error, /仅限管理员/)
    assert.deepEqual(h.read(), before)
  }
  h.change(t => { t.payments.push({ id: 'payment', tenantId, clientId: h.c.client.id, periodId: h.c.shipment.periodId, amountCents: 10250, status: 'posted' }) })
  const request = { action: 'closeBillingPeriod', payload: { args: [{ confirmed: true, clientId: h.c.client.id, periodId: h.c.shipment.periodId, closedDate: '2026-09-21' }] } }
  assert.match((await h.main(request)).error, /账期负责人或管理员/)
  h.openid = h.c.members.other.openid
  const closed = await h.main(request)
  assert.equal(closed.ok, true, closed.error)
  assert.equal(h.read().tenants[tenantId].billingPeriods[0].status, 'settled')
})
