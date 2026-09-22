const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { cloudHarness } = require('./helpers/cloud-ledger-harness')
const { tenantId } = require('./helpers/shipment-correction-fixture')
const { installWx, instantiatePage } = require('../scripts/benchmark-performance')
const flush = () => new Promise(resolve => setImmediate(resolve))
function setup(actor = 'owner') {
  const h = cloudHarness('creator')
  h.openid = h.c.members[actor].openid
  h.change(t => t.customerPrices.push({ id: 'price', tenantId, clientId: h.c.client.id, productId: h.c.item.productId, unit: '米', unitPriceCents: 1000, active: true }))
  installWx({})
  ;['cloud-repository', 'repository-instance', 'page-context'].forEach(name => delete require.cache[require.resolve(`../services/${name}`)])
  const calls = []; const modals = []; const urls = []; const backs = []
  wx.cloud.callFunction = async request => { calls.push(request.data); return { result: await h.main(request.data) } }
  wx.showModal = request => modals.push(request)
  wx.navigateTo = request => urls.push(request.url)
  wx.navigateBack = request => backs.push(request)
  wx.switchTab = request => urls.push(request.url)
  return { h, calls, modals, urls, backs }
}
async function openPage(context, name = 'customer-prices') {
  const { page } = instantiatePage(`pages/${name}/${name}`)
  page.onLoad({ id: context.h.c.client.id, clientId: context.h.c.client.id, role: 'admin', canManagePrices: 'true', ownerMemberId: context.h.c.members.owner.id })
  page.onShow()
  await flush()
  return page
}
for (const actor of ['admin', 'owner', 'other', 'creator']) {
  test(`${actor} 客户账本价格入口由最新归属决定`, async () => {
    const context = setup(actor)
    const page = await openPage(context, 'client-ledger')
    assert.equal(page.data.canManagePrices, actor !== 'creator')
    page.prices()
    assert.equal(context.urls.length, actor === 'creator' ? 0 : 1)
    assert.equal(page.data.isAdmin, actor === 'admin', '其它管理员 UI 不扩大')
  })
  test(`${actor} 直接进入价格页面必须调用服务端 list，未授权无价格且安全返回`, async () => {
    const context = setup(actor)
    const page = await openPage(context)
    assert.equal(context.calls.some(call => call.action === 'listCustomerPrices'), true)
    if (actor !== 'creator') {
      assert.equal(page.data.prices[0].priceText, '¥10.00/米')
      assert.ok(page.data.client)
    } else {
      assert.deepEqual(page.data.prices, [])
      assert.deepEqual(page.allPrices, [])
      assert.equal(page.data.client, null)
      assert.equal(context.modals.at(-1).title, '无权访问')
      context.modals.at(-1).success()
      assert.equal(context.backs.length, 1)
      context.backs[0].fail()
      assert.equal(context.urls[0], '/pages/clients/clients')
    }
  })
}
test('价格页即使缓存 canManagePrices=true、价格/身份可见，也以新的服务端拒绝为准', async () => {
  const context = setup()
  const page = await openPage(context)
  page.setData({ canManagePrices: true })
  const previousCall = wx.cloud.callFunction
  wx.cloud.callFunction = async request => {
    if (request.data.action === 'listCustomerPrices') context.h.change(t => { t.clients[0].ownerMemberId = context.h.c.members.creator.id })
    return previousCall(request)
  }
  page.onShow()
  assert.equal(page.data.client, null)
  assert.deepEqual(page.data.prices, [])
  await flush()
  assert.equal(page.data.client, null)
  assert.deepEqual(page.allPrices, [])
  assert.equal(context.modals.at(-1).title, '无权访问')
})
test('编辑时发送真实 price id，保存前 owner 变更后服务端拒绝并清理价格', async () => {
  const context = setup()
  const page = await openPage(context)
  page.openEdit({ currentTarget: { dataset: { id: 'price' } } })
  page.onPrice({ detail: { value: '99' } })
  context.h.beforeTransaction = () => context.h.change(t => { t.clients[0].ownerMemberId = context.h.c.members.creator.id })
  page.save()
  await flush()
  const request = context.calls.find(call => call.action === 'saveCustomerPrice')
  assert.equal(request.payload.args[0].id, 'price')
  assert.equal(request.payload.args[0].unitPriceYuan, '99')
  assert.equal(context.h.read().tenants[tenantId].customerPrices[0].unitPriceCents, 1000)
  assert.deepEqual(page.data.prices, [])
  assert.equal(page.data.client, null)
  assert.equal(context.modals.at(-1).title, '无权访问')
})
test('页面保存成功并刷新，重复点击不会重复写审计', async () => {
  const context = setup('other')
  const page = await openPage(context)
  page.openEdit({ currentTarget: { dataset: { id: 'price' } } })
  page.onPrice({ detail: { value: '23.45' } })
  page.save(); page.save()
  await flush()
  assert.equal(context.calls.filter(call => call.action === 'saveCustomerPrice').length, 1)
  assert.equal(context.h.read().tenants[tenantId].customerPrices[0].unitPriceCents, 2345)
  assert.equal(page.data.prices[0].priceText, '¥23.45/米')
  assert.equal(page.data.formOpen, false)
})
test('页面返回时重新检查负责人；账期结清失权后入口关闭，价格页清空', async () => {
  const context = setup('other')
  const ledger = await openPage(context, 'client-ledger')
  const prices = await openPage(context)
  context.h.change(t => { t.billingPeriods[0].status = 'settled' })
  ledger.onShow(); prices.onShow()
  assert.equal(ledger.data.canManagePrices, false)
  assert.equal(prices.data.client, null)
  await flush()
  assert.equal(ledger.data.canManagePrices, false)
  assert.deepEqual(prices.data.prices, [])
})
test('请求失败不保留旧价格；页面离开后迟到的读取结果不重新显示', async () => {
  const context = setup()
  const page = await openPage(context)
  let resolveRead
  const originalCall = wx.cloud.callFunction
  wx.cloud.callFunction = request => request.data.action === 'listCustomerPrices'
    ? new Promise(resolve => { resolveRead = resolve }) : originalCall(request)
  page.onShow()
  await flush()
  page.onHide()
  resolveRead({ result: { ok: true, result: [{ id: 'stale', productLabel: '旧结果', unitPriceCents: 9999, unit: '米' }] } })
  await flush()
  assert.equal(page.data.client, null)
  assert.deepEqual(page.data.prices, [])
  wx.cloud.callFunction = async () => { throw new Error('offline') }
  page.onShow()
  await flush()
  assert.deepEqual(page.allPrices, [])
  assert.match(context.modals.at(-1).content, /offline/)
})
test('价格入口 WXML 使用独立 canManagePrices；其它管理入口继续 isAdmin', () => {
  const wxml = fs.readFileSync('pages/client-ledger/client-ledger.wxml', 'utf8')
  assert.match(wxml, /wx:if="{{canManagePrices}}"[^>]*bindtap="prices"/)
  assert.match(wxml, /wx:if="{{isAdmin}}"[^>]*bindtap="editClient"/)
  assert.match(wxml, /wx:if="{{isAdmin}}"[^>]*bindtap="manageOwners"/)
})
