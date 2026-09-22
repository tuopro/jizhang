const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')
const { setProgressiveList, appendProgressiveList } = require('../../services/progressive-list')

function monthsInRange(startDate, endDate) {
  if (!/^\d{4}-\d{2}/.test(startDate || '') || !/^\d{4}-\d{2}/.test(endDate || '')) return []
  const [startYear, startMonth] = startDate.slice(0, 7).split('-').map(Number)
  const [endYear, endMonth] = endDate.slice(0, 7).split('-').map(Number)
  const result = []
  let year = startYear
  let month = startMonth
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) { year += 1; month = 1 }
  }
  return result
}

Page({
  data: { histories: [], monthOptions: ['全部月份'], monthIndex: 0, scope: 'all' },
  onShow() {
    loadPage(this, (repository, tenantId) => {
      const identity = repository.isCloudRepository ? repository.getIdentity() : { memberId: 'member_local_admin' }
      const clients = new Map(repository.listClients(tenantId, { includeInactive: true }).map(item => [item.id, item]))
      const histories = repository.listBillingPeriods(tenantId, null, 'settled').map(period => {
        const client = clients.get(period.clientId) || { name: '历史客户' }
        return {
          id: period.id, clientId: period.clientId, clientName: client.name,
          sequenceText: `第${period.sequenceNo}期`,
          periodText: `${period.startDate} ～ ${period.closedDate}`,
          startDate: period.startDate, closedDate: period.closedDate,
          total: formatCurrency(period.shipmentTotalCents), freight: formatCurrency(period.freightCents),
          shipmentCount: period.shipmentCount,
          ownerMemberId: period.ownerMemberId || '', ownerText: period.ownerNameSnapshot || '未设置'
        }
      })
      const months = Array.from(new Set(histories.reduce((result, item) =>
        result.concat(monthsInRange(item.startDate, item.closedDate)), []))).sort().reverse()
      const selectedMonth = (this.monthValues || [''])[this.data.monthIndex] || ''
      const monthValues = [''].concat(months)
      const monthOptions = ['全部月份'].concat(months.map(item => `${item.slice(0, 4)}年${Number(item.slice(5))}月`))
      const monthIndex = Math.max(0, monthValues.indexOf(selectedMonth))
      this.allHistories = histories
      this.monthValues = monthValues
      this.currentMemberId = identity.memberId
      this.applyFilters({ monthOptions, monthIndex })
    })
  },
  onMonthChange(event) {
    const monthIndex = Number(event.detail.value)
    this.applyFilters({ monthIndex })
  },
  setScope(event) {
    this.applyFilters({ scope: event.currentTarget.dataset.scope })
  },
  applyFilters(patch) {
    const state = Object.assign({}, this.data, patch)
    const month = (this.monthValues || [''])[state.monthIndex] || ''
    const mineOnly = state.scope === 'mine'
    const histories = (this.allHistories || []).filter(item =>
      (!mineOnly || item.ownerMemberId === this.currentMemberId) &&
      (!month || (item.startDate.slice(0, 7) <= month && item.closedDate.slice(0, 7) >= month)))
    const reset = state.scope !== this.data.scope || state.monthIndex !== this.data.monthIndex
    setProgressiveList(this, 'histories', histories, patch, reset)
  },
  onReachBottom() { appendProgressiveList(this, 'histories') },
  openHistory(event) { wx.navigateTo({ url: `/pages/statement/statement?periodId=${event.currentTarget.dataset.id}` }) }
})
