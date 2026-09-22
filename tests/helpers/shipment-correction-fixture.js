const { createMemoryStorage } = require('../../services/storage')
const { createLedgerRepository } = require('../../services/ledger-repository')
const { buildProductId } = require('../../data/product-specs')

const tenantId = 'tenant_a'
const copy = value => JSON.parse(JSON.stringify(value))

function setup(creator = 'admin') {
  const storage = createMemoryStorage()
  let sequence = 0
  const members = Object.fromEntries(['admin', 'owner', 'other', 'creator'].map(name => [name, {
    id: `member_${name}`, openid: `openid_${name}`, tenantId,
    displayName: `测试${name}`, role: name === 'admin' ? 'admin' : 'member', status: 'active'
  }]))
  const repositories = Object.fromEntries(Object.entries(members).map(([name, actor]) => [name,
    createLedgerRepository(storage, {
      actor, now: () => new Date('2026-09-21T08:00:00.000Z'), makeId: prefix => `${prefix}_${++sequence}`
    })
  ]))
  repositories.admin.initializeTenant(tenantId, {
    enterprise: { id: tenantId, name: '修正测试企业' }, memberships: Object.values(members)
  })
  const client = repositories.admin.saveClient(tenantId, { confirmed: true, name: '修正测试客户' })
  repositories.admin.updateClientOwner(tenantId, {
    confirmed: true, clientId: client.id, ownerMemberId: members.owner.id, updateOpenPeriod: false
  })
  const item = {
    productId: buildProductId(40, 40, '粗齿', '白色'), quantityText: '10', orderUnit: '米', pricingUnit: '米', unitPriceYuan: '10'
  }
  const shipment = repositories[creator].postShipment(tenantId, {
    confirmed: true, requestId: 'original-shipment', clientId: client.id,
    shipmentDate: '2026-09-21', freightYuan: '2.50', items: [item]
  })
  repositories.admin.updateBillingPeriodOwner(tenantId, {
    confirmed: true, periodId: shipment.periodId, ownerMemberId: members.other.id
  })
  const change = callback => {
    const root = storage.read()
    callback(root.tenants[tenantId], root)
    storage.write(root)
  }
  return {
    storage, members, repositories, client, shipment, item, change,
    payload: extra => Object.assign({ confirmed: true, reason: '核对数量修正', freightYuan: '3.25', items: [copy(item)] }, extra)
  }
}

module.exports = { tenantId, copy, setup }
