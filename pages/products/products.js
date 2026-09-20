const { loadPage, handleMutation } = require('../../services/page-context')
const { formatProductLabel } = require('../../data/product-specs')

Page({
  data: { tab: 'standard', keyword: '', allProducts: [], products: [] },
  onShow() { this.load() },
  load() {
    loadPage(this, (repository, tenantId) => {
      const allProducts = repository.listProducts(tenantId, { includeInactive: true }).map(item => ({
        id: item.id, label: formatProductLabel(item), isStandard: item.isStandard !== false,
        active: item.active !== false, note: item.note || '', search: [formatProductLabel(item)].concat(item.aliases || []).join(' ').toLowerCase()
      }))
      this.setData({ allProducts }, () => this.filter())
    })
  },
  changeTab(event) { this.setData({ tab: event.currentTarget.dataset.tab }, () => this.filter()) },
  onSearch(event) { this.setData({ keyword: event.detail.value }, () => this.filter()) },
  filter() {
    const keyword = String(this.data.keyword || '').trim().toLowerCase()
    this.setData({ products: this.data.allProducts.filter(item =>
      (this.data.tab === 'standard' ? item.isStandard : !item.isStandard) && (!keyword || item.search.includes(keyword))
    ).slice(0, 150) })
  },
  add() { wx.navigateTo({ url: '/pages/product-form/product-form' }) },
  edit(event) { if (this.data.tab === 'custom') wx.navigateTo({ url: `/pages/product-form/product-form?id=${event.currentTarget.dataset.id}` }) },
  toggle(event) {
    const id = event.currentTarget.dataset.id
    const product = this.data.allProducts.find(item => item.id === id)
    if (!product) return
    wx.showModal({
      title: product.active ? '停用产品' : '启用产品',
      content: product.active ? '停用后不能用于新账目，历史账单不受影响。' : '启用后可重新用于新账目。',
      confirmText: product.active ? '确认停用' : '确认启用',
      success: result => {
        if (!result.confirm) return
        loadPage(this, (repository, tenantId) => {
          let mutation
          try { mutation = repository.setProductActive(tenantId, id, !product.active) } catch (error) { wx.showModal({ title: '操作失败', content: error.message, showCancel: false }); return }
          handleMutation(mutation, () => this.load())
        })
      }
    })
  }
})
