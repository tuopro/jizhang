const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudHarness } = require('./helpers/cloud-ledger-harness')
const { tenantId, copy, setup } = require('./helpers/shipment-correction-fixture')
const { parseOrderText } = require('../services/order-parser')

function harness(actor = 'owner') {
  const h = cloudHarness('creator')
  h.openid = h.c.members[actor].openid
  h.change(t => {
    t.clients.push({ id: 'unrelated', tenantId, name: '其他客户', ownerMemberId: h.c.members.admin.id })
    t.billingPeriods.push({ id: 'historical', tenantId, clientId: h.c.client.id, status: 'settled', ownerMemberId: h.c.members.creator.id })
  })
  h.create = extra => h.main({ action: 'createCustomProduct', role: 'admin', tenantId: 'forged', payload: {
    role: 'admin', memberId: h.c.members.admin.id, args: [Object.assign({
      confirmed: true, clientId: h.c.client.id,
      ...parseOrderText('银灰色细齿底槽4025 100米').items[0].customProductDraft
    }, extra)]
  } })
  h.action = (action, args) => h.main({ action, role: 'admin', payload: { args } })
  return h
}

async function denied(h, operation, pattern = /负责人|业务客户|不存在|不属于|已失效|停用|尚未加入|无法取得|仅限管理员/) {
  const before = h.read()
  const response = await operation()
  assert.equal(response.ok, false, JSON.stringify(response))
  assert.match(response.error, pattern)
  assert.deepEqual(h.read(), before, 'denial must not write any entity')
}

for (const actor of ['admin', 'owner', 'other']) {
  test(`${actor} 创建 tenant 共享底槽并立即发货，真实成员审计，历史和价格不变`, async () => {
    const h = harness(actor)
    // A legacy snapshot missing derived fields must not be silently upgraded by creation.
    h.change(t => { delete t.shipments[0].freightCents; delete t.shipments[0].itemsSubtotalCents })
    const before = h.read().tenants[tenantId]
    const response = await h.create()
    assert.equal(response.ok, true, response.error)
    const product = response.result
    assert.equal(product.tenantId, tenantId)
    assert.deepEqual(product.specialTags, ['底槽'])
    for (const field of ['clientId', 'ownerMemberId', 'periodOwnerMemberId', 'createdForClientId']) assert.equal(Object.hasOwn(product, field), false)
    const after = h.read().tenants[tenantId]
    const audit = after.auditLogs.at(-1)
    assert.equal(audit.action, 'CREATE_CUSTOM_PRODUCT')
    assert.equal(audit.performedByMemberId, h.c.members[actor].id)
    assert.equal(audit.performedByNameSnapshot, h.c.members[actor].displayName)
    assert.deepEqual(audit.after, product)
    assert.ok(Number.isFinite(Date.parse(audit.createdAt)))
    for (const field of Object.keys(before).filter(key => !['customProducts', 'auditLogs'].includes(key))) assert.deepEqual(after[field], before[field], field)
    assert.equal(h.security.length, 1)
    assert.equal(h.security[0].openid, h.c.members[actor].openid)
    assert.match(h.security[0].content, /底槽/)
    const input = { confirmed: true, clientId: h.c.client.id, requestId: 'use-created', items: [{ productId: product.id, quantityText: '100', orderUnit: '米', pricingUnit: '米' }] }
    await denied(h, () => h.action('postShipment', [input]), /价格|单价/)
    input.items[0].unitPriceYuan = '2.50'
    const posted = await h.action('postShipment', [input])
    assert.equal(posted.ok, true, posted.error)
    assert.equal(posted.result.lines[0].productId, product.id)
    assert.deepEqual(posted.result.lines[0].productSnapshot.specialTags, ['底槽'])
    assert.equal(posted.result.totalAmountCents, 25000)
    assert.deepEqual(h.read().tenants[tenantId].customerPrices, before.customerPrices)
    // An unrelated member can reuse the shared product without creation authority.
    h.openid = h.c.members.creator.openid
    const boot = await h.action('bootstrap', [])
    assert.ok(boot.snapshot.customProducts.some(p => p.id === product.id))
    assert.equal(parseOrderText('4025 银灰色 细齿 底槽 100米', { customProducts: boot.snapshot.customProducts }).items[0].productId, product.id)
  })
}

test('admin 保留没有业务客户的全局创建能力', async () => {
  const h = harness('admin')
  assert.equal((await h.create({ clientId: undefined })).ok, true)
  assert.equal((await h.create({ name: '管理员新规格', clientId: 'invalid' })).ok, true)
})

for (const state of ['unrelated', 'settled', 'closed', 'other-client-owner', 'other-client-period-owner', 'other-tenant-period', 'ambiguous', 'no-open']) {
  test(`${state} 不能获得客户范围创建权限`, async () => {
    const h = harness(state === 'settled' || state === 'closed' || state === 'unrelated' ? 'creator' : 'other')
    h.change(t => {
      if (state === 'closed') t.billingPeriods.find(p => p.id === 'historical').status = 'closed'
      if (state === 'other-client-owner') {
        t.clients[1].ownerMemberId = h.c.members.other.id
        t.billingPeriods[0].ownerMemberId = h.c.members.admin.id
      }
      if (state === 'other-client-period-owner') t.billingPeriods[0].clientId = 'unrelated'
      if (state === 'other-tenant-period') t.billingPeriods[0].tenantId = 'foreign'
      if (state === 'ambiguous') t.billingPeriods.push({ ...t.billingPeriods[0], id: 'second-open' })
      if (state === 'no-open') t.billingPeriods = []
    })
    await denied(h, () => h.create())
  })
}
for (const actor of ['admin', 'owner']) {
  for (const state of ['no-open', 'ambiguous']) {
    test(`${actor} 在 ${state} 下保留自身创建权限`, async () => {
      const h = harness(actor)
      h.change(t => {
        if (state === 'no-open') t.billingPeriods = []
        else t.billingPeriods.push({ ...t.billingPeriods[0], id: 'second-open' })
      })
      assert.equal((await h.create()).ok, true)
    })
  }
}
for (const clientId of [undefined, '', 'nonexistent', 'unrelated', 'foreign-client']) {
  test(`member 的 clientId=${clientId} 不授予创建权限`, async () => {
    const h = harness()
    h.change((t, root) => {
      root.tenants.foreign = { enterprise: { id: 'foreign' }, clients: [{ id: 'foreign-client', tenantId: 'foreign', ownerMemberId: h.c.members.owner.id }] }
    })
    await denied(h, () => h.create({ clientId }))
  })
}
for (const field of ['role', 'memberId', 'ownerMemberId', 'periodOwnerMemberId', 'tenantId', 'periodId', 'canCreateCustomProduct', 'isAdmin']) {
  test(`伪造 ${field} 不能授权 createCustomProduct`, async () => {
    const h = harness('creator')
    const value = { role: 'admin', memberId: h.c.members.admin.id, ownerMemberId: h.c.members.creator.id, periodOwnerMemberId: h.c.members.creator.id, tenantId, periodId: h.c.shipment.periodId, canCreateCustomProduct: true, isAdmin: true }[field]
    await denied(h, () => h.create({ [field]: value }))
  })
}
for (const state of ['disabled', 'deleted', 'stranger', 'missing-openid', 'pending']) {
  test(`${state} 不能创建`, async () => {
    const h = harness()
    if (state === 'stranger' || state === 'missing-openid') h.openid = state === 'stranger' ? 'unknown-openid' : ''
    else h.change(t => {
      if (state === 'deleted') t.memberships = t.memberships.filter(m => m.id !== h.c.members.owner.id)
      else t.memberships.find(m => m.id === h.c.members.owner.id).status = state
    })
    await denied(h, () => h.create({ role: 'admin', isAdmin: true }))
  })
}

for (const mode of ['client-transfer', 'period-transfer', 'close-and-next']) {
  test(`${mode} 旧负责人即时失权、新负责人即时获权`, async () => {
    const h = harness(mode === 'client-transfer' ? 'owner' : 'other')
    assert.equal((await h.create()).ok, true)
    h.change(t => {
      if (mode === 'client-transfer') t.clients[0].ownerMemberId = h.c.members.creator.id
      else if (mode === 'period-transfer') t.billingPeriods[0].ownerMemberId = h.c.members.creator.id
      else {
        t.billingPeriods[0].status = 'settled'
        t.billingPeriods.push({ id: 'next-open', tenantId, clientId: h.c.client.id, status: 'open', ownerMemberId: h.c.members.creator.id })
      }
    })
    await denied(h, () => h.create({ name: '新规格底槽' }))
    h.openid = h.c.members.creator.openid
    assert.equal((await h.create({ name: '新规格底槽' })).ok, true)
  })
}
for (const remaining of ['client', 'period']) {
  test(`失去一种负责人身份但仍是 ${remaining} owner 时可创建`, async () => {
    const h = harness()
    h.change(t => {
      t.billingPeriods[0].ownerMemberId = h.c.members.owner.id
      if (remaining === 'client') t.billingPeriods[0].ownerMemberId = h.c.members.creator.id
      else t.clients[0].ownerMemberId = h.c.members.creator.id
    })
    assert.equal((await h.create()).ok, true)
  })
}
for (const hook of ['beforeTransaction', 'beforeCommit']) {
  for (const mode of ['client-transfer', 'period-transfer', 'period-closed', 'multiple-open', 'disabled', 'deleted', 'tenant-changed']) {
    test(`${hook} ${mode} 时事务重读/冲突重试拒绝保存`, async () => {
      const h = harness(mode.startsWith('period') || mode === 'multiple-open' ? 'other' : 'owner')
      let changed
      h[hook] = () => {
        h.change(t => {
          if (mode === 'client-transfer') t.clients[0].ownerMemberId = h.c.members.creator.id
          else if (mode === 'period-transfer') t.billingPeriods[0].ownerMemberId = h.c.members.creator.id
          else if (mode === 'period-closed') t.billingPeriods[0].status = 'settled'
          else if (mode === 'multiple-open') t.billingPeriods.push({ ...t.billingPeriods[0], id: 'duplicate' })
          else if (mode === 'disabled') t.memberships.find(m => m.id === h.c.members.owner.id).status = 'disabled'
          else if (mode === 'tenant-changed') t.memberships.find(m => m.id === h.c.members.owner.id).tenantId = 'foreign'
          else t.memberships = t.memberships.filter(m => m.id !== h.c.members.owner.id)
        })
        changed = h.read()
      }
      const result = await h.create({ canCreateCustomProduct: true })
      assert.equal(result.ok, false, JSON.stringify(result))
      assert.deepEqual(h.read(), changed)
      assert.equal(h.commits, 0)
      if (hook === 'beforeCommit') assert.equal(h.attempts, 2)
    })
  }
}

for (const actor of ['owner', 'other']) {
  test(`${actor} 创建成功也不能通过任何全局产品写 action 修改属性或停启用`, async () => {
    const h = harness(actor)
    const product = (await h.create()).result
    for (const patch of [{ name: '重命名' }, { aliases: ['恶意别名'] }, { recognitionKeywords: ['关键词'] }, { specialTags: ['定制'] }, { unitLengthMeters: 9 }, { height: 80, width: 50 }, { color: '白色', toothType: '粗齿' }]) {
      await denied(h, () => h.action('updateCustomProduct', [{ ...product, confirmed: true, ...patch }]))
    }
    for (const active of [false, true]) {
      await denied(h, () => h.action('setCustomProductActive', [product.id, active]))
      await denied(h, () => h.action('setProductActive', [product.id, active]))
      await denied(h, () => h.action('setProductActive', [h.c.item.productId, active]))
    }
  })
  test(`${actor} 重复 create 不得补写已有产品任何字段`, async () => {
    const h = harness('admin')
    const product = (await h.create({ name: '自定义原产品', specialTags: [], height: null, width: null, color: null, toothType: null })).result
    h.openid = h.c.members[actor].openid
    const before = h.read()
    const result = await h.create({ name: product.name, aliases: ['注入别名'], recognitionKeywords: ['注入关键词'], specialTags: ['定制'], height: 99, width: 88, color: '蓝色', toothType: '封口', unitLengthMeters: 1.3, lengthDescription: '新长度', note: '新备注' })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.result, product)
    assert.deepEqual(h.read(), before)
  })
}
test('admin 原重命名、别名、停启用能力不变', async () => {
  const h = harness('admin')
  const product = (await h.create()).result
  const updated = await h.action('updateCustomProduct', [{ ...product, confirmed: true, name: '底槽新名称', aliases: ['底槽新别名'] }])
  assert.equal(updated.ok, true, updated.error)
  for (const active of [false, true]) {
    assert.equal((await h.action('setCustomProductActive', [product.id, active])).result.active, active)
    assert.equal((await h.action('setProductActive', [h.c.item.productId, active])).result.active, active)
  }
})
test('member 创建必须人工确认，msgSecCheck 拒绝时所有写入和审计回滚', async () => {
  const h = harness()
  await denied(h, () => h.create({ confirmed: false }), /人工确认/)
  h.rejectText = true
  await denied(h, () => h.create({ name: '底槽自定义文本', note: '测试备注', aliases: ['别名内容'], recognitionKeywords: ['识别内容'] }), /内容/)
  assert.equal(h.security.length, 1)
  for (const text of ['底槽自定义文本', '测试备注', '别名内容', '识别内容']) assert.ok(h.security[0].content.includes(text))
})
test('超过快照上限的客户、成员、开放账期仍通过事务定向读取授权', async () => {
  const h = harness('other')
  h.change(t => {
    t.clients.unshift(...Array.from({ length: 1001 }, (_, i) => ({ id: `client-pad-${i}`, tenantId })))
    t.memberships.unshift(...Array.from({ length: 1001 }, (_, i) => ({ id: `member-pad-${i}`, tenantId, status: 'active' })))
    t.billingPeriods.unshift(...Array.from({ length: 1001 }, (_, i) => ({ id: `period-pad-${i}`, tenantId, clientId: 'unrelated', status: 'settled' })))
  })
  assert.equal((await h.create()).ok, true)
  assert.ok(h.queries.some(q => q.scope.startsWith('transaction') && q.name === 'clients' && q.id === h.c.client.id))
  assert.ok(h.queries.some(q => q.scope.startsWith('transaction') && q.name === 'billing_periods' && q.criteria.clientId === h.c.client.id && q.criteria.status === 'open'))
  h.change(t => t.billingPeriods.push({ id: 'second-open', tenantId, clientId: h.c.client.id, status: 'open', ownerMemberId: h.c.members.other.id }))
  await denied(h, () => h.create({ name: '新底槽' }))
})
test('领域服务独立重读真实 membership，不信任缓存 admin、已删除或停用成员', () => {
  const c = setup()
  const input = { confirmed: true, clientId: c.client.id, name: '领域底槽' }
  assert.equal(c.repositories.owner.getCustomProductCreateAccess(tenantId, c.client.id), true)
  c.change(t => { t.clients[0].ownerMemberId = c.members.creator.id })
  assert.throws(() => c.repositories.owner.createCustomProduct(tenantId, input), /负责人/)
  c.change(t => { t.memberships = t.memberships.filter(m => m.id !== c.members.owner.id) })
  assert.throws(() => c.repositories.owner.createCustomProduct(tenantId, input), /不存在|停用/)
  const before = c.storage.read()
  assert.equal(c.repositories.owner.getCustomProductCreateAccess(tenantId, c.client.id), false)
  assert.deepEqual(c.storage.read(), before)
})
