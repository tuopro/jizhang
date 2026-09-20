const PRIVATE_KEYS = new Set(['_id', '_openid', 'openid', 'token'])

function stripPrivateIdentityFields(value) {
  if (Array.isArray(value)) return value.map(stripPrivateIdentityFields)
  if (!value || typeof value !== 'object') return value
  const safe = {}
  Object.entries(value).forEach(([key, item]) => {
    if (PRIVATE_KEYS.has(key)) return
    safe[key] = stripPrivateIdentityFields(item)
  })
  return safe
}

function clientSnapshot(snapshot) {
  const safe = stripPrivateIdentityFields(snapshot)
  safe.memberships = (safe.memberships || []).map(member => ({
    id: member.id,
    tenantId: member.tenantId,
    displayName: String(member.displayName || '管理员'),
    role: member.role === 'admin' ? 'admin' : 'member',
    status: member.status === 'disabled' ? 'disabled' : 'active',
    joinedAt: member.joinedAt || member.createdAt || '',
    createdAt: member.createdAt || '',
    updatedAt: member.updatedAt || ''
  }))
  return safe
}

module.exports = { stripPrivateIdentityFields, clientSnapshot }
