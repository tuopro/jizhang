const test = require('node:test')
const assert = require('node:assert/strict')
const { createFixture } = require('../scripts/performance-fixture')
const { installWx, instantiatePage } = require('../scripts/benchmark-performance')
const storageModule = require('../services/storage')
const { createLedgerRepository } = require('../services/ledger-repository')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(fixture = createFixture(4, 12)) {
  const api = installWx(fixture)
  ;['cloud-repository', 'repository-instance', 'page-context'].forEach(name => delete require.cache[require.resolve(`../services/${name}`)])
  const instance = require('../services/repository-instance')
  return { api, instance, fixture }
}

test('一次同步页面计算只复制一个工作快照，所有读取结果与原领域仓储一致', async () => {
  const originalStorage = storageModule.createMemoryStorage
  let reads = 0
  storageModule.createMemoryStorage = (...args) => {
    const storage = originalStorage(...args)
    return { read() { reads += 1; return storage.read() }, write: storage.write }
  }
  try {
    const { instance, fixture } = setup()
    // Include old rows without normalized freight fields and legacy monthly periods.
    delete fixture.snapshot.shipments[0].freightCents
    delete fixture.snapshot.shipments[0].itemsSubtotalCents
    delete fixture.snapshot.shipments[1].periodId
    const original = JSON.stringify(fixture.snapshot)
    await instance.prepareRepository()
    const cloud = instance.getRepository()
    const reference = createLedgerRepository(originalStorage({ schemaVersion: 1, tenants: { [fixture.tenantId]: fixture.snapshot } }))
    const requests = [
      ['getEnterprise'], ['listClients'], ['listMembers'], ['listProducts'], ['listCustomProducts'],
      ['getClient', 'client_0000'], ['getClientLedger', 'client_0000'], ['getDashboard'],
      ['listShipments'], ['listPayments'], ['listBillingPeriods'], ['getPeriodDetail', 'period_0_open'],
      ['getStatement', 'client_0000'], ['getStatement', '', 'period_0_settled'],
      ['getAuditLogs'], ['getShipment', 'shipment_0']
    ]
    reads = 0
    cloud.withReadSnapshot(() => {
      for (const [method, ...args] of requests) {
        assert.deepEqual(cloud[method](fixture.tenantId, ...args), reference[method](fixture.tenantId, ...args), method)
      }
    })
    assert.equal(reads, 1)
    assert.equal(JSON.stringify(fixture.snapshot), original, 'legacy normalization never writes the source snapshot')
    cloud.withReadSnapshot(() => {
      const ledger = cloud.getClientLedger(fixture.tenantId, 'client_0000')
      ledger.client.name = 'mutated caller value'
      ledger.shipments[0].lines[0].productSnapshot.label = 'mutated label'
      assert.notEqual(cloud.getClient(fixture.tenantId, 'client_0000').name, ledger.client.name)
      assert.notEqual(cloud.getShipment(fixture.tenantId, ledger.shipments[0].id).lines[0].productSnapshot.label, 'mutated label')
    })
    assert.equal(reads, 2, 'completed read scopes do not become a persistent cache')
    assert.throws(() => cloud.withReadSnapshot(() => { cloud.getEnterprise(); throw new Error('model failure') }), /model failure/)
    cloud.getEnterprise()
    assert.equal(reads, 4, 'failed scope also releases its copy')
    await cloud.withReadSnapshot(async () => { cloud.getEnterprise(); await Promise.resolve(); cloud.getEnterprise() })
    assert.equal(reads, 6, 'read scope does not survive an await')
    assert.deepEqual(await cloud.listCustomerPrices(fixture.tenantId, 'client_0000'), reference.listCustomerPrices(fixture.tenantId, 'client_0000'), '价格表改为服务端实时校验读取')
  } finally { storageModule.createMemoryStorage = originalStorage }
})

test('原有 prepareRepository 并发去重：3个调用只有1个请求；完成与失败均清理', async () => {
  const { instance, api } = setup()
  await Promise.all([instance.prepareRepository(), instance.prepareRepository(), instance.prepareRepository()])
  assert.equal(api.calls(), 1)
  await instance.prepareRepository()
  assert.equal(api.calls(), 2, 'new navigation still validates membership on the server')
  let requests = 0
  const originalCall = wx.cloud.callFunction
  wx.cloud.callFunction = () => { requests += 1; return Promise.reject(new Error('offline')) }
  const rejected = await Promise.allSettled([instance.prepareRepository(), instance.prepareRepository(), instance.prepareRepository()])
  assert.equal(requests, 1)
  assert.ok(rejected.every(result => result.status === 'rejected'))
  wx.cloud.callFunction = originalCall
  await instance.prepareRepository()
  assert.equal(api.calls(), 3)
})

test('写入返回的新快照立即被下一次读取使用，退出后不复用旧tenant', async () => {
  const { instance, fixture } = setup()
  await instance.prepareRepository()
  const repository = instance.getRepository()
  const sent = []
  wx.cloud.callFunction = async request => {
    sent.push(request.data)
    const snapshot = JSON.parse(JSON.stringify(fixture.snapshot))
    snapshot.clients[0].name = '服务器确认的新名称'
    return { result: { ok: true, result: snapshot.clients[0], snapshot } }
  }
  await repository.saveClient('forged-tenant', { confirmed: true, id: 'client_0000', name: '请求名称' })
  assert.equal(sent[0].action, 'saveClient')
  assert.equal(sent[0].payload.tenantId, undefined)
  assert.equal(repository.getClient(fixture.tenantId, 'client_0000').name, '服务器确认的新名称')
  instance.resetRepository()
  assert.notEqual(instance.getRepository(), repository)
  assert.throws(() => instance.getRepository().listClients(), /尚未加载/)
})

test('返回页保留内容且仍重新授权；disabled立即清仓储并跳转；callback不会执行两次', async () => {
  const { instance, api } = setup()
  const { loadPage } = require('../services/page-context')
  const page = {}
  let callbacks = 0
  let redirects = 0
  let lightLoading = 0
  wx.showNavigationBarLoading = () => { lightLoading += 1 }
  wx.hideNavigationBarLoading = () => {}
  wx.reLaunch = options => { redirects += 1; assert.match(options.url, /reason=disabled/); options.complete() }
  loadPage(page, () => { callbacks += 1 })
  await flush()
  assert.equal(callbacks, 1)
  assert.equal(api.loading.show, 1)
  loadPage(page, () => { callbacks += 1 })
  await flush()
  assert.equal(callbacks, 2)
  assert.equal(api.calls(), 2)
  assert.equal(lightLoading, 1)
  assert.equal(api.loading.show, 1)
  wx.cloud.callFunction = async () => ({ result: { ok: false, code: 'MEMBERSHIP_DISABLED', error: '成员账号已停用' } })
  const old = instance.getRepository()
  loadPage(page, () => { callbacks += 1 })
  await flush()
  assert.equal(callbacks, 2)
  assert.equal(redirects, 1)
  assert.notEqual(instance.getRepository(), old)
  assert.throws(() => instance.getRepository().listClients(), /尚未加载/)
})

test('列表与快速记账只向setData发送渲染数据；完整产品和客户仍可选择和搜索', async () => {
  setup(createFixture(40, 80))
  for (const name of ['clients', 'history', 'products', 'customer-prices', 'quick-entry']) {
    const { page, payloads } = instantiatePage(`pages/${name}/${name}`)
    if (page.onLoad) await page.onLoad({ clientId: 'client_0000' })
    if (page.onShow) page.onShow()
    await flush()
    const keys = payloads.flatMap(item => item.keys)
    assert.ok(!keys.some(key => ['allClients', 'allHistories', 'allProducts', 'allPrices', 'productOptions', 'standardProductOptions', 'customProductOptions'].includes(key)), name)
    assert.equal(payloads.length, name === 'customer-prices' ? 2 : 1, name)
    if (name === 'clients') {
      page.onSearch({ detail: { value: '0039' } })
      assert.equal(page.data.clients[0].id, 'client_0039')
    }
    if (name === 'quick-entry') {
      assert.equal(page.clients.length, 40)
      assert.ok(page.productOptions.length > 150)
      assert.equal(page.data.productOptions, undefined)
      page.updateProductFilter('standard', '40×40')
      assert.ok(page.data.filteredProductOptions.length > 0)
    }
  }
})
