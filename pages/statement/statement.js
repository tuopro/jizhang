const { loadPage, handleAccessError } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')
const { setProgressiveModel, cancelProgressiveModel } = require('../../services/progressive-list')
const {
  createAndDownloadExcel,
  openExcelFile,
  shareExcelFile
} = require('../../services/excel-export-client')

Page({
  data: { client: null, period: null, periodTitle: '', periodLabel: '', periodOwnerText: '未设置', isClosed: false, canExport: false, openingImageExport: false, exportingExcel: false, excelProgress: '', excelReady: false, excelFileName: '', shipments: [], payments: [], itemsSubtotal: '¥0.00', freightTotal: '¥0.00', total: '¥0.00', received: '¥0.00', outstanding: '¥0.00' },
  onLoad(options) { this.clientId = options.clientId || ''; this.periodId = options.periodId || ''; this.load() },
  onShow() { this.setData({ openingImageExport: false }) },
  onUnload() { this.excelPageUnloaded = true; cancelProgressiveModel(this) },
  load() {
    loadPage(this, (repository, tenantId) => {
      this.repository = repository
      this.tenantId = tenantId
      const statement = repository.getStatement(tenantId, this.clientId, this.periodId)
      if (!statement) {
        wx.showModal({
          title: '账单不存在', content: '该客户或账期不存在，可能已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      setProgressiveModel(this, {
        client: statement.client, period: statement.period,
        periodTitle: statement.period ? `第${statement.period.sequenceNo}期` : '暂无进行中账期',
        periodLabel: statement.periodLabel,
        periodOwnerText: statement.period && (statement.period.ownerDisplayName || statement.period.ownerNameSnapshot) || '未设置',
        isClosed: Boolean(statement.period && statement.period.isClosed),
        canExport: Boolean(statement.period),
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
      }, ['shipments', 'payments'])
      wx.setNavigationBarTitle({ title: statement.period && statement.period.isClosed ? '历史账单' : '对账单' })
    })
  },
  generateShareImages() {
    const period = this.data.period
    if (!period || this.data.openingImageExport) return
    this.setData({ openingImageExport: true })
    wx.navigateTo({
      url: `/pages/statement-export/statement-export?clientId=${encodeURIComponent(this.clientId)}&periodId=${encodeURIComponent(period.id)}`,
      fail: () => {
        this.setData({ openingImageExport: false })
        wx.showModal({ title: '无法打开', content: '请稍后重试。', showCancel: false })
      }
    })
  },
  exportExcel() {
    const period = this.data.period
    if (!period || this.data.exportingExcel || !this.repository) return
    this.setData({ exportingExcel: true, excelProgress: '准备导出…' })
    wx.showLoading({ title: '生成 Excel', mask: true })
    createAndDownloadExcel(
      this.repository,
      this.tenantId,
      this.clientId,
      period.id,
      wx,
      progress => { if (!this.excelPageUnloaded) this.setData({ excelProgress: progress }) }
    ).then(file => {
      if (this.excelPageUnloaded) return
      this.excelFile = file
      this.setData({
        excelReady: true,
        excelFileName: file.fileName,
        excelProgress: 'Excel 已准备好，可打开或发送'
      })
      return openExcelFile(wx, file.filePath)
    }).then(() => {
      wx.hideLoading()
      if (this.excelPageUnloaded) return
      this.setData({ exportingExcel: false })
    }, error => {
      wx.hideLoading()
      if (this.excelPageUnloaded) return
      if (handleAccessError(error)) return
      wx.showModal({ title: 'Excel 导出失败', content: error.message || '请检查网络后重试', showCancel: false })
      this.setData({ exportingExcel: false })
    })
  },
  openExcel() {
    if (!this.excelFile || this.data.exportingExcel) return
    openExcelFile(wx, this.excelFile.filePath).catch(error => {
      wx.showModal({ title: '无法打开 Excel', content: error.message || '临时文件可能已过期，请重新导出', showCancel: false })
    })
  },
  shareExcel() {
    if (!this.excelFile || this.data.exportingExcel) return
    if (typeof wx.shareFileMessage !== 'function') {
      this.openExcel()
      return
    }
    shareExcelFile(wx, this.excelFile.filePath, this.excelFile.fileName).catch(error => {
      const message = String(error && error.errMsg || '')
      if (/cancel/i.test(message)) return
      wx.showModal({ title: '无法发送 Excel', content: '请先打开文件，再使用右上角菜单转发。', showCancel: false })
    })
  }
})
