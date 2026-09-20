const { loadPage, handleMutation } = require('../../services/page-context')

function split(value) { return String(value || '').split(/[；;\n]/).map(item => item.trim()).filter(Boolean) }

Page({
  data: { id: '', name: '', aliasesText: '', note: '', active: true },
  onLoad(options) {
    this.productId = options.id || ''
    loadPage(this, (repository, tenantId) => {
      if (!this.productId) return
      const product = repository.listCustomProducts(tenantId, { includeInactive: true }).find(item => item.id === this.productId)
      if (product) this.setData({ id: product.id, name: product.name, aliasesText: (product.aliases || []).join('；'), note: product.note || '', active: product.active !== false })
    })
  },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  save() {
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = this.data.id
          ? repository.updateCustomProduct(tenantId, { confirmed: true, id: this.data.id, name: this.data.name, aliases: split(this.data.aliasesText), note: this.data.note, active: this.data.active })
          : repository.createCustomProduct(tenantId, { confirmed: true, name: this.data.name, aliases: split(this.data.aliasesText), recognitionKeywords: [], specialTags: [], note: this.data.note })
      } catch (error) { wx.showModal({ title: '无法保存', content: error.message, showCancel: false }); return }
      handleMutation(result, () => { wx.showToast({ title: '已保存' }); setTimeout(() => wx.navigateBack(), 400) })
    })
  }
})
