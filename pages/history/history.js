const { loadPage } = require('../../services/page-context')
const { formatCurrency } = require('../../utils/money')

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
  data: { allHistories: [], histories: [], monthOptions: ['全部月份'], monthValues: [''], monthIndex: 0, scope: 'all', currentMemberId: '' },
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
      const selectedMonth = this.data.monthValues[this.data.monthIndex] || ''
      const monthValues = [''].concat(months)
      const monthOptions = ['全部月份'].concat(months.map(item => `${item.slice(0, 4)}年${Number(item.slice(5))}月`))
      const monthIndex = Math.max(0, monthValues.indexOf(selectedMonth))
      this.setData({ allHistories: histories, monthOptions, monthValues, monthIndex, currentMemberId: identity.memberId }, () => this.applyFilters())
    })
  },
  onMonthChange(event) {
    const monthIndex = Number(event.detail.value)
    this.setData({ monthIndex }, () => this.applyFilters())
  },
  setScope(event) {
    this.setData({ scope: event.currentTarget.dataset.scope }, () => this.applyFilters())
  },
  applyFilters() {
    const month = this.data.monthValues[this.data.monthIndex] || ''
    const mineOnly = this.data.scope === 'mine'
    const histories = this.data.allHistories.filter(item =>
      (!mineOnly || item.ownerMemberId === this.data.currentMemberId) &&
      (!month || (item.startDate.slice(0, 7) <= month && item.closedDate.slice(0, 7) >= month)))
    this.setData({ histories })
  },
  openHistory(event) { wx.navigateTo({ url: `/pages/statement/statement?periodId=${event.currentTarget.dataset.id}` }) }
})
