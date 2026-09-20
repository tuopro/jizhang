const { loadPage, handleMutation } = require('../../services/page-context')
const { formatProductLabel } = require('../../data/product-specs')
const { centsToYuan, formatCurrency } = require('../../utils/money')

Page({
  data: {
    client: null, prices: [], allPrices: [], keyword: '', formOpen: false,
    products: [], filteredProducts: [], productSearch: '', selectedProductId: '', selectedProductLabel: '',
    units: ['米', '根', '箱'], unitIndex: 0, unitPriceYuan: ''
  },
  onLoad(options) { this.clientId = options.clientId || '' },
  onShow() { this.load() },
  load() {
    loadPage(this, (repository, tenantId) => {
      const client = repository.getClient(tenantId, this.clientId)
      if (!client) {
        wx.showModal({
          title: '客户不存在', content: '该客户不存在或已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      const allPrices = repository.listCustomerPrices(tenantId, this.clientId).map(item => Object.assign({}, item, {
        priceText: `${formatCurrency(item.unitPriceCents)}/${item.unit}`,
        search: item.productLabel.toLowerCase()
      }))
      const products = repository.listProducts(tenantId).map(item => ({ id: item.id, label: formatProductLabel(item), search: [formatProductLabel(item)].concat(item.aliases || []).join(' ').toLowerCase() }))
      this.setData({ client, allPrices, products }, () => this.filterPrices())
    })
  },
  onSearch(event) { this.setData({ keyword: event.detail.value }, () => this.filterPrices()) },
  filterPrices() {
    const value = String(this.data.keyword || '').trim().toLowerCase()
    this.setData({ prices: this.data.allPrices.filter(item => !value || item.search.includes(value)) })
  },
  openAdd() { this.setData({ formOpen: true, selectedProductId: '', selectedProductLabel: '', unitIndex: 0, unitPriceYuan: '', productSearch: '', filteredProducts: this.data.products.slice(0, 80) }) },
  openEdit(event) {
    const price = this.data.allPrices.find(item => item.id === event.currentTarget.dataset.id)
    if (!price) return
    this.setData({ formOpen: true, selectedProductId: price.productId, selectedProductLabel: price.productLabel, unitIndex: Math.max(0, this.data.units.indexOf(price.unit)), unitPriceYuan: centsToYuan(price.unitPriceCents), productSearch: '', filteredProducts: [] })
  },
  closeForm() { this.setData({ formOpen: false }) },
  stop() {},
  onProductSearch(event) {
    const value = String(event.detail.value || '').trim().toLowerCase()
    this.setData({ productSearch: event.detail.value, filteredProducts: this.data.products.filter(item => !value || item.search.includes(value)).slice(0, 80) })
  },
  selectProduct(event) {
    const product = this.data.products.find(item => item.id === event.currentTarget.dataset.id)
    if (product) this.setData({ selectedProductId: product.id, selectedProductLabel: product.label, filteredProducts: [] })
  },
  onUnit(event) { this.setData({ unitIndex: Number(event.detail.value) }) },
  onPrice(event) { this.setData({ unitPriceYuan: event.detail.value }) },
  save() {
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.saveCustomerPrice(tenantId, {
          confirmed: true, clientId: this.clientId, productId: this.data.selectedProductId,
          unit: this.data.units[this.data.unitIndex], unitPriceYuan: this.data.unitPriceYuan
        })
      } catch (error) { wx.showModal({ title: '无法保存', content: error.message, showCancel: false }); return }
      handleMutation(result, () => { this.closeForm(); this.load(); wx.showToast({ title: '价格已保存' }) })
    })
  }
})
