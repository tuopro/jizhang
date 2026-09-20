const { loadPage, handleMutation } = require('../../services/page-context')
const { canCloseBillingPeriod } = require('../../services/ledger-repository')
const { centsToYuan, formatCurrency } = require('../../utils/money')

function settlementPermissionText(period) {
  const ownerName = period && (period.ownerDisplayName || period.ownerNameSnapshot)
  return ownerName && ownerName !== '未设置'
    ? `该账期由${ownerName}负责，仅账期负责人或管理员可以结清。`
    : '仅账期负责人或管理员可以结清。'
}

Page({
  data: {
    client: null, periodId: '', shipmentTotal: '¥0.00', received: '¥0.00', outstanding: '¥0.00',
    amountYuan: '', paymentDate: '', methods: ['微信', '支付宝', '银行转账', '现金', '其他'], methodIndex: 2, note: '',
    showSettlementConfirm: false, closing: false, canSettle: false, periodOwnerText: '未设置'
  },
  onLoad(options) { this.clientId = options.clientId || ''; this.load() },
  load() {
    loadPage(this, (repository, tenantId) => {
      const ledger = repository.getClientLedger(tenantId, this.clientId)
      if (!ledger || !ledger.period || ledger.outstandingCents <= 0) {
        wx.showModal({ title: '无需收款', content: '该客户当前没有未结应收。', showCancel: false, success: () => wx.navigateBack() }); return
      }
      const today = new Date().toISOString().slice(0, 10)
      const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
      this.setData({
        client: ledger.client, periodId: ledger.period.id,
        shipmentTotal: formatCurrency(ledger.shipmentTotalCents), received: formatCurrency(ledger.receivedCents), outstanding: formatCurrency(ledger.outstandingCents),
        amountYuan: centsToYuan(ledger.outstandingCents), paymentDate: today,
        canSettle: canCloseBillingPeriod(identity, ledger.period),
        periodOwnerText: ledger.period.ownerDisplayName || ledger.period.ownerNameSnapshot || '未设置'
      })
    })
  },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  onDate(event) { this.setData({ paymentDate: event.detail.value }) },
  onMethod(event) { this.setData({ methodIndex: Number(event.detail.value) }) },
  fillAll() { this.setData({ amountYuan: this.data.outstanding.replace('¥', '').replace(/,/g, '') }) },
  submit() {
    wx.showModal({
      title: '确认收款', content: `${this.data.client.name}\n收款 ¥${this.data.amountYuan}\n确认后将计入本期账单。`, confirmText: '确认收款', confirmColor: '#123B67',
      success: modal => { if (modal.confirm) this.postPayment() }
    })
  },
  postPayment() {
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.recordPayment(tenantId, {
          confirmed: true, requestId: `payment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          clientId: this.clientId, periodId: this.data.periodId, amountYuan: this.data.amountYuan,
          paymentDate: this.data.paymentDate, method: this.data.methods[this.data.methodIndex], note: this.data.note
        })
      } catch (error) { wx.showModal({ title: '无法收款', content: error.message, showCancel: false }); return }
      handleMutation(result, payment => {
        if (payment.needsSettlementConfirmation || payment.remainingCents === 0) {
          const latestLedger = repository.getClientLedger(tenantId, this.clientId)
          const latestPeriod = latestLedger && latestLedger.period
          const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
          const canSettle = canCloseBillingPeriod(identity, latestPeriod)
          this.setData({
            canSettle,
            periodOwnerText: latestPeriod && (latestPeriod.ownerDisplayName || latestPeriod.ownerNameSnapshot) || '未设置',
            showSettlementConfirm: canSettle
          })
          if (!canSettle) {
            wx.showModal({
              title: '收款已记录',
              content: `本期已收齐。${settlementPermissionText(latestPeriod)}`,
              showCancel: false,
              success: () => wx.navigateBack()
            })
          }
          return
        }
        wx.showModal({ title: '收款已记录', content: `剩余应收 ${formatCurrency(payment.remainingCents)}`, showCancel: false, success: () => wx.navigateBack() })
      })
    })
  },
  deferSettlement() {
    this.setData({ showSettlementConfirm: false })
    wx.navigateBack()
  },
  confirmSettlement() {
    if (this.data.closing) return
    if (!this.data.canSettle) {
      wx.showModal({
        title: '无法结清',
        content: this.data.periodOwnerText !== '未设置'
          ? `该账期由${this.data.periodOwnerText}负责，仅账期负责人或管理员可以结清。`
          : '仅账期负责人或管理员可以结清。',
        showCancel: false
      })
      return
    }
    this.setData({ closing: true })
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.closeBillingPeriod(tenantId, {
          confirmed: true,
          requestId: `close_period_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          clientId: this.clientId,
          periodId: this.data.periodId,
          closedDate: this.data.paymentDate
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
          success: () => wx.navigateBack()
        })
      }, error => {
        this.setData({ closing: false })
        wx.showModal({ title: '无法结清', content: error.message || '请稍后重试', showCancel: false })
      })
    })
  }
})
