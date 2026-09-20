const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')

Page({
  data: { client: null, period: null, periodTitle: '', periodLabel: '', periodOwnerText: '未设置', isClosed: false, shipments: [], payments: [], itemsSubtotal: '¥0.00', freightTotal: '¥0.00', total: '¥0.00', received: '¥0.00', outstanding: '¥0.00' },
  onLoad(options) { this.clientId = options.clientId || ''; this.periodId = options.periodId || ''; this.load() },
  load() {
    loadPage(this, (repository, tenantId) => {
      const statement = repository.getStatement(tenantId, this.clientId, this.periodId)
      if (!statement) {
        wx.showModal({
          title: '账单不存在', content: '该客户或账期不存在，可能已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      this.setData({
        client: statement.client, period: statement.period,
        periodTitle: statement.period ? `第${statement.period.sequenceNo}期` : '暂无进行中账期',
        periodLabel: statement.periodLabel,
        periodOwnerText: statement.period && (statement.period.ownerDisplayName || statement.period.ownerNameSnapshot) || '未设置',
        isClosed: Boolean(statement.period && statement.period.isClosed),
        shipments: statement.shipments.map(shipment => ({
          id: shipment.id, date: shipment.shipmentDate,
          itemsSubtotal: formatCurrency(shipment.itemsSubtotalCents),
          freight: formatCurrency(shipment.freightCents),
          total: formatCurrency(shipment.totalAmountCents),
          createdByText: shipment.createdByNameSnapshot || '未记录',
          lines: shipment.lines.map(line => ({
            id: line.id, product: line.productSnapshot.label,
            quantity: `${line.originalQuantity}${line.originalUnit}`,
            price: `${formatCurrency(line.unitPriceCents)}/${line.pricingUnit}`,
            amount: formatCurrency(line.lineAmountCents)
          }))
        })),
        payments: statement.payments.map(payment => ({ id: payment.id, date: payment.paymentDate, method: payment.method, amount: formatCurrency(payment.amountCents), note: payment.note, createdByText: payment.createdByNameSnapshot || '未记录' })),
        itemsSubtotal: formatCurrency(statement.totals.itemsSubtotalCents),
        freightTotal: formatCurrency(statement.totals.freightCents),
        total: formatCurrency(statement.totals.shipmentTotalCents), received: formatCurrency(statement.totals.receivedCents), outstanding: formatCurrency(statement.totals.outstandingCents)
      })
      wx.setNavigationBarTitle({ title: statement.period && statement.period.isClosed ? '历史账单' : '对账单' })
    })
  }
})
