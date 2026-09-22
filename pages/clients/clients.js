const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')
const { setProgressiveList, appendProgressiveList } = require('../../services/progressive-list')

Page({
  data: { keyword: '', clients: [], clientCount: 0, scope: 'all' },
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
      this.allClients = allClients
      this.currentMemberId = identity.memberId
      this.filterClients(this.data.keyword)
    })
  },
  onSearch(event) { this.filterClients(event.detail.value) },
  filterClients(keyword, patch) {
    const value = String(keyword || '').trim().toLowerCase()
    const mineOnly = (patch && patch.scope || this.data.scope) === 'mine'
    const clients = (this.allClients || []).filter(item =>
        (!mineOnly || item.ownerMemberId === this.currentMemberId) &&
        (!value || [item.name, item.contact, item.phone, item.ownerText].join(' ').toLowerCase().includes(value)))
        .map(({ id, name, contact, outstandingText, owing, periodText, ownerText }) =>
          ({ id, name, contact, outstandingText, owing, periodText, ownerText }))
    const reset = keyword !== this.data.keyword || Boolean(patch && patch.scope !== this.data.scope)
    setProgressiveList(this, 'clients', clients, Object.assign({ keyword: keyword || '', clientCount: clients.length }, patch), reset)
  },
  onReachBottom() { appendProgressiveList(this, 'clients') },
  setScope(event) {
    this.filterClients(this.data.keyword, { scope: event.currentTarget.dataset.scope })
  },
  addClient() { wx.navigateTo({ url: '/pages/client-form/client-form' }) },
  openClient(event) { wx.navigateTo({ url: `/pages/client-ledger/client-ledger?id=${event.currentTarget.dataset.id}` }) }
})
