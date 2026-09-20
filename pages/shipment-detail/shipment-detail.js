const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')

const ACTION_NAMES = { CREATE_SHIPMENT: '创建发货记录', UPDATE_SHIPMENT: '修正发货记录' }

Page({
  data: { shipment: null, itemsSubtotal: '¥0.00', freight: '¥0.00', total: '¥0.00', lines: [], audits: [], canEdit: true },
  onLoad(options) { this.shipmentId = options.id || '' },
  onShow() {
    loadPage(this, (repository, tenantId) => {
      const shipment = repository.getShipment(tenantId, this.shipmentId)
      if (!shipment) {
        wx.showModal({
          title: '记录不存在', content: '该发货记录不存在，可能已随客户删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      const period = repository.getPeriodDetail(tenantId, shipment.periodId)
      const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
      this.setData({
        shipment: Object.assign({}, shipment, { createdByText: shipment.createdByNameSnapshot || '未记录' }),
        itemsSubtotal: formatCurrency(shipment.itemsSubtotalCents),
        freight: formatCurrency(shipment.freightCents),
        total: formatCurrency(shipment.totalAmountCents),
        canEdit: identity.role === 'admin' && !(period && period.period.isClosed),
        lines: shipment.lines.map(line => ({
          id: line.id, product: line.productSnapshot.label,
          quantity: `${line.originalQuantity}${line.originalUnit}`,
          pricingQuantity: `${line.pricingQuantity}${line.pricingUnit}`,
          conversion: line.conversion ? `1${line.conversion.fromUnit} = ${line.conversion.multiplier}${line.conversion.toUnit}` : '',
          price: `${formatCurrency(line.unitPriceCents)}/${line.pricingUnit}`,
          amount: formatCurrency(line.lineAmountCents)
        })),
        audits: repository.getAuditLogs(tenantId, shipment.id).map(log => ({
          id: log.id, name: ACTION_NAMES[log.action] || log.action, time: String(log.createdAt || '').replace('T', ' ').slice(0, 16),
          reason: log.reason || '', operator: log.performedByNameSnapshot || '未记录'
        }))
      })
    })
  },
  edit() { wx.navigateTo({ url: `/pages/quick-entry/quick-entry?shipmentId=${this.shipmentId}` }) }
})
