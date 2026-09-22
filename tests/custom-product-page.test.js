const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { cloudHarness } = require('./helpers/cloud-ledger-harness')
const { tenantId } = require('./helpers/shipment-correction-fixture')
const { installWx, instantiatePage } = require('../scripts/benchmark-performance')
const flush = () => new Promise(resolve => setImmediate(resolve))

function context(actor = 'owner') {
  const h = cloudHarness('creator')
  h.openid = h.c.members[actor].openid
  installWx({})
  ;['cloud-repository', 'repository-instance', 'page-context'].forEach(name => delete require.cache[require.resolve(`../services/${name}`)])
  const calls = []; const modals = []; const urls = []; const toasts = []
  wx.cloud.callFunction = async request => { calls.push(request.data); return { result: await h.main(request.data) } }
  wx.showModal = request => modals.push(request)
  wx.showToast = request => toasts.push(request)
  wx.navigateTo = request => urls.push(request.url)
  wx.navigateBack = () => urls.push('back')
  return { h, calls, modals, urls, toasts }
}
async function quick(c) {
  const { page } = instantiatePage('pages/quick-entry/quick-entry')
  page.onLoad({ clientId: c.h.c.client.id, canCreateCustomProduct: true, isAdmin: true })
  await flush()
  page.onTextInput({ detail: { value: '银灰色细齿底槽4025 100米' } })
  page.parseOrder()
  return page
}
const rowEvent = { currentTarget: { dataset: { index: 0 } } }
for (const actor of ['admin', 'owner', 'other', 'creator']) {
  test(`${actor} 快速记账创建入口、选择弹窗和保存均使用独立客户权限`, async () => {
    const c = context(actor)
    const page = await quick(c)
    assert.equal(page.data.canCreateForClient, actor !== 'creator')
    assert.equal(page.data.rows[0].productId, '')
    assert.equal(page.data.rows[0].canCreateCustomProduct, true, 'parser marker is not authorization')
    assert.deepEqual(page.data.rows[0].specialTags, ['底槽'])
    page.openProductSelector(rowEvent)
    assert.deepEqual(page.data.filteredProductOptions, [], 'bottom picker cannot list ordinary standard products')
    page.openCustomProductForm(rowEvent)
    if (actor === 'creator') {
      assert.equal(page.data.showCustomForm, false)
      page.setData({ canCreateForClient: true, customForm: { name: '底槽伪造表单', clientId: c.h.c.client.id } })
      await page.saveCustomProduct()
      assert.equal(page.data.canCreateForClient, false)
      assert.equal(c.calls.filter(r => r.action === 'createCustomProduct').length, 0)
      return
    }
    assert.match(page.data.customForm.name, /底槽/)
    assert.deepEqual(page.data.customForm.specialTags, ['底槽'])
    const saving = page.saveCustomProduct()
    page.saveCustomProduct()
    await saving
    const requests = c.calls.filter(r => r.action === 'createCustomProduct')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].payload.args[0].clientId, c.h.c.client.id)
    assert.equal(page.data.selectorOpen, false)
    assert.ok(page.data.rows[0].productId)
    assert.match(page.data.rows[0].productLabel, /底槽/)
    assert.deepEqual(page.data.rows[0].specialTags, ['底槽'])
    assert.equal(page.data.rows[0].unitPriceYuan, '')
    assert.equal(page.data.canPost, false, 'creation does not supply or guess a price')
    page.onPriceInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '2.50' } })
    assert.equal(page.data.canPost, true)
    page.confirmPost()
    c.modals.at(-1).success({ confirm: true })
    await flush()
    const shipment = c.h.read().tenants[tenantId].shipments.at(-1)
    assert.equal(shipment.lines[0].productId, page.data.rows[0].productId)
    assert.deepEqual(shipment.lines[0].productSnapshot.specialTags, ['底槽'])
    assert.equal(shipment.totalAmountCents, 25000)
  })
}
for (const actor of ['owner', 'other']) {
  test(`${actor} 表单打开后负责人变化，缓存按钮仍为true也不能保存`, async () => {
    const c = context(actor)
    const page = await quick(c)
    page.createCustomProduct(rowEvent)
    c.h.change(t => {
      if (actor === 'owner') t.clients[0].ownerMemberId = c.h.c.members.creator.id
      else t.billingPeriods[0].status = 'settled'
    })
    assert.equal(page.data.canCreateForClient, true)
    const before = c.h.read()
    await page.saveCustomProduct()
    assert.deepEqual(c.h.read(), before)
    assert.equal(page.data.rows[0].productId, '')
    assert.match(c.modals.at(-1).content, /负责人/)
  })
}
test('切换客户重新计算创建权限，关闭旧表单，不会借其它客户创建', async () => {
  const c = context()
  c.h.change(t => t.clients.push({ id: 'unrelated', tenantId, name: '其他客户', ownerMemberId: c.h.c.members.admin.id, active: true }))
  const page = await quick(c)
  page.createCustomProduct(rowEvent)
  page.onClientChange({ detail: { value: page.clients.findIndex(client => client.id === 'unrelated') } })
  assert.equal(page.data.canCreateForClient, false)
  assert.equal(page.data.customForm, null)
  assert.equal(page.data.selectorOpen, false)
  page.createCustomProduct(rowEvent)
  assert.equal(page.data.showCustomForm, false)
})
test('底槽选择器和直接选择事件都不能把底槽换成普通标准品', async () => {
  const c = context()
  const page = await quick(c)
  const ordinary = page.productOptions.find(p => p.height === 40 && p.width === 25 && p.color === '灰色' && p.toothType === '细齿')
  page.openProductSelector(rowEvent)
  page.selectProduct({ currentTarget: { dataset: { productId: ordinary.id } } })
  assert.equal(page.data.rows[0].productId, '')
  assert.match(c.toasts.at(-1).title, /不能混用/)
  assert.equal(page.data.canPost, false)
})
test('用户在创建表单明确改为底槽后，保存并使用采用新身份且保留数量', async () => {
  const c = context()
  const page = await quick(c)
  page.onTextInput({ detail: { value: '银灰色细齿4025 100米' } })
  page.parseOrder()
  page.openCustomProductForm(rowEvent)
  page.onCustomFormInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '银灰色细齿底槽4025' } })
  await page.saveCustomProduct()
  const product = c.h.read().tenants[tenantId].customProducts[0]
  assert.equal(page.data.rows[0].productId, product.id)
  assert.deepEqual(page.data.rows[0].specialTags, ['底槽'])
  assert.equal(page.data.rows[0].quantityText, '100')
  assert.equal(page.data.rows[0].unit, '米')
  assert.equal(page.data.canPost, false)
})
for (const actor of ['owner', 'other', 'admin']) {
  test(`${actor} 全局产品管理页/直接表单路由保留管理员边界`, async () => {
    const c = context(actor)
    const { page: list } = instantiatePage('pages/products/products')
    list.onShow()
    await flush()
    assert.equal(list.data.isAdmin, actor === 'admin')
    list.add()
    list.toggle({ currentTarget: { dataset: { id: c.h.c.item.productId } } })
    const { page: form } = instantiatePage('pages/product-form/product-form')
    form.onLoad({ clientId: c.h.c.client.id, isAdmin: true })
    await flush()
    assert.equal(form.data.isAdmin, actor === 'admin')
    form.setData({ name: '全局自定义底槽', isAdmin: true })
    form.save()
    await flush()
    const writes = c.calls.filter(r => ['createCustomProduct', 'updateCustomProduct', 'setProductActive'].includes(r.action))
    assert.equal(writes.length, actor === 'admin' ? 1 : 0)
    if (actor !== 'admin') {
      assert.equal(list.data.products.length, 0)
      assert.equal(form.data.isAdmin, false)
      assert.match(c.modals.at(-1).content, /管理员/)
    }
  })
}
test('所有可见创建入口受客户权限控制，全局管理入口继续admin-only', () => {
  const quickSource = fs.readFileSync('pages/quick-entry/quick-entry.wxml', 'utf8')
  assert.match(quickSource, /wx:if="{{item.canCreateCustomProduct && canCreateForClient}}"/)
  assert.match(quickSource, /wx:if="{{canCreateForClient}}"[^>]+bindtap="openCustomProductForm"/)
  assert.match(quickSource, /wx:elif="{{canCreateForClient}}" class="custom-form"/)
  assert.match(fs.readFileSync('pages/mine/mine.wxml', 'utf8'), /wx:if="{{isAdmin}}"[^>]+data-url="\/pages\/products\/products"/)
})
