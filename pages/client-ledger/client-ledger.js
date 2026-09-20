const { loadPage, handleMutation, handleAccessError } = require('../../services/page-context')
const { canCloseBillingPeriod } = require('../../services/ledger-repository')
const { formatCurrency } = require('../../utils/money')

function localDateText(date) {
  const value = date || new Date()
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    clientId: '', client: null, periodId: '', periodTitle: '暂无进行中账期', periodRange: '',
    itemsSubtotal: '¥0.00', freightTotal: '¥0.00', shipmentTotal: '¥0.00', received: '¥0.00', outstanding: '¥0.00',
    shipmentCount: 0, shipments: [], payments: [], canReceivePayment: false, canSettle: false,
    showSettlementConfirm: false, closing: false, isAdmin: false,
    clientOwnerText: '未设置', periodOwnerText: '未设置',
    showDeleteConfirm: false, deletePreview: null, deleteConfirmName: '',
    deleteNameMatches: false, deleting: false
  },
  onLoad(options) { this.clientId = options.id || '' },
  onShow() {
    loadPage(this, (repository, tenantId) => {
      const ledger = repository.getClientLedger(tenantId, this.clientId)
      if (!ledger) {
        wx.showModal({
          title: '客户不存在', content: '该客户不存在或已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      const period = ledger.period
      const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
      const isAdmin = identity.role === 'admin'
      this.setData({
        clientId: this.clientId, client: ledger.client, periodId: period ? period.id : '',
        periodTitle: period ? `第${period.sequenceNo}期 · 进行中` : '暂无进行中账期',
        periodRange: period ? `${period.startDate} ～ 进行中` : '',
        itemsSubtotal: formatCurrency(ledger.itemsSubtotalCents), freightTotal: formatCurrency(ledger.freightCents),
        shipmentTotal: formatCurrency(ledger.shipmentTotalCents), received: formatCurrency(ledger.receivedCents),
        outstanding: formatCurrency(ledger.outstandingCents), shipmentCount: ledger.shipmentCount,
        canReceivePayment: Boolean(period && ledger.outstandingCents > 0),
        canSettle: Boolean(canCloseBillingPeriod(identity, period) && ledger.shipmentCount > 0 && ledger.outstandingCents === 0),
        isAdmin,
        clientOwnerText: ledger.client.ownerDisplayName || ledger.client.ownerNameSnapshot || '未设置',
        periodOwnerText: period && (period.ownerDisplayName || period.ownerNameSnapshot) || '未设置',
        shipments: ledger.shipments.map(item => ({
          id: item.id, date: item.shipmentDate, amount: formatCurrency(item.totalAmountCents),
          itemsSubtotal: formatCurrency(item.itemsSubtotalCents), freight: formatCurrency(item.freightCents),
          summary: item.lines.map(line => `${line.productSnapshot.label} ${line.originalQuantity}${line.originalUnit}`).join('；'),
          createdByText: item.createdByNameSnapshot || '未记录'
        })),
        payments: ledger.payments.map(item => ({
          id: item.id, date: item.paymentDate, method: item.method, amount: formatCurrency(item.amountCents), note: item.note,
          createdByText: item.createdByNameSnapshot || '未记录'
        }))
      })
      wx.setNavigationBarTitle({ title: ledger.client.name })
    })
  },
  quickEntry() { wx.navigateTo({ url: `/pages/quick-entry/quick-entry?clientId=${this.clientId}` }) },
  statement() { wx.navigateTo({ url: `/pages/statement/statement?clientId=${this.clientId}` }) },
  payment() { wx.navigateTo({ url: `/pages/payment-form/payment-form?clientId=${this.clientId}` }) },
  openSettlementConfirm() {
    if (this.data.canSettle) this.setData({ showSettlementConfirm: true })
  },
  deferSettlement() { this.setData({ showSettlementConfirm: false }) },
  confirmSettlement() {
    if (this.data.closing || !this.data.periodId) return
    this.setData({ closing: true })
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.closeBillingPeriod(tenantId, {
          confirmed: true,
          requestId: `close_period_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          clientId: this.clientId,
          periodId: this.data.periodId,
          closedDate: localDateText()
        })
      } catch (error) {
        this.setData({ closing: false })
        wx.showModal({ title: '无法结清', content: error.message, showCancel: false })
        return
      }
      handleMutation(result, () => {
        this.setData({ showSettlementConfirm: false, closing: false })
        wx.showModal({
          title: '本期已结清',
          content: '历史账单已生成。下一次发货会自动开启新一期。',
          showCancel: false,
          success: () => this.onShow()
        })
      }, error => {
        this.setData({ closing: false })
        wx.showModal({ title: '无法结清', content: error.message || '请稍后重试', showCancel: false })
      })
    })
  },
  prices() { wx.navigateTo({ url: `/pages/customer-prices/customer-prices?clientId=${this.clientId}` }) },
  editClient() { wx.navigateTo({ url: `/pages/client-form/client-form?id=${this.clientId}` }) },
  manageOwners() { wx.navigateTo({ url: `/pages/owner-transfer/owner-transfer?clientId=${this.clientId}` }) },
  openDelete() {
    loadPage(this, (repository, tenantId) => {
      let result
      try { result = repository.getClientDeletePreview(tenantId, this.clientId) } catch (error) {
        wx.showModal({ title: '无法删除', content: error.message, showCancel: false }); return
      }
      const onSuccess = preview => this.handleDeletePreview(preview)
      if (result && typeof result.then === 'function') {
        wx.showLoading({ title: '检查中' })
        result.then(preview => { wx.hideLoading(); onSuccess(preview) }).catch(error => {
          wx.hideLoading()
          if (handleAccessError(error)) return
          wx.showModal({ title: '无法删除', content: error.message || '请稍后重试', showCancel: false })
        })
      } else onSuccess(result)
    })
  },
  handleDeletePreview(preview) {
    if (!preview.canDelete) {
      wx.showModal({
        title: '不能删除',
        content: '该客户已有账务记录。\n\n普通成员不能删除已有账务记录的客户，请联系管理员处理。',
        showCancel: false
      })
      return
    }
    if (!preview.hasBusinessData) {
      wx.showModal({
        title: '确认删除客户',
        content: `确认删除“${preview.clientName}”？\n\n该客户尚无账务记录，删除后无法恢复。`,
        confirmText: '确认删除', confirmColor: '#c43d3d',
        success: modal => { if (modal.confirm) this.performDelete('') }
      })
      return
    }
    this.setData({
      showDeleteConfirm: true,
      deletePreview: Object.assign({}, preview, { outstandingText: formatCurrency(preview.outstandingAmountCents) }),
      deleteConfirmName: '', deleteNameMatches: false
    })
  },
  onDeleteNameInput(event) {
    const value = event.detail.value
    this.setData({
      deleteConfirmName: value,
      deleteNameMatches: Boolean(this.data.deletePreview && value === this.data.deletePreview.clientName)
    })
  },
  closeDeleteConfirm() {
    if (!this.data.deleting) this.setData({ showDeleteConfirm: false, deletePreview: null, deleteConfirmName: '', deleteNameMatches: false })
  },
  confirmStrongDelete() {
    if (!this.data.deleteNameMatches || this.data.deleting) return
    this.performDelete(this.data.deleteConfirmName)
  },
  performDelete(confirmationName) {
    if (this.data.deleting) return
    this.setData({ deleting: true })
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.deleteClient(tenantId, {
          confirmed: true, clientId: this.clientId, confirmationName
        })
      } catch (error) {
        this.setData({ deleting: false })
        wx.showModal({ title: '删除失败', content: error.message, showCancel: false })
        return
      }
      handleMutation(result, () => {
        this.setData({ deleting: false, showDeleteConfirm: false })
        wx.showModal({
          title: '客户已删除', content: '客户及允许删除的客户专属数据已清理，删除摘要审计已保留。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
      }, error => {
        this.setData({ deleting: false })
        wx.showModal({ title: '删除失败', content: error.message || '未删除任何数据，请重新检查后再试', showCancel: false })
      })
    })
  },
  openShipment(event) { wx.navigateTo({ url: `/pages/shipment-detail/shipment-detail?id=${event.currentTarget.dataset.id}` }) }
})
