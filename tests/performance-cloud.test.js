const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const { createFixture, fakeDatabase } = require('../scripts/performance-fixture')

async function withLedger(callback) {
  const fixture = createFixture(2, 4)
  const db = fakeDatabase(fixture)
  const loads = []
  const original = Module._load
  const prefix = path.resolve(__dirname, '../cloudfunctions/ledger')
  Object.keys(require.cache).filter(name => name.startsWith(prefix) && !name.includes('node_modules')).forEach(name => delete require.cache[name])
  const cloud = {
    init() {}, database: () => db, getWXContext: () => ({ OPENID: fixture.openid }),
    uploadFile: async () => ({ fileID: 'cloud://synthetic/export.xlsx' }),
    deleteFile: async () => ({ fileList: [{ status: 0 }] })
  }
  Module._load = function (request, ...args) {
    loads.push(request)
    if (request === 'wx-server-sdk') return cloud
    return original.call(this, request, ...args)
  }
  try { await callback({ ledger: require('../cloudfunctions/ledger'), fixture, db, loads, cloud }) }
  finally { Module._load = original }
}

test('普通 ledger action 和临时文件清理不加载 ExcelJS 或工作簿模块', async () => {
  await withLedger(async ({ ledger, fixture, loads, db }) => {
    db.runTransaction = async callback => callback(db)
    for (const action of ['bootstrap', 'saveClient', 'postShipment', 'recordPayment', 'closeBillingPeriod', 'getClientDeletePreview', 'getStatementExportMeta', 'getStatementExportPage', 'cleanupStatementExportFile']) {
      await ledger.main({ action, payload: { args: ['client_0000'], clientId: 'client_0000', periodId: 'period_0_open', resource: 'shipments', offset: 0, limit: 100, fileID: 'cloud://synthetic/invalid.xlsx' } })
      assert.ok(!loads.includes('exceljs'), action)
      assert.ok(!loads.some(name => /statement-excel/.test(name)), action)
    }
    const { cloudPrefix } = require('../cloudfunctions/ledger/services/statement-export-file')
    const cleaned = await ledger.main({ action: 'cleanupStatementExportFile', payload: { fileID: `cloud://synthetic/${cloudPrefix(fixture.snapshot.memberships[0])}sample.xlsx` } })
    assert.equal(cleaned.ok, true)
    assert.ok(!loads.includes('exceljs'))
  })
})

test('bootstrap 在真实成员检查和企业读取后并行8个同tenant集合，返回快照保持脱敏', async () => {
  await withLedger(async ({ ledger, fixture, db }) => {
    const result = await ledger.main({ action: 'bootstrap', tenantId: 'forged', payload: { tenantId: 'forged', role: 'admin' } })
    assert.equal(result.ok, true)
    assert.equal(db.queries.length, 10)
    assert.equal(db.queries[0].name, 'memberships')
    assert.equal(db.queries[0].documentId, fixture.identity.memberId)
    assert.equal(db.queries[1].name, 'enterprises')
    assert.equal(db.maxActive(), 8)
    db.queries.slice(2).forEach(query => assert.deepEqual(query.criteria, { tenantId: fixture.tenantId }))
    const { clientSnapshot } = require('../cloudfunctions/ledger/services/client-snapshot')
    assert.deepEqual(result.snapshot, clientSnapshot(fixture.snapshot))
    assert.ok(!JSON.stringify(result.snapshot).includes(fixture.openid))
  })
})

test('失效成员在任何tenant读取和Excel require之前拒绝', async () => {
  await withLedger(async ({ ledger, fixture, db, loads }) => {
    fixture.snapshot.memberships[0].status = 'disabled'
    for (const action of ['bootstrap', 'createStatementExcel', 'saveClient']) {
      const response = await ledger.main({ action })
      assert.equal(response.code, 'MEMBERSHIP_DISABLED')
    }
    assert.ok(db.queries.every(query => query.name === 'memberships' && query.documentId))
    assert.ok(!loads.some(name => /statement-export-file|statement-excel|exceljs/.test(name)))
  })
})

test('事务内仍重新检查成员并串行读取快照', async () => {
  await withLedger(async ({ ledger, db }) => {
    db.runTransaction = async callback => callback(db)
    const response = await ledger.main({ action: 'recordPayment', payload: { args: [{}] } })
    assert.equal(response.ok, false) // Missing confirmation still rejected by the original domain contract.
    assert.equal(db.queries.filter(query => query.documentId && query.name === 'memberships').length, 2)
    assert.equal(db.queries.length, 11)
    assert.equal(db.maxActive(), 1)
  })
})

test('只有有效 createStatementExcel 加载工作簿和ExcelJS；继续生成真实xlsx', async () => {
  await withLedger(async ({ ledger, loads, cloud }) => {
    let uploaded = false
    cloud.uploadFile = async ({ fileContent }) => {
      assert.equal(fileContent.subarray(0, 2).toString(), 'PK')
      uploaded = true
      return { fileID: 'cloud://synthetic/generated.xlsx' }
    }
    const response = await ledger.main({ action: 'createStatementExcel', payload: { clientId: 'client_0000', periodId: 'period_0_open' } })
    assert.equal(response.ok, true, response.error)
    assert.equal(uploaded, true)
    assert.ok(loads.includes('exceljs'))
    assert.ok(loads.some(name => /statement-excel/.test(name)))
  })
})
