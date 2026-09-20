const { loadPage, handleMutation } = require('../../services/page-context')

Page({
  data: { name: '', contact: '', phone: '', address: '', units: ['米', '根', '箱'], unitIndex: 0 },
  onLoad() {
    loadPage(this, (repository, tenantId) => {
      const enterprise = repository.getEnterprise(tenantId)
      this.setData({ name: enterprise.name || '', contact: enterprise.contact || '', phone: enterprise.phone || '', address: enterprise.address || '', unitIndex: Math.max(0, this.data.units.indexOf(enterprise.defaultUnit || '米')) })
    })
  },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  onUnit(event) { this.setData({ unitIndex: Number(event.detail.value) }) },
  save() {
    loadPage(this, (repository, tenantId) => {
      let result
      try { result = repository.updateEnterprise(tenantId, { confirmed: true, name: this.data.name, contact: this.data.contact, phone: this.data.phone, address: this.data.address, defaultUnit: this.data.units[this.data.unitIndex] }) } catch (error) { wx.showModal({ title: '无法保存', content: error.message, showCancel: false }); return }
      handleMutation(result, () => { wx.showToast({ title: '已保存' }); setTimeout(() => wx.navigateBack(), 400) })
    })
  }
})
