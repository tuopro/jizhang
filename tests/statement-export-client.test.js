const test = require('node:test')
const assert = require('node:assert/strict')

const { buildStatementExportDocument, statementExportMeta } = require('../services/statement-export')
const { loadStatementExportDocument } = require('../services/statement-export-client')

function source() {
  const shipment = {
    id: 'shipment_1', tenantId: 'tenant_a', clientId: 'client_a', periodId: 'period_a',
    shipmentDate: '2026-09-20', clientNameSnapshot: '历史客户', status: 'posted',
    lines: [{
      id: 'line_1', productSnapshot: { label: '成交快照产品' },
      originalQuantity: 1, originalUnit: '根', pricingQuantity: 1, pricingUnit: '根',
      unitPriceCents: 1000, lineAmountCents: 1000
    }],
    itemsSubtotalCents: 1000, freightCents: 100, totalAmountCents: 1100
  }
  const payment = {
    id: 'payment_1', tenantId: 'tenant_a', clientId: 'client_a', periodId: 'period_a',
    paymentDate: '2026-09-21', amountCents: 500, method: '微信', status: 'posted'
  }
  return {
    enterprise: { id: 'tenant_a', name: '企业A' },
    client: { id: 'client_a', name: '当前客户' },
    period: {
      id: 'period_a', clientId: 'client_a', sequenceNo: 1, status: 'open', startAt: '2026-09-20',
      itemsSubtotalCents: 1000, freightCents: 100, shipmentTotalCents: 1100,
      receivedCents: 500, outstandingCents: 600
    },
    shipments: [shipment], payments: [payment], generatedAt: '2026-09-21T00:00:00.000Z'
  }
}

test('客户端只组装服务端账单分页，版本或金额变化会拒绝生成图片', async () => {
  const complete = buildStatementExportDocument(source())
  const repository = {
    getStatementExportMeta: () => Promise.resolve(statementExportMeta(complete)),
    getStatementExportPage(tenantId, request) {
      return Promise.resolve({
        resource: request.resource,
        items: request.resource === 'shipments' ? complete.shipments : complete.payments,
        nextOffset: request.resource === 'shipments' ? complete.shipments.length : complete.payments.length,
        hasMore: false
      })
    }
  }
  const result = await loadStatementExportDocument(repository, 'tenant_a', 'client_a', 'period_a')
  assert.equal(result.sourceVersion, complete.sourceVersion)
  assert.equal(result.shipments[0].lines[0].productSnapshot.label, '成交快照产品')

  const tampered = Object.assign({}, repository, {
    getStatementExportPage(tenantId, request) {
      const items = request.resource === 'shipments'
        ? [Object.assign({}, complete.shipments[0], { totalAmountCents: 9999 })]
        : complete.payments
      return Promise.resolve({ resource: request.resource, items, nextOffset: items.length, hasMore: false })
    }
  })
  await assert.rejects(
    loadStatementExportDocument(tampered, 'tenant_a', 'client_a', 'period_a'),
    /不一致|已更新/
  )
})
