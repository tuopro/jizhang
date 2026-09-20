const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')

Page({
  data: {
    enterpriseName: '', totalOutstanding: '¥0.00', unsettledClientCount: 0,
    owingClients: [], recentShipments: [], recentPayments: []
  },

  onShow() {
    loadPage(this, (repository, tenantId) => {
      const dashboard = repository.getDashboard(tenantId)
      const enterprise = repository.getEnterprise(tenantId)
      this.setData({
        enterpriseName: enterprise.name,
        totalOutstanding: formatCurrency(dashboard.totalOutstandingCents),
        unsettledClientCount: dashboard.unsettledClientCount,
        owingClients: dashboard.clients.filter(item => item.outstandingCents > 0).map(item => ({
          id: item.client.id, name: item.client.name,
          outstanding: formatCurrency(item.outstandingCents), shipmentCount: item.shipmentCount
        })).slice(0, 4),
        recentShipments: dashboard.recentShipments.map(item => ({
          id: item.id, clientName: item.clientNameSnapshot, shipmentDate: item.shipmentDate,
          amount: formatCurrency(item.totalAmountCents),
          summary: item.lines.map(line => line.productSnapshot.label).join('；')
        })),
        recentPayments: dashboard.recentPayments.map(item => ({
          id: item.id, clientName: item.clientNameSnapshot, paymentDate: item.paymentDate,
          amount: formatCurrency(item.amountCents), method: item.method
        }))
      })
    })
  },

  goToQuickEntry() { wx.navigateTo({ url: '/pages/quick-entry/quick-entry' }) },
  goToClients() { wx.switchTab({ url: '/pages/clients/clients' }) },
  openClient(event) { wx.navigateTo({ url: `/pages/client-ledger/client-ledger?id=${event.currentTarget.dataset.id}` }) },
  openShipment(event) { wx.navigateTo({ url: `/pages/shipment-detail/shipment-detail?id=${event.currentTarget.dataset.id}` }) }
})
