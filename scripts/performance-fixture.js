// Synthetic data only: never reads the deployed database or a user's local storage.
const crypto = require('node:crypto')

function createFixture(clientCount = 200, shipmentCount = 1000) {
  const tenantId = 'tenant_performance_fixture'
  const openid = 'synthetic_performance_identity'
  const memberId = `member_${crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24)}`
  const timestamp = '2026-09-20T08:00:00.000Z'
  const identity = { tenantId, memberId, displayName: '测量成员', role: 'admin', status: 'active', enterpriseName: '合成性能样本' }
  const snapshot = {
    enterprise: { id: tenantId, tenantId, name: identity.enterpriseName, defaultUnit: '米' },
    memberships: [{ id: memberId, tenantId, openid, displayName: identity.displayName, role: 'admin', status: 'active', createdAt: timestamp }],
    clients: [], customProducts: [], customerPrices: [], shipments: [], payments: [], billingPeriods: [], auditLogs: []
  }
  for (let i = 0; i < clientCount; i += 1) {
    const id = `client_${String(i).padStart(4, '0')}`
    snapshot.clients.push({ id, tenantId, name: `合成客户${String(i).padStart(4, '0')}`, contact: '联系人', phone: '', note: '自动性能测量，非正式客户', active: true, ownerMemberId: memberId, ownerNameSnapshot: identity.displayName, createdAt: timestamp })
    ;['open', 'settled'].forEach((status, n) => {
      snapshot.billingPeriods.push({ id: `period_${i}_${status}`, tenantId, clientId: id, sequenceNo: n === 0 ? 2 : 1, status, startAt: n === 0 ? timestamp : '2026-08-01T08:00:00.000Z', closedAt: n === 0 ? '' : '2026-08-31T08:00:00.000Z', ownerMemberId: memberId, ownerNameSnapshot: identity.displayName, createdAt: timestamp })
    })
  }
  for (let i = 0; i < shipmentCount; i += 1) {
    const client = snapshot.clients[i % clientCount]
    const periodId = `period_${i % clientCount}_${Math.floor(i / clientCount) % 3 === 1 ? 'settled' : 'open'}`
    const shipment = {
      id: `shipment_${i}`, tenantId, clientId: client.id, clientNameSnapshot: client.name, periodId,
      shipmentDate: periodId.endsWith('settled') ? '2026-08-20' : '2026-09-20', status: 'posted',
      itemsSubtotalCents: 2500, freightCents: 500, totalAmountCents: 3000,
      createdByNameSnapshot: identity.displayName, createdAt: timestamp, logistics: { provider: '自提', raw: '自提' }, note: '',
      lines: [0, 1].map(j => ({ id: `line_${i}_${j}`, productId: 'standard_40_40_coarse_gray', productSnapshot: { label: '40×40 / 粗齿 / 灰色', name: '线槽', height: 40, width: 40, color: '灰色', toothType: '粗齿' }, originalQuantity: 1, originalUnit: '米', pricingQuantity: 1, pricingUnit: '米', unitPriceCents: 1250, lineAmountCents: 1250 }))
    }
    snapshot.shipments.push(shipment)
    snapshot.payments.push({ id: `payment_${i}`, tenantId, clientId: client.id, periodId, paymentDate: shipment.shipmentDate, amountCents: periodId.endsWith('settled') ? 3000 : 500, method: '银行转账', status: 'posted', createdAt: timestamp, createdByNameSnapshot: identity.displayName, note: '' })
    snapshot.auditLogs.push({ id: `audit_${i}`, tenantId, action: 'CREATE_SHIPMENT', entityId: shipment.id, createdAt: timestamp, performedByNameSnapshot: identity.displayName, after: shipment })
  }
  return { tenantId, openid, identity, snapshot }
}

function fakeDatabase(fixture, delayMs = 0) {
  const s = fixture.snapshot
  const rows = { enterprises: [s.enterprise], memberships: s.memberships, clients: s.clients, products: s.customProducts, customer_prices: s.customerPrices, shipments: s.shipments, payments: s.payments, billing_periods: s.billingPeriods, audit_logs: s.auditLogs }
  const queries = []
  let active = 0
  let maxActive = 0
  async function read(name, criteria, documentId, offset, limit) {
    queries.push({ name, criteria, documentId })
    active += 1
    maxActive = Math.max(maxActive, active)
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    else await Promise.resolve()
    active -= 1
    const found = (rows[name] || []).filter(row => documentId ? row.id === documentId : Object.keys(criteria || {}).every(key => row[key] === criteria[key]))
    if (documentId && !found.length) throw new Error('not found')
    return { data: JSON.parse(JSON.stringify(documentId ? found[0] : found.slice(offset, offset + limit))) }
  }
  return {
    queries, rows, maxActive: () => maxActive,
    collection(name) {
      return {
        doc(id) { return { get: () => read(name, null, id, 0, 1) } },
        where(criteria) {
          let offset = 0; let limit = 20
          const query = { skip(value) { offset = value; return query }, limit(value) { limit = value; return query }, get: () => read(name, criteria, null, offset, limit) }
          return query
        }
      }
    },
    // No writes in this harness. Any accidental mutation fails immediately.
    runTransaction() { throw new Error('Performance fixture does not permit writes') }
  }
}

module.exports = { createFixture, fakeDatabase }
