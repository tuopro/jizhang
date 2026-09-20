const { parseOrderText } = require('../../services/order-parser')
const { getRepository, getActiveTenantId } = require('../../services/repository-instance')
const { loadPage } = require('../../services/page-context')
const { canShowDeveloperTools } = require('../../services/runtime-flags')

const SAMPLE_TEXT = '4040开口白色100\n6040细齿蓝色50米\n白色装潢1515-1.3米长 50根'

Page({
  data: {
    sourceText: SAMPLE_TEXT,
    items: [],
    logisticsText: '无',
    unmatchedLines: [],
    parsed: false
  },

  onLoad() {
    loadPage(this, repository => {
      const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
      if (!canShowDeveloperTools(identity)) {
        wx.showModal({
          title: '页面不可用',
          content: '开发测试页仅在开发版对管理员开放。',
          showCancel: false,
          success: () => wx.switchTab({ url: '/pages/mine/mine' })
        })
        return
      }
      this.runParse()
    })
  },

  onTextInput(event) {
    this.setData({ sourceText: event.detail.value })
  },

  runParse() {
    const result = parseOrderText(this.data.sourceText, {
      customProducts: getRepository().listCustomProducts(getActiveTenantId())
    })
    this.setData({
      parsed: true,
      items: result.items.map((item, index) => ({
        index: index + 1,
        productLabel: item.productLabel,
        specialLengthText: item.productLengthMeters ? `${item.productLengthMeters}米/根` : '',
        quantityText: item.quantityText || '未识别',
        unit: item.unit,
        statusText: item.status === 'matched' ? '已匹配' : '需要确认',
        statusClass: item.status === 'matched' ? 'success-text' : 'warning-text',
        issues: item.issues.map(issue => issue.message),
        sourceText: item.sourceText
      })),
      logisticsText: result.logistics.provider || result.logistics.raw || '无',
      unmatchedLines: result.unmatchedLines
    })
  }
})
