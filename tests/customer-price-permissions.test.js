const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { cloudHarness } = require('./helpers/cloud-ledger-harness')
const { tenantId, copy, setup } = require('./helpers/shipment-correction-fixture')
const { createLedgerRepository } = require('../services/ledger-repository')
const { createMemoryStorage } = require('../services/storage')
const { buildProductId } = require('../data/product-specs')
const product2 = buildProductId(60, 40, '细齿', '白色')

function priceHarness(actor = 'owner') {
  const h = cloudHarness('creator')
  h.openid = h.c.members[actor].openid
  h.change(t => {
    t.clients.push({ id: 'unrelated', tenantId, name: '其他客户', ownerMemberId: h.c.members.admin.id, active: true })
    t.customerPrices.push(
      { id: 'price_owned', tenantId, clientId: h.c.client.id, productId: h.c.item.productId, unit: '米', unitPriceCents: 1000, active: true },
      { id: 'price_unrelated', tenantId, clientId: 'unrelated', productId: h.c.item.productId, unit: '米', unitPriceCents: 8800, active: true }
    )
    t.billingPeriods.push({ id: 'history', tenantId, clientId: h.c.client.id, status: 'settled', ownerMemberId: h.c.members.creator.id, startAt: '2026-08-01' })
    t.auditLogs.push({ id: 'price_audit_other', entityType: 'customer_price', clientId: 'unrelated', after: copy(t.customerPrices[1]) })
  })
  h.prices = (action = 'listCustomerPrices', clientId = h.c.client.id) => h.main({
    action, tenantId: 'forged', role: 'admin', canManagePrices: true,
    payload: { role: 'admin', memberId: h.c.members.admin.id, args: [clientId, h.c.item.productId, '米'] }
  })
  h.priceSave = extra => h.main({ action: 'saveCustomerPrice', tenantId: 'forged', role: 'admin', payload: {
    memberId: h.c.members.admin.id, role: 'admin', args: [Object.assign({
      confirmed: true, id: 'price_owned', clientId: h.c.client.id, productId: h.c.item.productId, unit: '米', unitPriceCents: 2500,
      tenantId: 'forged', memberId: h.c.members.admin.id, role: 'admin', ownerMemberId: h.c.members.owner.id,
      periodOwnerMemberId: h.c.members.other.id, canManagePrices: true
    }, extra)]
  } })
  return h
}
async function rejectUnchanged(h, operation, pattern = /无权|不存在|停用|尚未加入|无法取得|不属于|不一致/) {
  const before = h.read()
  const response = await operation()
  assert.equal(response.ok, false, JSON.stringify(response))
  assert.match(response.error, pattern)
  assert.deepEqual(h.read(), before)
  return response
}

for (const actor of ['admin', 'owner', 'other']) {
  for (const action of ['listCustomerPrices', 'getCustomerPrice', 'getCustomerPriceForProduct']) {
    test(`${actor} 可通过真实云函数 ${action} 读取负责客户价格`, async () => {
      const h = priceHarness(actor)
      const result = await h.prices(action)
      assert.equal(result.ok, true, result.error)
      assert.equal((Array.isArray(result.result) ? result.result[0] : result.result).unitPriceCents, 1000)
    })
  }
  test(`${actor} 新增和修改价格，完整审计记录真实成员；其它实体逐字节不变`, async () => {
    const h = priceHarness(actor)
    const before = h.read().tenants[tenantId]
    const result = await h.priceSave()
    assert.equal(result.ok, true, result.error)
    const after = h.read().tenants[tenantId]
    const audit = after.auditLogs.at(-1)
    assert.equal(audit.action, 'UPDATE_CUSTOMER_PRICE')
    assert.deepEqual(audit.before, before.customerPrices[0])
    assert.deepEqual(audit.after, after.customerPrices[0])
    assert.equal(audit.performedByMemberId, h.c.members[actor].id)
    assert.equal(audit.performedByNameSnapshot, h.c.members[actor].displayName)
    assert.ok(Number.isFinite(Date.parse(audit.createdAt)))
    for (const key of Object.keys(before).filter(key => !['auditLogs', 'customerPrices'].includes(key))) assert.deepEqual(after[key], before[key], key)
    const created = await h.priceSave({ id: undefined, productId: product2 })
    assert.equal(created.ok, true, created.error)
    assert.equal(created.result.productId, product2)
    const creationAudit = h.read().tenants[tenantId].auditLogs.at(-1)
    assert.equal(creationAudit.action, 'CREATE_CUSTOMER_PRICE')
    assert.equal(creationAudit.performedByMemberId, h.c.members[actor].id)
    assert.equal(creationAudit.after.unitPriceCents, 2500)
  })
}
test('admin 可以读取和修改其他客户；client owner 不能管理其他客户', async () => {
  const h = priceHarness('admin')
  assert.equal((await h.prices('listCustomerPrices', 'unrelated')).ok, true)
  assert.equal((await h.priceSave({ id: 'price_unrelated', clientId: 'unrelated' })).ok, true)
  h.openid = h.c.members.owner.openid
  await rejectUnchanged(h, () => h.prices('listCustomerPrices', 'unrelated'))
  await rejectUnchanged(h, () => h.priceSave({ id: 'price_unrelated', clientId: 'unrelated' }))
  await rejectUnchanged(h, () => h.priceSave({ id: undefined, clientId: 'unrelated', productId: product2 }))
})
for (const action of ['listCustomerPrices', 'getCustomerPrice', 'getCustomerPriceForProduct', 'saveCustomerPrice']) {
  test(`仅历史 settled 账期负责人不能 ${action}，伪造身份和权限字段无效`, async () => {
    const h = priceHarness('creator')
    await rejectUnchanged(h, () => action === 'saveCustomerPrice' ? h.priceSave() : h.prices(action))
  })
}
for (const state of ['settled', 'closed', 'missing', 'foreign-client', 'foreign-tenant', 'ambiguous']) {
  test(`账期 ${state} 不授予价格权限；只认当前真实开放账期`, async () => {
    const h = priceHarness('other')
    h.change(t => {
      if (state === 'missing') t.billingPeriods = t.billingPeriods.filter(p => p.id !== h.c.shipment.periodId)
      else if (state === 'foreign-client') t.billingPeriods[0].clientId = 'unrelated'
      else if (state === 'foreign-tenant') t.billingPeriods[0].tenantId = 'tenant_b'
      else if (state === 'ambiguous') t.billingPeriods.push(Object.assign({}, t.billingPeriods[0], { id: 'duplicate-open' }))
      else t.billingPeriods[0].status = state
    })
    await rejectUnchanged(h, () => h.prices())
    await rejectUnchanged(h, () => h.priceSave())
    h.openid = h.c.members.owner.openid
    assert.equal((await h.priceSave()).ok, true, 'client owner does not require a period')
  })
}
test('客户负责人 A 转给 D：A 即时失权、D 即时获权，真实保存重新校验', async () => {
  const h = priceHarness()
  assert.equal((await h.prices()).ok, true)
  h.change(t => { t.clients[0].ownerMemberId = h.c.members.creator.id })
  await rejectUnchanged(h, () => h.priceSave())
  await rejectUnchanged(h, () => h.prices())
  h.openid = h.c.members.creator.openid
  assert.equal((await h.prices()).ok, true)
  assert.equal((await h.priceSave()).ok, true)
})
test('客户负责人转出后仍是当前账期负责人，可以继续管理价格', async () => {
  const h = priceHarness()
  h.change(t => { t.clients[0].ownerMemberId = h.c.members.creator.id; t.billingPeriods[0].ownerMemberId = h.c.members.owner.id })
  assert.equal((await h.prices()).ok, true)
  assert.equal((await h.priceSave()).ok, true)
})
for (const mode of ['transfer', 'close-and-next']) {
  test(`开放账期 ${mode} 后旧负责人失权、新负责人获权`, async () => {
    const h = priceHarness('other')
    assert.equal((await h.prices()).ok, true)
    h.change(t => {
      if (mode === 'transfer') t.billingPeriods[0].ownerMemberId = h.c.members.creator.id
      else {
        t.billingPeriods[0].status = 'settled'
        t.billingPeriods.push({ id: 'next', tenantId, clientId: h.c.client.id, status: 'open', ownerMemberId: h.c.members.creator.id })
      }
    })
    await rejectUnchanged(h, () => h.priceSave())
    h.openid = h.c.members.creator.openid
    assert.equal((await h.priceSave()).ok, true)
  })
}
for (const hook of ['beforeTransaction', 'beforeCommit']) {
  for (const mode of ['client-transfer', 'period-transfer', 'period-closed', 'disabled', 'deleted']) {
    test(`${hook} 并发 ${mode}：最终事务和冲突重试均拒绝失效权限`, async () => {
      const h = priceHarness(mode.startsWith('period') ? 'other' : 'owner')
      assert.equal((await h.prices()).ok, true)
      let changed
      h[hook] = () => {
        h.change(t => {
          if (mode === 'client-transfer') t.clients[0].ownerMemberId = h.c.members.creator.id
          else if (mode === 'period-transfer') t.billingPeriods[0].ownerMemberId = h.c.members.creator.id
          else if (mode === 'period-closed') t.billingPeriods[0].status = 'settled'
          else if (mode === 'disabled') t.memberships.find(m => m.id === h.c.members.owner.id).status = 'disabled'
          else t.memberships = t.memberships.filter(m => m.id !== h.c.members.owner.id)
        })
        changed = h.read()
      }
      const result = await h.priceSave()
      assert.equal(result.ok, false, JSON.stringify(result))
      assert.deepEqual(h.read(), changed)
      assert.equal(h.commits, 0)
      if (hook === 'beforeCommit') assert.equal(h.attempts, 2)
    })
  }
}
for (const state of ['disabled', 'deleted', 'stranger', 'missing-openid', 'pending']) {
  test(`${state} 真实 membership 不可读写，前端 role=admin 不能恢复`, async () => {
    const h = priceHarness()
    if (state === 'stranger' || state === 'missing-openid') h.openid = state === 'stranger' ? 'unknown' : ''
    else h.change(t => {
      if (state === 'deleted') t.memberships = t.memberships.filter(m => m.id !== h.c.members.owner.id)
      else t.memberships.find(m => m.id === h.c.members.owner.id).status = state
    })
    await rejectUnchanged(h, () => h.prices(), /停用|尚未加入|无法取得|已失效/)
    await rejectUnchanged(h, () => h.priceSave(), /停用|尚未加入|无法取得|已失效/)
  })
}
for (const field of ['id', 'priceId']) {
  test(`伪造 clientId 不能凭 ${field} 修改其他客户价格`, async () => {
    const h = priceHarness()
    await rejectUnchanged(h, () => h.priceSave({ id: undefined, [field]: 'price_unrelated' }))
    assert.equal(h.read().tenants[tenantId].customerPrices[1].unitPriceCents, 8800)
  })
}
test('跨 tenant client / customer_price 均拒绝，payload tenantId 无法切换身份', async () => {
  const h = priceHarness('admin')
  h.change((t, root) => {
    root.tenants.tenant_b = Object.assign({}, copy(t), {
      enterprise: { id: 'tenant_b', name: '企业B' }, memberships: [],
      clients: [{ id: 'foreign-client', tenantId: 'tenant_b', name: 'B客户', ownerMemberId: h.c.members.owner.id }],
      customerPrices: [{ id: 'foreign-price', tenantId: 'tenant_b', clientId: 'foreign-client', productId: h.c.item.productId, unit: '米', unitPriceCents: 99999 }]
    })
  })
  await rejectUnchanged(h, () => h.prices('listCustomerPrices', 'foreign-client'))
  await rejectUnchanged(h, () => h.priceSave({ id: undefined, clientId: 'foreign-client' }))
  await rejectUnchanged(h, () => h.priceSave({ id: 'foreign-price' }))
})
test('bootstrap 和写操作返回过滤客户价格及其审计，但不抹掉历史成交快照', async () => {
  const h = priceHarness()
  const boot = await h.main({ action: 'bootstrap' })
  assert.deepEqual(boot.snapshot.customerPrices.map(p => p.id), ['price_owned'])
  assert.equal(boot.snapshot.auditLogs.some(a => a.id === 'price_audit_other'), false)
  assert.deepEqual(copy(boot.snapshot.shipments[0].lines), h.c.shipment.lines)
  const saved = await h.priceSave()
  assert.deepEqual(saved.snapshot.customerPrices.map(p => p.id), ['price_owned'])
  assert.equal(saved.snapshot.auditLogs.some(a => a.id === 'price_audit_other'), false)
  h.openid = h.c.members.creator.openid
  const outsider = await h.main({ action: 'bootstrap' })
  assert.deepEqual(outsider.snapshot.customerPrices, [])
  assert.equal(outsider.snapshot.auditLogs.some(a => a.entityType === 'customer_price'), false)
})
test('快速记账 saveAsDefault 不能绕过客户价格权限；单笔发货权限保持', async () => {
  const h = priceHarness('creator')
  const post = saveAsDefault => h.main({ action: 'postShipment', payload: { args: [{
    confirmed: true, requestId: 'price-bypass', clientId: h.c.client.id, shipmentDate: '2026-09-21',
    items: [Object.assign({}, h.c.item, { saveAsDefault })]
  }] } })
  await rejectUnchanged(h, () => post(true))
  const before = h.read().tenants[tenantId].customerPrices
  assert.equal((await post(false)).ok, true)
  assert.deepEqual(h.read().tenants[tenantId].customerPrices, before)
})
test('仓储不信任显式 actor 的 role；membership 删除、停用后本地保存也拒绝', () => {
  const c = setup()
  const forged = createLedgerRepository(c.storage, { actor: { id: c.members.creator.id, role: 'admin', status: 'active', tenantId } })
  assert.throws(() => forged.listCustomerPrices(tenantId, c.client.id), /无权/)
  c.change(t => { t.memberships = t.memberships.filter(m => m.id !== c.members.owner.id) })
  assert.throws(() => c.repositories.owner.saveCustomerPrice(tenantId, { confirmed: true, clientId: c.client.id, productId: c.item.productId, unit: '米', unitPriceCents: 1000 }), /不存在|停用/)
})
test('改当前价格不改变已结清发货/账单、旧字段、对账模型、图片模型和最终 Excel 成交单价', async () => {
  const h = priceHarness()
  h.openid = h.c.members.admin.openid
  assert.equal((await h.main({ action: 'recordPayment', payload: { args: [{ confirmed: true, requestId: 'settle-pay', clientId: h.c.client.id, periodId: h.c.shipment.periodId, paymentDate: '2026-09-21', amountCents: 10250, method: '现金' }] } })).ok, true)
  assert.equal((await h.main({ action: 'closeBillingPeriod', payload: { args: [{ confirmed: true, requestId: 'settle-close', clientId: h.c.client.id, periodId: h.c.shipment.periodId, closedDate: '2026-09-21' }] } })).ok, true)
  h.openid = h.c.members.owner.openid
  h.change(t => {
    // Deliberately old records: a price-only write must never normalize them.
    delete t.shipments[0].itemsSubtotalCents
  })
  const before = h.read().tenants[tenantId]
  const repository = snapshot => createLedgerRepository(createMemoryStorage({ schemaVersion: 1, tenants: { [tenantId]: snapshot } }))
  const statementBefore = repository(before).getStatement(tenantId, h.c.client.id, h.c.shipment.periodId)
  const { buildStatementExportDocument } = require('../services/statement-export')
  const document = snapshot => buildStatementExportDocument({ enterprise: snapshot.enterprise, client: snapshot.clients[0], period: snapshot.billingPeriods[0], shipments: snapshot.shipments, payments: snapshot.payments, generatedAt: '2026-09-21T00:00:00.000Z' })
  const docBefore = document(before)
  assert.equal((await h.priceSave()).ok, true)
  const after = h.read().tenants[tenantId]
  assert.deepEqual(after.shipments, before.shipments)
  assert.deepEqual(after.billingPeriods, before.billingPeriods)
  assert.equal(Object.hasOwn(after.shipments[0], 'itemsSubtotalCents'), false)
  assert.deepEqual(repository(after).getStatement(tenantId, h.c.client.id, h.c.shipment.periodId), statementBefore)
  assert.deepEqual(document(after), docBefore)
  const { writeStatementWorkbook } = require('../cloudfunctions/ledger/services/statement-excel')
  const ExcelJS = require('../cloudfunctions/ledger/node_modules/exceljs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-price-snapshot-'))
  try {
    const file = path.join(dir, 'history.xlsx')
    await writeStatementWorkbook(document(after), file)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(file)
    assert.equal(workbook.getWorksheet('发货明细').getRow(2).getCell(12).value, 10)
    assert.equal(after.customerPrices[0].unitPriceCents, 2500)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('超出企业快照前1000条的真实客户、价格、开放账期仍由定向查询校验', async () => {
  const h = priceHarness('other')
  h.change(t => {
    t.clients.unshift(...Array.from({ length: 1001 }, (_, i) => ({ id: `filler-client-${i}`, tenantId })))
    t.billingPeriods.unshift(...Array.from({ length: 1001 }, (_, i) => ({ id: `filler-period-${i}`, tenantId, clientId: 'unrelated', status: 'settled' })))
    t.customerPrices.unshift(...Array.from({ length: 1001 }, (_, i) => ({ id: `filler-price-${i}`, tenantId, clientId: 'unrelated' })))
  })
  assert.equal((await h.prices()).ok, true)
  assert.equal((await h.priceSave()).ok, true)
  assert.ok(h.queries.some(q => q.scope.startsWith('transaction') && q.name === 'customer_prices' && q.id === 'price_owned'))
  assert.ok(h.queries.some(q => q.scope.startsWith('transaction') && q.name === 'clients' && q.id === h.c.client.id))
  assert.ok(h.queries.some(q => q.scope.startsWith('transaction') && q.name === 'billing_periods' && q.criteria.clientId === h.c.client.id && q.criteria.status === 'open' && q.criteria.tenantId === tenantId))
  assert.equal(h.read().tenants[tenantId].customerPrices.length, 1003)
})
test('新发货使用调整后客户价，已有发货成交值不变', async () => {
  const h = priceHarness()
  const oldShipment = copy(h.read().tenants[tenantId].shipments[0])
  assert.equal((await h.priceSave({ unitPriceCents: 2345 })).ok, true)
  const price = (await h.prices('getCustomerPriceForProduct')).result
  const result = await h.main({ action: 'postShipment', payload: { args: [{
    confirmed: true, requestId: 'new-price-shipment', clientId: h.c.client.id, shipmentDate: '2026-09-21',
    items: [Object.assign({}, h.c.item, { unitPriceYuan: undefined, unitPriceCents: price.unitPriceCents, pricingUnit: price.unit })]
  }] } })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.result.lines[0].unitPriceCents, 2345)
  assert.equal(result.result.totalAmountCents, 23450)
  assert.deepEqual(h.read().tenants[tenantId].shipments[0], oldShipment)
})
test('管理员真实角色撤销后，payload 管理员角色与旧页面身份都无效', async () => {
  const h = priceHarness('admin')
  assert.equal((await h.prices()).ok, true)
  h.change(t => { t.memberships.find(m => m.id === h.c.members.admin.id).role = 'member' })
  await rejectUnchanged(h, () => h.priceSave())
  await rejectUnchanged(h, () => h.prices())
})
