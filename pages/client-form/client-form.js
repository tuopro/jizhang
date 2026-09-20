const { loadPage, handleMutation } = require('../../services/page-context')

Page({
  data: { id: '', name: '', contact: '', phone: '', settlementDay: '', note: '', saving: false },
  onLoad(options) {
    this.clientId = options.id || ''
    loadPage(this, (repository, tenantId) => {
      if (!this.clientId) return
      const client = repository.getClient(tenantId, this.clientId)
      if (!client) {
        wx.showModal({
          title: '客户不存在', content: '该客户不存在或已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      this.setData({
        id: client.id, name: client.name, contact: client.contact || '', phone: client.phone || '',
        settlementDay: client.settlementDay == null ? '' : String(client.settlementDay), note: client.note || ''
      })
    })
  },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }) },
  save() {
    loadPage(this, (repository, tenantId) => {
      let result
      try {
        result = repository.saveClient(tenantId, {
          confirmed: true, id: this.data.id || undefined, name: this.data.name,
          contact: this.data.contact, phone: this.data.phone,
          settlementDay: this.data.settlementDay, note: this.data.note
        })
      } catch (error) {
        wx.showModal({ title: '无法保存', content: error.message, showCancel: false }); return
      }
      handleMutation(result, () => {
        wx.showToast({ title: '已保存' })
        setTimeout(() => wx.navigateBack(), 400)
      })
    })
  }
})
