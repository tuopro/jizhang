// Run: node scripts/benchmark-performance.js [output.json]
// Local Node timing, NOT WeChat/iPhone/cloud timing. No real network requests.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { spawnSync } = require('node:child_process')
const { createFixture, fakeDatabase } = require('./performance-fixture')
const root = path.resolve(__dirname, '..')
const bytes = value => Buffer.byteLength(JSON.stringify(value))

function installWx(fixture) {
  let calls = 0
  const loading = { show: 0, hide: 0 }
  global.getApp = () => ({ globalData: { dataAccessMode: 'cloud' } })
  global.wx = {
    getStorageSync: () => ({ version: '2026-09-v2', agreedAt: '2026-09-21T00:00:00.000Z' }),
    cloud: { callFunction: async ({ data }) => {
      calls += 1
      if (data.action === 'getActiveMemberInvite') return { result: { ok: true, result: null } }
      if (data.action === 'listCustomerPrices') {
        const { createLedgerRepository } = require('../services/ledger-repository')
        const repository = createLedgerRepository({ read: () => JSON.parse(JSON.stringify({ schemaVersion: 1, tenants: { [fixture.tenantId]: fixture.snapshot } })) }, { actor: { id: fixture.identity.memberId } })
        try { return { result: { ok: true, result: repository.listCustomerPrices(fixture.tenantId, data.payload.args[0]) } } }
        catch (error) { return { result: { ok: false, code: error.code, error: error.message } } }
      }
      if (data.action !== 'bootstrap') throw new Error(`Unexpected action: ${data.action}`)
      await Promise.resolve()
      return { result: { ok: true, result: fixture.identity, snapshot: JSON.parse(JSON.stringify(fixture.snapshot)) } }
    } },
    showLoading() { loading.show += 1 }, hideLoading() { loading.hide += 1 },
    showModal() {}, showToast() {}, reLaunch() {}, switchTab() {}, navigateBack() {},
    setNavigationBarTitle() {}, showShareMenu() {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } })
  }
  return { calls: () => calls, loading }
}

function instantiatePage(pagePath) {
  let definition
  global.Page = value => { definition = value }
  delete require.cache[require.resolve(path.join(root, `${pagePath}.js`))]
  require(path.join(root, `${pagePath}.js`))
  const payloads = []
  const page = Object.assign({}, definition, { route: pagePath, data: JSON.parse(JSON.stringify(definition.data || {})) })
  page.setData = (patch, callback) => {
    payloads.push({ bytes: bytes(patch), keys: Object.keys(patch) })
    Object.entries(patch).forEach(([key, value]) => {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = page.data
      parts.slice(0, -1).forEach(part => { target = target[part] })
      target[parts[parts.length - 1]] = value
    })
    if (callback) callback()
  }
  return { page, payloads }
}

async function measurePages(fixture, selectedPages) {
  const api = installWx(fixture)
  const instance = require('../services/repository-instance')
  instance.resetRepository()
  const storage = require('../services/storage')
  const originalStorage = storage.createMemoryStorage
  let reads = 0
  let clonedBytes = 0
  storage.createMemoryStorage = (...args) => {
    const current = originalStorage(...args)
    let size = bytes(args[0] || null)
    return { read() { const value = current.read(); reads += 1; clonedBytes += size; return value }, write(value) { size = bytes(value); current.write(value) } }
  }
  // cloud-repository captures storage imports, so reload it and the instance/context.
  ;['cloud-repository', 'repository-instance', 'page-context'].forEach(name => delete require.cache[require.resolve(`../services/${name}`)])
  const context = require('../services/page-context')
  const loadPage = context.loadPage
  let modelMs = 0
  context.loadPage = (page, callback, ...args) => loadPage(page, (...values) => {
    const start = performance.now()
    try { return callback(...values) } finally { modelMs += performance.now() - start }
  }, ...args)
  const pages = selectedPages || ['index', 'clients', 'client-ledger', 'statement', 'history', 'quick-entry', 'shipment-detail', 'payment-form', 'products', 'customer-prices', 'members', 'mine', 'audit-logs', 'client-form', 'product-form', 'enterprise', 'owner-transfer', 'help', 'data-settings', 'parser-test', 'unauthorized', 'join-enterprise', 'privacy-consent']
  const results = []
  for (const name of pages) {
    const pageName = name === 'historical-statement' ? 'statement' : name
    const { page, payloads } = instantiatePage(`pages/${pageName}/${pageName}`)
    if (page.initializePage) {
      const initialize = page.initializePage
      page.initializePage = function () { const start = performance.now(); try { return initialize.call(this) } finally { modelMs += performance.now() - start } }
    }
    const before = { calls: api.calls(), reads, clonedBytes, modelMs }
    const start = performance.now()
    const options = { id: name === 'shipment-detail' ? 'shipment_0' : 'client_0000', clientId: 'client_0000', inviteToken: '' }
    if (name === 'historical-statement') options.periodId = 'period_0_settled'
    if (page.onLoad) await page.onLoad(options)
    if (page.onShow) await page.onShow()
    await new Promise(resolve => setImmediate(resolve))
    const initialization = payloads.slice()
    const totalMs = performance.now() - start
    const initModelMs = modelMs - before.modelMs
    const initCalls = api.calls() - before.calls
    const initReads = reads - before.reads
    const initCloneBytes = clonedBytes - before.clonedBytes
    const rows = Object.fromEntries(Object.entries(page.data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]))
    while (page._progressiveModel) await new Promise(resolve => setTimeout(resolve, 1))
    const completeSetData = payloads.length
    const completePayloadBytes = payloads.reduce((sum, item) => sum + item.bytes, 0)
    const completeMaxPayloadBytes = Math.max(0, ...payloads.map(item => item.bytes))
    const completeRows = Object.fromEntries(Object.entries(page.data).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]))
    const returnCalls = api.calls()
    if (page.onShow) await page.onShow()
    await new Promise(resolve => setImmediate(resolve))
    results.push({ name, initCloudCalls: initCalls, returnCloudCalls: api.calls() - returnCalls, initSetData: initialization.length, maxPayloadBytes: Math.max(0, ...initialization.map(item => item.bytes)), totalPayloadBytes: initialization.reduce((sum, item) => sum + item.bytes, 0), completeSetData, completePayloadBytes, completeMaxPayloadBytes, completeRows, maxPayloadKeys: initialization.sort((a, b) => b.bytes - a.bytes)[0]?.keys || [], rootReads: initReads, rootCloneBytes: initCloneBytes, modelMs: initModelMs, localInitializationMs: totalMs, rows })
  }
  storage.createMemoryStorage = originalStorage
  context.loadPage = loadPage
  return { pages: results, loading: api.loading }
}

async function cloudWorker() {
  const fixture = createFixture(20, 40)
  const database = fakeDatabase(fixture, 3)
  const originalLoad = Module._load
  let excelLoads = 0
  Module._load = function (request, ...args) {
    if (request === 'wx-server-sdk') return { init() {}, database: () => database, getWXContext: () => ({ OPENID: fixture.openid }) }
    if (request === 'exceljs') excelLoads += 1
    return originalLoad.call(this, request, ...args)
  }
  const start = performance.now()
  const ledger = require('../cloudfunctions/ledger')
  const requireMs = performance.now() - start
  const moduleCount = Object.keys(require.cache).length
  const actionStart = performance.now()
  const response = await ledger.main({ action: 'bootstrap' })
  if (!response.ok) throw new Error(response.error)
  const result = { requireMs, moduleCount, excelLoads, bootstrapMs: performance.now() - actionStart, queries: database.queries, maxConcurrentQueries: database.maxActive(), responseBytes: bytes(response), snapshotBytes: bytes(response.snapshot), injectedQueryDelayMs: 3 }
  Module._load = originalLoad
  return result
}

function inventory() {
  const app = require('../app.json')
  const files = []
  function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(name)
      else files.push({ name, bytes: fs.statSync(path.join(root, name)).size })
    }
  }
  ;['pages', 'services', 'data', 'utils'].forEach(walk)
  ;['app.js', 'app.json', 'app.wxss', 'sitemap.json'].forEach(name => files.push({ name, bytes: fs.statSync(path.join(root, name)).size }))
  const pageScan = app.pages.map(name => {
    const source = fs.readFileSync(path.join(root, `${name}.js`), 'utf8')
    const wxml = fs.readFileSync(path.join(root, `${name}.wxml`), 'utf8')
    return { name, setDataSites: (source.match(/\.setData\(/g) || []).length, loops: [...wxml.matchAll(/<[^>]*wx:for=[\s\S]*?>/g)].map(item => item[0].replace(/\s+/g, ' ')), hiddenSites: (wxml.match(/\bhidden=/g) || []).length }
  })
  return { pageCount: app.pages.length, sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0), bytesByExtension: Object.fromEntries(['.js', '.wxml', '.wxss', '.json'].map(ext => [ext, files.filter(file => file.name.endsWith(ext)).reduce((sum, file) => sum + file.bytes, 0)])), largestFiles: files.sort((a, b) => b.bytes - a.bytes).slice(0, 12), pageScan }
}

async function main() {
  if (process.argv[2] === '--cloud-worker') { console.log(JSON.stringify(await cloudWorker())); return }
  if (process.argv[2] === '--module-worker') {
    const targets = { sdk: './cloudfunctions/ledger/node_modules/wx-server-sdk', excel: './cloudfunctions/ledger/node_modules/exceljs', frontend: './services/repository-instance' }
    const start = performance.now()
    require(path.join(root, targets[process.argv[3]]))
    const coldMs = performance.now() - start
    const warmStart = performance.now()
    require(path.join(root, targets[process.argv[3]]))
    console.log(JSON.stringify({ coldMs, warmMs: performance.now() - warmStart, modules: Object.keys(require.cache).length }))
    return
  }
  if (process.argv[2] === '--pages-worker') {
    console.log(JSON.stringify(await measurePages(createFixture(Number(process.argv[3]), Number(process.argv[4])), process.argv[5] ? process.argv[5].split(',') : undefined)))
    return
  }
  const cloud = Array.from({ length: 5 }, () => {
    const child = spawnSync(process.execPath, [__filename, '--cloud-worker'], { encoding: 'utf8' })
    if (child.status !== 0) throw new Error(child.stderr)
    return JSON.parse(child.stdout)
  })
  const fixture = createFixture()
  const modules = Object.fromEntries(['sdk', 'excel', 'frontend'].map(target => [target, Array.from({ length: 5 }, () => {
    const child = spawnSync(process.execPath, [__filename, '--module-worker', target], { encoding: 'utf8' })
    if (child.status !== 0) throw new Error(child.stderr)
    return JSON.parse(child.stdout)
  })]))
  const result = { measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, method: 'Synthetic fixtures; SDK stub for cloud actions; 3ms simulated DB latency; local Node timing only. Module cold samples use fresh processes. Page timings include read counters and simulated setData serialization, not rendering. Root byte size is measured once per snapshot write, not on every read.', fixture: { clients: fixture.snapshot.clients.length, shipments: fixture.snapshot.shipments.length, payments: fixture.snapshot.payments.length, periods: fixture.snapshot.billingPeriods.length, snapshotBytes: bytes(fixture.snapshot) }, cloud, modules, ...(await measurePages(fixture)), inventory: inventory() }
  const output = process.argv[2]
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  else console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { installWx, instantiatePage, measurePages, inventory }
