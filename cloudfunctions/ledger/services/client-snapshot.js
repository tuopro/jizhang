const PRIVATE_KEYS = new Set(['_id', '_openid', 'openid', 'token'])
const { canManageCustomerPrices, currentPriceOpenPeriod } = require('./ledger-repository')

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

function clientSnapshot(snapshot, membership) {
  const safe = stripPrivateIdentityFields(snapshot)
  const allowedClients = new Set((snapshot.clients || []).filter(client =>
    canManageCustomerPrices(membership, client, currentPriceOpenPeriod(snapshot, client.id)))
    .map(client => client.id))
  safe.customerPrices = (safe.customerPrices || []).filter(price =>
    price.tenantId === snapshot.enterprise.id && allowedClients.has(price.clientId))
  // Price audit snapshots must not provide a second route to another client's prices.
  safe.auditLogs = (safe.auditLogs || []).filter(audit => audit.entityType !== 'customer_price' ||
    (membership && membership.status === 'active' && membership.tenantId === snapshot.enterprise.id && membership.role === 'admin') ||
    allowedClients.has(audit.clientId))
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
