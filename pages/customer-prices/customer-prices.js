const { loadPage, handleAccessError } = require('../../services/page-context')
const { formatProductLabel } = require('../../data/product-specs')
const { centsToYuan, formatCurrency } = require('../../utils/money')

Page({
  data: {
    client: null, prices: [], keyword: '', formOpen: false,
    filteredProducts: [], productSearch: '', selectedProductId: '', selectedProductLabel: '',
    units: ['米', '根', '箱'], unitIndex: 0, unitPriceYuan: ''
  },
  onLoad(options) { this.clientId = options.clientId || '' },
  onShow() { this.load() },
  clearPrices() {
    this.allPrices = []
    this.products = []
    this.setData({ client: null, prices: [], formOpen: false, filteredProducts: [],
      selectedPriceId: '', selectedProductId: '', selectedProductLabel: '', unitPriceYuan: '' })
  },
  onHide() { this.loadVersion = (this.loadVersion || 0) + 1; this.clearPrices() },
  onUnload() { this.onHide() },
  accessFailed(error) {
    this.clearPrices()
    if (handleAccessError(error)) return
    wx.showModal({
      title: error.code === 'CUSTOMER_PRICE_FORBIDDEN' ? '无权访问' : '无法加载价格',
      content: error.message || '请稍后重试', showCancel: false,
      success: () => wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/clients/clients' }) })
    })
  },
  load() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1
    this.clearPrices()
    loadPage(this, (repository, tenantId) => {
      const client = repository.getClient(tenantId, this.clientId)
      if (!client) {
        wx.showModal({
          title: '客户不存在', content: '该客户不存在或已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      // This is a fresh server read in cloud mode, regardless of route/cache flags.
      let result
      try { result = repository.listCustomerPrices(tenantId, this.clientId) } catch (error) { this.accessFailed(error); return }
      Promise.resolve(result).then(prices => {
        if (version !== this.loadVersion) return
        this.allPrices = prices.map(item => Object.assign({}, item, {
          priceText: `${formatCurrency(item.unitPriceCents)}/${item.unit}`, search: item.productLabel.toLowerCase()
        }))
        this.products = repository.listProducts(tenantId).map(item => ({ id: item.id, label: formatProductLabel(item), search: [formatProductLabel(item)].concat(item.aliases || []).join(' ').toLowerCase() }))
        this.filterPrices({ client })
      }).catch(error => { if (version === this.loadVersion) this.accessFailed(error) })
    }, error => { if (version === this.loadVersion) this.accessFailed(error) })
  },
  onSearch(event) { this.filterPrices({ keyword: event.detail.value }) },
  filterPrices(patch) {
    const keyword = patch && patch.keyword !== undefined ? patch.keyword : this.data.keyword
    const value = String(keyword || '').trim().toLowerCase()
    this.setData(Object.assign({ prices: (this.allPrices || []).filter(item => !value || item.search.includes(value))
      .map(({ id, productLabel, priceText }) => ({ id, productLabel, priceText })) }, patch))
  },
  openAdd() { if (this.data.client) this.setData({ formOpen: true, selectedPriceId: '', selectedProductId: '', selectedProductLabel: '', unitIndex: 0, unitPriceYuan: '', productSearch: '', filteredProducts: this.products.slice(0, 80) }) },
  openEdit(event) {
    const price = (this.allPrices || []).find(item => item.id === event.currentTarget.dataset.id)
    if (!price) return
    this.setData({ formOpen: true, selectedPriceId: price.id, selectedProductId: price.productId, selectedProductLabel: price.productLabel, unitIndex: Math.max(0, this.data.units.indexOf(price.unit)), unitPriceYuan: centsToYuan(price.unitPriceCents), productSearch: '', filteredProducts: [] })
  },
  closeForm() { this.setData({ formOpen: false }) },
  stop() {},
  onProductSearch(event) {
    const value = String(event.detail.value || '').trim().toLowerCase()
    this.setData({ productSearch: event.detail.value, filteredProducts: this.products.filter(item => !value || item.search.includes(value)).slice(0, 80) })
  },
  selectProduct(event) {
    const product = this.products.find(item => item.id === event.currentTarget.dataset.id)
    if (product) this.setData({ selectedProductId: product.id, selectedProductLabel: product.label, filteredProducts: [] })
  },
  onUnit(event) { this.setData({ unitIndex: Number(event.detail.value) }) },
  onPrice(event) { this.setData({ unitPriceYuan: event.detail.value }) },
  save() {
    if (this.saving || !this.data.client) return
    this.saving = true
    const failed = error => {
      this.saving = false
      this.clearPrices()
      if (handleAccessError(error)) return
      if (error.code === 'CUSTOMER_PRICE_FORBIDDEN') { this.accessFailed(error); return }
      wx.showModal({ title: '无法保存', content: error.message, showCancel: false, success: () => this.load() })
    }
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.saveCustomerPrice(tenantId, {
          confirmed: true, id: this.data.selectedPriceId || undefined, clientId: this.clientId, productId: this.data.selectedProductId,
          unit: this.data.units[this.data.unitIndex], unitPriceYuan: this.data.unitPriceYuan
        })
      } catch (error) { failed(error); return }
      wx.showLoading({ title: '保存中' })
      Promise.resolve(result).then(() => {
        wx.hideLoading(); this.saving = false; this.closeForm(); this.load(); wx.showToast({ title: '价格已保存' })
      }).catch(error => { wx.hideLoading(); failed(error) })
    }, failed)
  }
})
