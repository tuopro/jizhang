const { loadPage, handleMutation } = require('../../services/page-context')

Page({
  data: {
    client: null, period: null, members: [], memberNames: [], clientOwnerIndex: 0, periodOwnerIndex: 0,
    currentClientOwner: '未设置', currentPeriodOwner: '未设置', isAdmin: false
  },
  onLoad(options) { this.clientId = options.clientId || '' },
  onShow() { this.load() },
  load() {
    loadPage(this, (repository, tenantId) => {
      const client = repository.getClient(tenantId, this.clientId)
      const ledger = repository.getClientLedger(tenantId, this.clientId)
      if (!client || !ledger) {
        wx.showModal({
          title: '客户不存在', content: '该客户不存在或已被删除。', showCancel: false,
          success: () => wx.switchTab({ url: '/pages/clients/clients' })
        })
        return
      }
      const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
      const members = repository.listMembers(tenantId, { includeDisabled: false }).filter(item => item.status === 'active')
      const clientIndex = Math.max(0, members.findIndex(item => item.id === (client && client.ownerMemberId)))
      const periodIndex = Math.max(0, members.findIndex(item => item.id === (ledger && ledger.period && ledger.period.ownerMemberId)))
      this.repository = repository
      this.tenantId = tenantId
      this.setData({
        client, period: ledger && ledger.period || null, members,
        memberNames: members.map(item => item.displayName),
        clientOwnerIndex: clientIndex, periodOwnerIndex: periodIndex,
        currentClientOwner: client && (client.ownerDisplayName || client.ownerNameSnapshot) || '未设置',
        currentPeriodOwner: ledger && ledger.period && (ledger.period.ownerDisplayName || ledger.period.ownerNameSnapshot) || '未设置',
        isAdmin: identity.role === 'admin'
      })
    })
  },
  onClientOwnerChange(event) { this.setData({ clientOwnerIndex: Number(event.detail.value) }) },
  onPeriodOwnerChange(event) { this.setData({ periodOwnerIndex: Number(event.detail.value) }) },
  transferClientOnly() { this.transferClient(false) },
  transferClientAndPeriod() { this.transferClient(true) },
  transferClient(updateOpenPeriod) {
    const owner = this.data.members[this.data.clientOwnerIndex]
    if (!owner) return
    wx.showModal({
      title: updateOpenPeriod ? '一起转移' : '只改客户',
      content: updateOpenPeriod
        ? `将客户负责人和当前账期负责人都改为“${owner.displayName}”？`
        : `只将客户负责人改为“${owner.displayName}”，当前账期负责人保持不变？`,
      confirmText: '确认转移',
      success: modal => {
        if (!modal.confirm) return
        const result = this.repository.updateClientOwner(this.tenantId, {
          confirmed: true, clientId: this.clientId, ownerMemberId: owner.id, updateOpenPeriod
        })
        handleMutation(result, () => { wx.showToast({ title: '负责人已更新' }); this.load() })
      }
    })
  },
  transferPeriod() {
    const owner = this.data.members[this.data.periodOwnerIndex]
    if (!owner || !this.data.period) return
    wx.showModal({
      title: '修改本期负责人',
      content: `只将当前第${this.data.period.sequenceNo}期负责人改为“${owner.displayName}”？客户负责人不会改变。`,
      confirmText: '确认修改',
      success: modal => {
        if (!modal.confirm) return
        const result = this.repository.updateBillingPeriodOwner(this.tenantId, {
          confirmed: true, periodId: this.data.period.id, ownerMemberId: owner.id
        })
        handleMutation(result, () => { wx.showToast({ title: '本期已更新' }); this.load() })
      }
    })
  }
})
