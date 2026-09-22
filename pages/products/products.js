const { loadPage, handleMutation } = require('../../services/page-context')
const { formatProductLabel } = require('../../data/product-specs')

Page({
  data: { tab: 'standard', keyword: '', products: [] },
  onShow() { this.load() },
  load() {
    loadPage(this, (repository, tenantId) => {
      this.allProducts = repository.listProducts(tenantId, { includeInactive: true }).map(item => {
        const label = formatProductLabel(item)
        return {
          id: item.id, label, isStandard: item.isStandard !== false,
          active: item.active !== false, search: [label].concat(item.aliases || []).join(' ').toLowerCase()
        }
      })
      this.filter()
    })
  },
  changeTab(event) { this.filter({ tab: event.currentTarget.dataset.tab }) },
  onSearch(event) { this.filter({ keyword: event.detail.value }) },
  filter(patch) {
    const state = Object.assign({}, this.data, patch)
    const keyword = String(state.keyword || '').trim().toLowerCase()
    this.setData(Object.assign({ products: (this.allProducts || []).filter(item =>
      (state.tab === 'standard' ? item.isStandard : !item.isStandard) && (!keyword || item.search.includes(keyword))
    ).slice(0, 150).map(({ id, label, isStandard, active }) => ({ id, label, isStandard, active })) }, patch))
  },
  add() { wx.navigateTo({ url: '/pages/product-form/product-form' }) },
  edit(event) { if (this.data.tab === 'custom') wx.navigateTo({ url: `/pages/product-form/product-form?id=${event.currentTarget.dataset.id}` }) },
  toggle(event) {
    const id = event.currentTarget.dataset.id
    const product = this.allProducts.find(item => item.id === id)
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
