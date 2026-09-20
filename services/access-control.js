const ACCESS_ERROR_CODES = new Set([
  'MEMBERSHIP_REQUIRED',
  'MEMBERSHIP_DISABLED',
  'MEMBERSHIP_INVALID',
  'MEMBERSHIP_CONFLICT'
])

function isAccessError(error) {
  if (error && ACCESS_ERROR_CODES.has(error.code)) return true
  const message = String(error && error.message || '')
  return /(?:尚未加入企业|成员账号已停用|成员账号已被停用|成员身份已失效)/.test(message)
}

function accessReason(error) {
  const code = error && error.code
  const message = String(error && error.message || '')
  return code === 'MEMBERSHIP_DISABLED' || /已(?:被)?停用/.test(message) ? 'disabled' : 'unauthorized'
}

function isInviteError(error) {
  return Boolean(error && ['INVITE_INVALID', 'INVITE_EXPIRED', 'INVITE_REVOKED'].includes(error.code))
}

module.exports = { ACCESS_ERROR_CODES, isAccessError, accessReason, isInviteError }
