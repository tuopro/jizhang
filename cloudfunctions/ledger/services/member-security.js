const MEMBER_MUTATIONS = new Set(['saveClient', 'postShipment', 'recordPayment', 'closeBillingPeriod', 'deleteClient'])
const { createServiceError } = require('./service-errors')

function validateDisplayName(value) {
  const displayName = String(value || '').trim()
  if (displayName.length < 2 || displayName.length > 20) throw new Error('企业显示姓名需为2到20个字符')
  return displayName
}

function validateInvite(invite, currentTime) {
  const now = currentTime == null ? Date.now() : Number(currentTime)
  if (!invite) throw createServiceError('INVITE_INVALID', '邀请链接无效')
  if (invite.status === 'revoked') throw createServiceError('INVITE_REVOKED', '该邀请已作废')
  if (invite.status !== 'active') throw createServiceError('INVITE_INVALID', '该邀请已失效')
  if (!invite.expiresAt || new Date(invite.expiresAt).getTime() <= now) {
    throw createServiceError('INVITE_EXPIRED', '该邀请已过期')
  }
  return invite
}

function isInviteActive(invite, currentTime) {
  try {
    validateInvite(invite, currentTime)
    return true
  } catch (error) {
    return false
  }
}

function validateInviteJoin(invite, existingMembership, currentTime) {
  validateInvite(invite, currentTime)
  if (!existingMembership) return invite
  if (existingMembership.tenantId !== invite.tenantId) {
    throw createServiceError('MEMBERSHIP_CONFLICT', '当前微信账号已绑定其他企业')
  }
  if (existingMembership.status !== 'active') {
    throw createServiceError('MEMBERSHIP_DISABLED', '你的企业成员账号已被停用，请联系管理员。')
  }
  throw createServiceError('ALREADY_MEMBER', '你已加入该企业')
}

function createInvitedMembership(invite, input) {
  return {
    id: input.memberId,
    tenantId: invite.tenantId,
    openid: input.openid,
    displayName: input.displayName,
    role: 'member',
    status: 'active',
    joinedAt: input.timestamp,
    createdAt: input.timestamp,
    updatedAt: input.timestamp
  }
}

function revokeInviteRecord(invite, memberId, timestamp) {
  if (!invite) throw new Error('邀请链接无效')
  if (invite.status === 'revoked') return Object.assign({}, invite)
  if (invite.status !== 'active') throw new Error('该邀请已失效')
  return Object.assign({}, invite, {
    status: 'revoked',
    revokedAt: timestamp,
    revokedByMemberId: memberId,
    updatedAt: timestamp
  })
}

function assertMutationPermission(membership, action, args) {
  if (membership.role === 'admin') return
  if (!MEMBER_MUTATIONS.has(action)) throw new Error('当前操作仅限管理员')
  if (action === 'saveClient' && args[0] && args[0].id) throw new Error('修改客户资料仅限管理员')
}

module.exports = {
  MEMBER_MUTATIONS,
  validateDisplayName,
  validateInvite,
  isInviteActive,
  validateInviteJoin,
  createInvitedMembership,
  revokeInviteRecord,
  assertMutationPermission
}
