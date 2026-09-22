const { loadPage, handleMutation } = require('../../services/page-context')

function split(value) { return String(value || '').split(/[；;\n]/).map(item => item.trim()).filter(Boolean) }

Page({
  data: { id: '', name: '', aliasesText: '', note: '', active: true, isAdmin: false },
  onLoad(options) {
    this.productId = options.id || ''
    loadPage(this, (repository, tenantId) => {
      if (!this.requireProductAdmin(repository)) return
      if (!this.productId) return
      const product = repository.listCustomProducts(tenantId, { includeInactive: true }).find(item => item.id === this.productId)
      if (product) this.setData({ id: product.id, name: product.name, aliasesText: (product.aliases || []).join('；'), note: product.note || '', active: product.active !== false })
    })
  },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  requireProductAdmin(repository) {
    const isAdmin = !repository.isCloudRepository || repository.getIdentity().role === 'admin'
    this.setData({ isAdmin })
    if (!isAdmin) wx.showModal({ title: '无权管理产品', content: '产品管理仅限管理员。', showCancel: false, success: () => wx.navigateBack() })
    return isAdmin
  },
  save() {
    loadPage(this, (repository, tenantId) => {
      if (!this.requireProductAdmin(repository)) return
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
