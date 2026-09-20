const { loadPage } = require('../../services/page-context')

const ACTION_NAMES = {
  CREATE_CLIENT: '创建客户', UPDATE_CLIENT: '修改客户', CREATE_SHIPMENT: '创建发货',
  UPDATE_SHIPMENT: '修正发货', CREATE_PAYMENT: '登记收款', CLOSE_BILLING_PERIOD: '结清账期',
  TRANSFER_CLIENT_OWNER: '转移客户负责人', TRANSFER_PERIOD_OWNER: '转移账期负责人',
  CREATE_MEMBER_INVITE: '创建成员邀请', REVOKE_MEMBER_INVITE: '作废成员邀请',
  JOIN_ENTERPRISE: '成员加入企业', JOIN_ENTERPRISE_BY_INVITE: '通过邀请加入企业',
  DISABLE_MEMBER: '停用成员', RESTORE_MEMBER: '恢复成员',
  UPDATE_MEMBER_DISPLAY_NAME: '修改成员姓名', ASSIGN_LEGACY_CLIENT_OWNER: '补旧客户负责人',
  ASSIGN_LEGACY_PERIOD_OWNER: '补旧账期负责人',
  DELETE_EMPTY_CLIENT: '删除空客户', DELETE_CLIENT_WITH_LEDGER: '彻底删除客户及账务'
}

Page({
  data: { logs: [], allowed: false },
  onShow() {
    loadPage(this, (repository, tenantId) => {
      const identity = repository.isCloudRepository ? repository.getIdentity() : { role: 'admin' }
      const allowed = identity.role === 'admin'
      const logs = allowed ? repository.getAuditLogs(tenantId).slice(0, 200).map(item => ({
        id: item.id,
        actionText: ACTION_NAMES[item.action] || item.action,
        operator: item.performedByNameSnapshot || '历史记录未记录',
        time: String(item.createdAt || '').replace('T', ' ').slice(0, 16),
        reason: item.reason || '',
        detail: item.clientNameSnapshot
          ? `客户：${item.clientNameSnapshot} · 发货${item.shipmentCount || 0}笔 · 收款${item.paymentCount || 0}笔 · 账期${item.billingPeriodCount || 0}个`
          : ''
      })) : []
      this.setData({ logs, allowed })
    })
  }
})
