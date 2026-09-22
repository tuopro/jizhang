const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setup, tenantId } = require('./helpers/shipment-correction-fixture')
const { installWx, instantiatePage } = require('../scripts/benchmark-performance')
const flush = () => new Promise(resolve => setImmediate(resolve))

function pagesFor(actor = 'owner', status = 'open', c = setup('creator')) {
  c.change(t => { t.billingPeriods[0].status = status })
  const member = c.members[actor]
  const fixture = {
    tenantId, snapshot: c.storage.read().tenants[tenantId],
    identity: { tenantId, memberId: member.id, role: member.role, displayName: member.displayName, status: member.status }
  }
  installWx(fixture)
  ;['cloud-repository', 'repository-instance', 'page-context'].forEach(name => delete require.cache[require.resolve(`../services/${name}`)])
  const instance = require('../services/repository-instance')
  const urls = []
  const modals = []
  wx.navigateTo = request => urls.push(request.url)
  wx.showModal = request => modals.push(request)
  return { c, fixture, instance, urls, modals }
}

async function detail(h, options = {}) {
  const { page } = instantiatePage('pages/shipment-detail/shipment-detail')
  page.onLoad(Object.assign({ id: h.c.shipment.id }, options))
  page.onShow()
  await flush()
  return page
}

for (const actor of ['admin', 'owner', 'other', 'creator']) {
  test(`开放详情 ${actor} 修改入口正确，非负责人不会显示已结清`, async () => {
    const h = pagesFor(actor)
    const page = await detail(h, { readOnly: 'true', historical: 'true', canEdit: 'false' })
    assert.ok(page.data.shipment)
    assert.equal(page.data.isClosed, false)
    assert.equal(page.data.editUnavailableReason, '')
    assert.equal(page.data.canEdit, actor === 'admin' || actor === 'owner')
    page.edit()
    assert.equal(h.urls.length, page.data.canEdit ? 1 : 0)
    if (page.data.canEdit) assert.equal(h.urls[0], `/pages/quick-entry/quick-entry?shipmentId=${h.c.shipment.id}`)
  })
}

for (const status of ['closed', 'settled']) {
  for (const actor of ['admin', 'owner', 'creator']) {
    test(`${status} 历史详情 ${actor} 继续只读，路由不能恢复编辑`, async () => {
      const h = pagesFor(actor, status)
      const page = await detail(h, { readOnly: 'false', historical: 'false', canEdit: 'true', role: 'admin' })
      assert.equal(page.data.isClosed, true)
      assert.equal(page.data.canEdit, false)
      page.edit()
      assert.equal(h.urls.length, 0)
    })
  }
}

test('本期发货分批渲染后点击精简行，仍按 shipment id 加载完整真实开放账期', async () => {
  const c = setup('creator')
  for (let i = 0; i < 36; i += 1) c.repositories.admin.postShipment(tenantId, {
    confirmed: true, requestId: `extra-${i}`, clientId: c.client.id, shipmentDate: '2026-09-21', items: [c.item]
  })
  const h = pagesFor('owner', 'open', c)
  const { page: ledger } = instantiatePage('pages/client-ledger/client-ledger')
  ledger.onLoad({ id: c.client.id })
  ledger.onShow()
  await flush()
  while (ledger._progressiveModel) await new Promise(resolve => setTimeout(resolve, 1))
  assert.match(ledger.data.periodTitle, /第1期 · 进行中/)
  assert.equal(ledger.data.shipments.length, 37)
  const row = ledger.data.shipments[35]
  assert.equal(row.periodId, undefined)
  assert.equal(row.clientId, undefined)
  ledger.openShipment({ currentTarget: { dataset: { id: row.id } } })
  const url = new URL(h.urls[0], 'https://mini.test')
  const { page } = instantiatePage('pages/shipment-detail/shipment-detail')
  page.onLoad(Object.fromEntries(url.searchParams))
  page.onShow()
  await flush()
  assert.equal(page.data.shipment.id, row.id)
  assert.equal(page.data.shipment.periodId, c.shipment.periodId)
  assert.equal(page.data.shipment.clientId, c.client.id)
  assert.equal(page.data.isClosed, false)
  assert.equal(page.data.canEdit, true)
  ledger.onUnload()
})

test('WXML 历史提示独立绑定真实 isClosed，不再使用修改按钮的 wx:else', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../pages/shipment-detail/shipment-detail.wxml'), 'utf8')
  assert.match(wxml, /<button wx:if="{{canEdit}}"[^>]+bindtap="edit"/)
  assert.match(wxml, /<view wx:if="{{isClosed}}"[^>]*>该账期已结清，历史账单保持只读。<\/view>/)
  assert.doesNotMatch(wxml, /wx:else[^>]*>该账期已结清/)
  const ledger = fs.readFileSync(path.resolve(__dirname, '../pages/client-ledger/client-ledger.wxml'), 'utf8')
  assert.match(ledger, /data-id="{{item.id}}" bindtap="openShipment"/)
})

test('详情每次返回读取最新客户负责人和真实结清状态，失败时不保留旧编辑按钮', async () => {
  const h = pagesFor()
  const page = await detail(h)
  assert.equal(page.data.canEdit, true)
  h.fixture.snapshot.clients[0].ownerMemberId = h.c.members.other.id
  page.onShow()
  assert.equal(page.data.canEdit, false)
  await flush()
  assert.equal(page.data.isClosed, false)
  assert.equal(page.data.canEdit, false)
  h.fixture.snapshot.clients[0].ownerMemberId = h.c.members.owner.id
  page.onShow()
  await flush()
  assert.equal(page.data.canEdit, true)
  h.fixture.snapshot.billingPeriods[0].status = 'settled'
  page.onShow()
  await flush()
  assert.equal(page.data.canEdit, false)
  assert.equal(page.data.isClosed, true)
  wx.cloud.callFunction = async () => { throw new Error('offline') }
  page.onShow()
  await flush()
  assert.equal(page.data.canEdit, false)
})

test('缺失或错误关联的账期不会默认为已结清或开放可编辑', async () => {
  const h = pagesFor('admin')
  h.fixture.snapshot.billingPeriods = []
  const page = await detail(h)
  assert.ok(page.data.shipment)
  assert.equal(page.data.isClosed, false)
  assert.equal(page.data.canEdit, false)
  assert.match(page.data.editUnavailableReason, /账期不存在|归属不一致/)
})

for (const actor of ['admin', 'owner']) {
  test(`编辑页 ${actor} 进入原修正流程，owner 不能保存客户默认价`, async () => {
    const h = pagesFor(actor)
    const { page } = instantiatePage('pages/quick-entry/quick-entry')
    await page.onLoad({ shipmentId: h.c.shipment.id, readOnly: 'true', clientId: 'forged' })
    await flush()
    assert.equal(page.data.editing, true)
    assert.equal(page.data.selectedClientId, h.c.client.id)
    assert.equal(page.data.canSaveCorrectionPrices, actor === 'admin')
    assert.equal(page.data.canPost, true)
    page.onSaveDefaultChange({ currentTarget: { dataset: { index: 0 } }, detail: { value: true } })
    assert.equal(page.data.rows[0].saveAsDefault, actor === 'admin')
    const row = Object.assign({}, page.data.rows[0], { saveAsDefault: true })
    page.recalculate([row])
    assert.equal(page.data.rows[0].saveAsDefault, actor === 'admin')
    page.setData({ editReason: '页面修正验证' })
    let request
    wx.cloud.callFunction = async input => { request = input.data; return { result: { ok: true, result: h.c.shipment } } }
    page.postShipment()
    await flush()
    assert.equal(request.action, 'updateShipment')
    assert.equal(request.payload.args[0], h.c.shipment.id)
    assert.equal(request.payload.args[1].reason, '页面修正验证')
    assert.equal(request.payload.args[1].items[0].saveAsDefault, actor === 'admin')
  })
}

for (const state of ['nonowner', 'history', 'missing']) {
  test(`绕过按钮直达 ${state} 编辑路由仍不能进入或误发新账目`, async () => {
    const h = pagesFor(state === 'nonowner' ? 'other' : 'admin', state === 'history' ? 'settled' : 'open')
    if (state === 'missing') h.fixture.snapshot.shipments = []
    const { page } = instantiatePage('pages/quick-entry/quick-entry')
    await page.onLoad({ shipmentId: h.c.shipment.id, role: 'admin', readOnly: 'false', historical: 'false', canEdit: 'true' })
    await flush()
    assert.equal(page.data.editing, false)
    assert.equal(page.data.canPost, false)
    assert.equal(page.correctionBlocked, true)
    assert.ok(h.modals.length > 0)
    let called = false
    wx.cloud.callFunction = async () => { called = true; throw new Error('unexpected mutation') }
    page.postShipment()
    await flush()
    assert.equal(called, false)
  })
}
