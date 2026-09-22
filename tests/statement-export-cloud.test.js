const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  readStatementExportSource,
  getStatementExportMeta,
  getStatementExportPage
} = require('../cloudfunctions/ledger/services/statement-export-cloud')

function fakeDatabase(seed) {
  const collections = seed
  return {
    collection(name) {
      const rows = collections[name] || []
      return {
        doc(id) {
          return {
            async get() {
              const value = rows.find(item => item._id === id || item.id === id)
              if (!value) throw new Error('not found')
              return { data: value }
            }
          }
        },
        where(criteria) {
          let offset = 0
          let limit = 20
          const query = {
            skip(value) { offset = value; return query },
            limit(value) { limit = value; return query },
            async get() {
              const matches = rows.filter(item => Object.keys(criteria).every(key => item[key] === criteria[key]))
              return { data: matches.slice(offset, offset + limit) }
            }
          }
          return query
        }
      }
    }
  }
}

function line(index, cents) {
  return {
    id: `line_${index}`,
    productId: 'product_snapshot_only',
    productSnapshot: {
      label: `成交产品 ${index}`,
      name: `成交产品 ${index}`,
      height: 40,
      width: 40,
      color: '白色',
      toothType: '粗齿'
    },
    originalQuantity: 1,
    originalUnit: '根',
    pricingQuantity: 1,
    pricingUnit: '根',
    unitPriceCents: cents,
    lineAmountCents: cents
  }
}

function shipment(index, overrides) {
  return Object.assign({
    id: `shipment_${String(index).padStart(4, '0')}`,
    tenantId: 'tenant_a',
    clientId: 'client_a',
    clientNameSnapshot: '历史客户名称',
    periodId: 'period_a',
    shipmentDate: '2026-09-20',
    status: 'posted',
    lines: [line(index, 1)],
    itemsSubtotalCents: 1,
    freightCents: 0,
    totalAmountCents: 1,
    createdAt: `2026-09-20T00:00:${String(index % 60).padStart(2, '0')}.000Z`
  }, overrides || {})
}

function baseSeed(shipmentRows, paymentRows, periodOverrides) {
  return {
    enterprises: [{ id: 'tenant_a', tenantId: 'tenant_a', name: '德赛塑料' }],
    clients: [
      { id: 'client_a', tenantId: 'tenant_a', name: '当前客户名称', active: true },
      { id: 'client_b', tenantId: 'tenant_b', name: '其他企业客户', active: true }
    ],
    billing_periods: [Object.assign({
      id: 'period_a', tenantId: 'tenant_a', clientId: 'client_a', sequenceNo: 3,
      status: 'open', startAt: '2026-09-20T00:00:00.000Z',
      itemsSubtotalCents: shipmentRows.length,
      freightCents: 0,
      shipmentTotalCents: shipmentRows.length,
      receivedCents: (paymentRows || []).reduce((sum, item) => sum + item.amountCents, 0),
      outstandingCents: Math.max(0, shipmentRows.length - (paymentRows || []).reduce((sum, item) => sum + item.amountCents, 0))
    }, periodOverrides || {})],
    shipments: shipmentRows,
    payments: paymentRows || []
  }
}

test('账单服务按目标账期分页读取超过 1000 笔发货，不依赖 bootstrap 上限', async () => {
  const rows = Array.from({ length: 1005 }, (_, index) => shipment(index + 1))
  const rogue = shipment(9999, { id: 'rogue', tenantId: 'tenant_b', clientId: 'client_b' })
  const db = fakeDatabase(baseSeed(rows.concat(rogue), [], {
    itemsSubtotalCents: 1005,
    shipmentTotalCents: 1005,
    outstandingCents: 1005
  }))
  const source = await readStatementExportSource(db, 'tenant_a', {
    clientId: 'client_a', periodId: 'period_a', tenantId: 'tenant_b', role: 'admin', memberId: 'fake'
  }, '2026-09-21T00:00:00.000Z')
  assert.equal(source.shipments.length, 1005)
  assert.ok(source.shipments.every(item => item.tenantId === 'tenant_a'))
  const meta = await getStatementExportMeta(db, 'tenant_a', {
    clientId: 'client_a', periodId: 'period_a', tenantId: 'tenant_b'
  }, '2026-09-21T00:00:00.000Z')
  assert.equal(meta.counts.shipments, 1005)
  assert.equal(meta.totals.shipmentTotalCents, 1005)
})

test('分页 action 每批最多 100 条，并能连续读完目标账期', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => shipment(index + 1))
  const db = fakeDatabase(baseSeed(rows, []))
  const loaded = []
  let offset = 0
  let hasMore = true
  while (hasMore) {
    const page = await getStatementExportPage(db, 'tenant_a', {
      clientId: 'client_a', periodId: 'period_a', resource: 'shipments', offset, limit: 100
    })
    loaded.push(...page.items)
    offset = page.nextOffset
    hasMore = page.hasMore
  }
  assert.equal(loaded.length, 205)
  assert.equal(new Set(loaded.map(item => item.id)).size, 205)
  await assert.rejects(
    getStatementExportPage(db, 'tenant_a', {
      clientId: 'client_a', periodId: 'period_a', resource: 'shipments', offset: 0, limit: 101
    }),
    /最多读取 100 条/
  )
})

test('跨 tenant 客户、账期和伪造 tenantId 均不能改变服务端租户范围', async () => {
  const db = fakeDatabase(baseSeed([shipment(1)], []))
  await assert.rejects(
    getStatementExportMeta(db, 'tenant_a', {
      clientId: 'client_b', periodId: 'period_a', tenantId: 'tenant_b', role: 'admin', memberId: 'member_b'
    }),
    /客户不存在或无权访问/
  )
  const meta = await getStatementExportMeta(db, 'tenant_a', {
    clientId: 'client_a', periodId: 'period_a', tenantId: 'tenant_b', role: 'admin', memberId: 'member_b'
  }, '2026-09-21T00:00:00.000Z')
  assert.equal(meta.scope.clientId, 'client_a')
  assert.equal(meta.counts.shipments, 1)
})

test('旧账期按客户分页扫描并沿用 legacy periodId，不写回数据库', async () => {
  const old = shipment(1, {
    periodId: '', shipmentDate: '2025-12-08', itemsSubtotalCents: 1, totalAmountCents: 1
  })
  const seed = baseSeed([], [])
  seed.billing_periods = []
  seed.shipments = [old]
  const db = fakeDatabase(seed)
  const meta = await getStatementExportMeta(db, 'tenant_a', {
    clientId: 'client_a', periodId: 'legacy_client_a_2025-12'
  }, '2026-09-21T00:00:00.000Z')
  assert.equal(meta.scope.periodId, 'legacy_client_a_2025-12')
  assert.equal(meta.counts.shipments, 1)
  assert.equal(seed.billing_periods.length, 0)
})

test('已删除或停用的客户无法通过旧链接导出', async () => {
  const seed = baseSeed([shipment(1)], [])
  seed.clients[0].active = false
  const db = fakeDatabase(seed)
  await assert.rejects(
    getStatementExportMeta(db, 'tenant_a', { clientId: 'client_a', periodId: 'period_a' }),
    /已删除/
  )
})

test('账单导出读取服务保持只读，不访问当前产品或客户价格', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/ledger/services/statement-export-cloud.js'), 'utf8')
  assert.doesNotMatch(source, /\.(?:set|add|update)\s*\(\s*\{|\.remove\s*\(\s*\)|runTransaction/)
  assert.doesNotMatch(source, /customer_prices|collection\(['"]products['"]\)/)
  assert.match(source, /collectionName, field, value/)
})
