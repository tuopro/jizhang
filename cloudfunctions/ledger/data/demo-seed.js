const { buildProductId } = require('./product-specs')

const DEMO_TENANT_ID = 'tenant_demo_cndes'
const DEMO_CLIENT_ID = 'client_hangzhou_xx'

function createDemoSeed() {
  return {
    enterprise: {
      id: DEMO_TENANT_ID,
      name: '演示企业（请勿录入真实账目）',
      defaultUnit: '米'
    },
    memberships: [
      {
        id: 'member_local_admin', tenantId: DEMO_TENANT_ID, displayName: '演示管理员',
        role: 'admin', status: 'active', joinedAt: '2026-09-18T00:00:00.000Z',
        createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z'
      }
    ],
    clients: [
      {
        id: DEMO_CLIENT_ID,
        name: '杭州XX电气',
        contact: '',
        phone: '',
        settlementType: '按次结清',
        settlementDay: null,
        note: '第一阶段验收演示客户',
        active: true
      }
    ],
    customProducts: [],
    customerPrices: [
      {
        id: 'price-demo-4040-open',
        clientId: DEMO_CLIENT_ID,
        productId: buildProductId(40, 40, '粗齿', '灰色'),
        unit: '米',
        unitPriceCents: 1250,
        active: true,
        updatedAt: '2026-09-18T00:00:00.000Z'
      },
      {
        id: 'price-demo-4040-open-white',
        clientId: DEMO_CLIENT_ID,
        productId: buildProductId(40, 40, '粗齿', '白色'),
        unit: '米',
        unitPriceCents: 680,
        active: true,
        updatedAt: '2026-09-18T00:00:00.000Z'
      },
      {
        id: 'price-demo-6040-fine',
        clientId: DEMO_CLIENT_ID,
        productId: buildProductId(60, 40, '细齿', '灰色'),
        unit: '米',
        unitPriceCents: 1860,
        active: true,
        updatedAt: '2026-09-18T00:00:00.000Z'
      }
    ],
    shipments: [],
    auditLogs: []
  }
}

module.exports = {
  DEMO_TENANT_ID,
  DEMO_CLIENT_ID,
  createDemoSeed
}
