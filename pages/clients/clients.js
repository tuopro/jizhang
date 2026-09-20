const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')

Page({
  data: { keyword: '', allClients: [], clients: [], scope: 'all', currentMemberId: '' },
  onShow() { this.loadClients() },
  loadClients() {
    loadPage(this, (repository, tenantId) => {
      const identity = repository.isCloudRepository ? repository.getIdentity() : { memberId: 'member_local_admin' }
      const allClients = repository.listClients(tenantId).map(client => {
        const ledger = repository.getClientLedger(tenantId, client.id)
        return Object.assign({}, client, {
          outstandingText: formatCurrency(ledger.outstandingCents),
          owing: ledger.outstandingCents > 0,
          periodText: ledger.period ? `第${ledger.period.sequenceNo}期进行中` : '暂无进行中账期',
          ownerText: client.ownerDisplayName || client.ownerNameSnapshot || '未设置'
        })
      })
      this.setData({ allClients, currentMemberId: identity.memberId }, () => this.filterClients(this.data.keyword))
    })
  },
  onSearch(event) { this.filterClients(event.detail.value) },
  filterClients(keyword) {
    const value = String(keyword || '').trim().toLowerCase()
    const mineOnly = this.data.scope === 'mine'
    this.setData({
      keyword: keyword || '',
      clients: this.data.allClients.filter(item =>
        (!mineOnly || item.ownerMemberId === this.data.currentMemberId) &&
        (!value || [item.name, item.contact, item.phone, item.ownerText].join(' ').toLowerCase().includes(value)))
    })
  },
  setScope(event) {
    this.setData({ scope: event.currentTarget.dataset.scope }, () => this.filterClients(this.data.keyword))
  },
  addClient() { wx.navigateTo({ url: '/pages/client-form/client-form' }) },
  openClient(event) { wx.navigateTo({ url: `/pages/client-ledger/client-ledger?id=${event.currentTarget.dataset.id}` }) }
})
