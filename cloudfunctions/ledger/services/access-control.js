const { createServiceError } = require('./service-errors')

const PUBLIC_ACTIONS = new Set(['inspectInvite', 'acceptInvite'])
const ACTIVE_MEMBER_ACTIONS = new Set([
  'bootstrap', 'getClientDeletePreview',
  'listCustomerPrices', 'getCustomerPrice', 'getCustomerPriceForProduct',
  'getStatementExportMeta', 'getStatementExportPage',
  'createStatementExcel', 'cleanupStatementExportFile',
  'getActiveMemberInvite', 'createMemberInvite', 'revokeMemberInvite',
  'updateEnterprise', 'saveCustomerPrice', 'createCustomProduct', 'updateCustomProduct',
  'setCustomProductActive', 'setProductActive', 'updateShipment',
  'updateClientOwner', 'updateBillingPeriodOwner', 'updateMemberDisplayName',
  'setMemberStatus', 'assignUnownedClients',
  'saveClient', 'postShipment', 'recordPayment', 'closeBillingPeriod', 'deleteClient'
])

function requireActiveMembership(membership) {
  if (!membership) {
    throw createServiceError('MEMBERSHIP_REQUIRED', '当前微信账号尚未加入企业')
  }
  if (membership.status === 'disabled') {
    throw createServiceError('MEMBERSHIP_DISABLED', '你的企业成员账号已停用，请联系管理员')
  }
  if (membership.status !== 'active' || !membership.id || !membership.tenantId) {
    throw createServiceError('MEMBERSHIP_INVALID', '当前企业成员身份已失效')
  }
  return membership
}

function assertKnownAction(action) {
  if (!PUBLIC_ACTIONS.has(action) && !ACTIVE_MEMBER_ACTIONS.has(action)) {
    throw createServiceError('ACTION_NOT_ALLOWED', '不支持的服务操作')
  }
  return action
}

module.exports = {
  PUBLIC_ACTIONS,
  ACTIVE_MEMBER_ACTIONS,
  requireActiveMembership,
  assertKnownAction
}
