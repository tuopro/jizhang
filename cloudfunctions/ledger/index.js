const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { createMemoryStorage } = require('./services/storage-cloud')
const { createLedgerRepository } = require('./services/ledger-repository')
const {
  MEMBER_MUTATIONS,
  validateDisplayName,
  validateInvite,
  isInviteActive,
  validateInviteJoin,
  createInvitedMembership,
  revokeInviteRecord,
  assertMutationPermission
} = require('./services/member-security')
const {
  requireActiveMembership,
  assertKnownAction
} = require('./services/access-control')
const { createServiceError, getServiceErrorCode } = require('./services/service-errors')
const { clientSnapshot } = require('./services/client-snapshot')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COLLECTIONS = {
  clients: 'clients',
  customProducts: 'products',
  customerPrices: 'customer_prices',
  shipments: 'shipments',
  payments: 'payments',
  billingPeriods: 'billing_periods',
  auditLogs: 'audit_logs',
  memberships: 'memberships'
}

const ADMIN_MUTATIONS = new Set([
  'updateEnterprise', 'saveCustomerPrice', 'createCustomProduct', 'updateCustomProduct',
  'setCustomProductActive', 'setProductActive', 'updateShipment',
  'updateClientOwner', 'updateBillingPeriodOwner', 'updateMemberDisplayName',
  'setMemberStatus', 'assignUnownedClients'
])
const MUTATIONS = new Set([...ADMIN_MUTATIONS, ...MEMBER_MUTATIONS])
const READ_ACTIONS = new Set(['getClientDeletePreview'])

function clean(document) {
  if (!document) return document
  const value = JSON.parse(JSON.stringify(document))
  delete value._id
  delete value._openid
  return value
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
}

function identityFor(membership, enterpriseName) {
  return {
    tenantId: membership.tenantId,
    memberId: membership.id,
    displayName: String(membership.displayName || '管理员'),
    role: membership.role === 'admin' ? 'admin' : 'member',
    status: membership.status,
    enterpriseName
  }
}

async function getMembership(openid, source) {
  const provider = source || db
  const id = stableId('member', openid)
  const response = await provider.collection('memberships').doc(id).get().catch(() => null)
  if (response && response.data) return clean(response.data)
  const fallback = await provider.collection('memberships').where({ openid }).limit(2).get()
  const matches = (fallback.data || []).map(clean)
  if (matches.length > 1) {
    throw createServiceError('MEMBERSHIP_INVALID', '当前微信身份存在多条企业成员记录，请联系管理员处理')
  }
  return matches[0] || null
}

async function listTenant(source, collectionName, tenantId) {
  const response = await source.collection(collectionName).where({ tenantId }).limit(1000).get()
  return (response.data || []).map(clean)
}

async function loadSnapshot(tenantId, source) {
  const provider = source || db
  const enterpriseResponse = await provider.collection('enterprises').doc(tenantId).get()
  const enterprise = clean(enterpriseResponse.data)
  const snapshot = { enterprise }
  for (const [field, collectionName] of Object.entries(COLLECTIONS)) {
    snapshot[field] = await listTenant(provider, collectionName, tenantId)
  }
  return snapshot
}

function buildRepository(tenantId, snapshot, membership) {
  const storage = createMemoryStorage({ schemaVersion: 1, tenants: { [tenantId]: snapshot } })
  return {
    storage,
    repository: createLedgerRepository(storage, {
      actor: {
        id: membership.id,
        tenantId: membership.tenantId,
        displayName: String(membership.displayName || '管理员'),
        role: membership.role,
        status: membership.status
      }
    })
  }
}

function comparable(value) {
  return JSON.stringify(clean(value))
}

async function persistChanges(transaction, tenantId, before, after) {
  if (comparable(before.enterprise) !== comparable(after.enterprise)) {
    await transaction.collection('enterprises').doc(tenantId).set({
      data: Object.assign({}, clean(after.enterprise), { id: tenantId, tenantId })
    })
  }
  for (const [field, collectionName] of Object.entries(COLLECTIONS)) {
    const previous = new Map((before[field] || []).map(item => [item.id, comparable(item)]))
    const currentIds = new Set((after[field] || []).map(item => item.id))
    for (const item of after[field] || []) {
      if (previous.get(item.id) === comparable(item)) continue
      await transaction.collection(collectionName).doc(item.id).set({
        data: Object.assign({}, clean(item), { id: item.id, tenantId })
      })
    }
    for (const item of before[field] || []) {
      if (currentIds.has(item.id)) continue
      await transaction.collection(collectionName).doc(item.id).remove()
    }
  }
}

async function bootstrap(membership) {
  const snapshot = await loadSnapshot(membership.tenantId)
  return {
    ok: true,
    result: identityFor(membership, snapshot.enterprise.name),
    snapshot: clientSnapshot(snapshot)
  }
}

async function mutate(openid, membership, action, payload) {
  const args = payload && Array.isArray(payload.args) ? payload.args : []
  assertMutationPermission(membership, action, args)
  const tenantId = membership.tenantId
  let result
  let finalSnapshot
  await db.runTransaction(async transaction => {
    const currentMembership = await getMembership(openid, transaction)
    requireActiveMembership(currentMembership)
    if (currentMembership.tenantId !== tenantId) {
      throw createServiceError('MEMBERSHIP_INVALID', '当前成员身份已失效，请重新进入小程序')
    }
    assertMutationPermission(currentMembership, action, args)
    const before = await loadSnapshot(tenantId, transaction)
    const domain = buildRepository(tenantId, before, currentMembership)
    result = domain.repository[action].apply(null, [tenantId].concat(args))
    const root = domain.storage.read()
    finalSnapshot = root.tenants[tenantId]
    await persistChanges(transaction, tenantId, before, finalSnapshot)
  })
  return { ok: true, result, snapshot: clientSnapshot(finalSnapshot) }
}

async function readAction(membership, action, payload) {
  const args = payload && Array.isArray(payload.args) ? payload.args : []
  const snapshot = await loadSnapshot(membership.tenantId)
  const domain = buildRepository(membership.tenantId, snapshot, membership)
  const result = domain.repository[action].apply(null, [membership.tenantId].concat(args))
  return { ok: true, result }
}

async function getInviteByToken(token, source) {
  const provider = source || db
  const response = await provider.collection('member_invites').where({ token }).limit(2).get()
  const matches = (response.data || []).map(clean)
  if (matches.length !== 1) return null
  return matches[0]
}

async function listTenantInvites(tenantId, source) {
  const provider = source || db
  const response = await provider.collection('member_invites').where({ tenantId }).limit(1000).get()
  return (response.data || []).map(clean)
}

async function getActiveInviteForTenant(tenantId, source, currentTime) {
  const invites = await listTenantInvites(tenantId, source)
  return invites
    .filter(invite => isInviteActive(invite, currentTime))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null
}

function inviteResult(invite, enterpriseName) {
  return {
    id: invite.id,
    token: invite.token,
    status: invite.status,
    expiresAt: invite.expiresAt,
    enterpriseName,
    path: `/pages/join-enterprise/join-enterprise?inviteToken=${encodeURIComponent(invite.token)}`
  }
}

async function inspectInvite(token) {
  const invite = await getInviteByToken(String(token || '').trim())
  validateInvite(invite)
  const response = await db.collection('enterprises').doc(invite.tenantId).get()
  const enterprise = clean(response.data)
  return { ok: true, result: { enterpriseName: enterprise.name, expiresAt: invite.expiresAt } }
}

async function getActiveMemberInvite(membership) {
  if (membership.role !== 'admin') throw new Error('只有管理员可以查看成员邀请')
  const invite = await getActiveInviteForTenant(membership.tenantId)
  if (!invite) return { ok: true, result: null }
  const response = await db.collection('enterprises').doc(membership.tenantId).get()
  return { ok: true, result: inviteResult(invite, clean(response.data).name) }
}

async function createMemberInvite(openid, membership) {
  if (membership.role !== 'admin') throw new Error('只有管理员可以邀请成员')
  let invite
  await db.runTransaction(async transaction => {
    const current = await getMembership(openid, transaction)
    requireActiveMembership(current)
    if (current.role !== 'admin') throw new Error('管理员身份已失效')
    const existing = await getActiveInviteForTenant(current.tenantId, transaction)
    if (existing) {
      invite = existing
      return
    }
    const timestamp = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    invite = {
      id: randomId('invite'), tenantId: current.tenantId,
      token: crypto.randomBytes(24).toString('hex'),
      createdByMemberId: current.id,
      status: 'active', expiresAt,
      createdAt: timestamp, updatedAt: timestamp
    }
    const audit = {
      id: randomId('audit'), tenantId: current.tenantId,
      action: 'CREATE_MEMBER_INVITE', entityType: 'member_invite', entityId: invite.id,
      performedByMemberId: current.id,
      performedByNameSnapshot: String(current.displayName || '管理员'),
      expiresAt,
      createdAt: timestamp
    }
    await transaction.collection('member_invites').doc(invite.id).set({ data: invite })
    await transaction.collection('audit_logs').doc(audit.id).set({ data: audit })
  })
  const snapshot = await loadSnapshot(membership.tenantId)
  return {
    ok: true,
    result: inviteResult(invite, snapshot.enterprise.name),
    snapshot: clientSnapshot(snapshot)
  }
}

async function revokeMemberInvite(openid, membership, payload) {
  if (membership.role !== 'admin') throw new Error('只有管理员可以作废成员邀请')
  const inviteId = String(payload && payload.inviteId || '').trim()
  if (!inviteId) throw new Error('缺少邀请编号')
  let revokedInvite
  await db.runTransaction(async transaction => {
    const current = await getMembership(openid, transaction)
    requireActiveMembership(current)
    if (current.role !== 'admin') throw new Error('管理员身份已失效')
    const response = await transaction.collection('member_invites').doc(inviteId).get().catch(() => null)
    const invite = response && response.data ? clean(response.data) : null
    if (!invite || invite.tenantId !== current.tenantId) throw new Error('邀请不存在或无权操作')
    if (invite.status === 'revoked') {
      revokedInvite = invite
      return
    }
    if (invite.status !== 'active') throw new Error('该邀请已失效')
    const timestamp = new Date().toISOString()
    revokedInvite = revokeInviteRecord(invite, current.id, timestamp)
    const audit = {
      id: randomId('audit'), tenantId: current.tenantId,
      action: 'REVOKE_MEMBER_INVITE', entityType: 'member_invite', entityId: invite.id,
      performedByMemberId: current.id,
      performedByNameSnapshot: String(current.displayName || '管理员'),
      revokedAt: timestamp,
      createdAt: timestamp
    }
    await transaction.collection('member_invites').doc(invite.id).set({ data: revokedInvite })
    await transaction.collection('audit_logs').doc(audit.id).set({ data: audit })
  })
  const snapshot = await loadSnapshot(membership.tenantId)
  return {
    ok: true,
    result: inviteResult(revokedInvite, snapshot.enterprise.name),
    snapshot: clientSnapshot(snapshot)
  }
}

async function acceptInvite(openid, payload) {
  const token = String(payload && payload.inviteToken || '').trim()
  const displayName = validateDisplayName(payload && payload.displayName)
  let joinedMembership
  await db.runTransaction(async transaction => {
    const invite = await getInviteByToken(token, transaction)
    const existing = await getMembership(openid, transaction)
    validateInviteJoin(invite, existing)
    const timestamp = new Date().toISOString()
    const membership = createInvitedMembership(invite, {
      memberId: stableId('member', openid), openid, displayName, timestamp
    })
    await transaction.collection('memberships').doc(membership.id).set({ data: membership })
    const audit = {
      id: randomId('audit'), tenantId: invite.tenantId,
      action: 'JOIN_ENTERPRISE_BY_INVITE', entityType: 'membership', entityId: membership.id,
      performedByMemberId: membership.id, performedByNameSnapshot: displayName,
      inviteId: invite.id,
      memberId: membership.id,
      displayName,
      joinedAt: timestamp,
      createdAt: timestamp
    }
    await transaction.collection('audit_logs').doc(audit.id).set({ data: audit })
    joinedMembership = membership
  })
  const snapshot = await loadSnapshot(joinedMembership.tenantId)
  return {
    ok: true,
    result: identityFor(joinedMembership, snapshot.enterprise.name),
    snapshot: clientSnapshot(snapshot)
  }
}

exports.main = async event => {
  const action = String(event && event.action || '')
  try {
    const context = cloud.getWXContext()
    if (!context.OPENID) throw createServiceError('WECHAT_IDENTITY_UNAVAILABLE', '无法取得微信用户身份')
    assertKnownAction(action)
    if (action === 'inspectInvite') return await inspectInvite(event && event.payload && event.payload.inviteToken)
    if (action === 'acceptInvite') return await acceptInvite(context.OPENID, event.payload || {})

    const membership = requireActiveMembership(await getMembership(context.OPENID))
    if (action === 'bootstrap') return await bootstrap(membership)
    if (action === 'getActiveMemberInvite') return await getActiveMemberInvite(membership)
    if (action === 'createMemberInvite') return await createMemberInvite(context.OPENID, membership)
    if (action === 'revokeMemberInvite') return await revokeMemberInvite(context.OPENID, membership, event.payload || {})
    if (READ_ACTIONS.has(action)) return await readAction(membership, action, event.payload || {})
    if (MUTATIONS.has(action)) return await mutate(context.OPENID, membership, action, event.payload || {})
    throw createServiceError('ACTION_NOT_ALLOWED', '不支持的服务操作')
  } catch (error) {
    const code = getServiceErrorCode(error)
    console.error('[ledger]', { action, code })
    return { ok: false, code, error: error.message || '云端服务异常' }
  }
}
