const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  validateInvite,
  isInviteActive,
  validateInviteJoin,
  createInvitedMembership,
  revokeInviteRecord
} = require('../cloudfunctions/ledger/services/member-security')

const projectRoot = path.resolve(__dirname, '..')
const now = new Date('2026-09-20T10:00:00.000Z').getTime()
const timestamp = '2026-09-20T10:00:00.000Z'

function activeInvite(overrides) {
  return Object.assign({
    id: 'invite_shared',
    token: 'shared-token',
    tenantId: 'tenant_a',
    status: 'active',
    expiresAt: '2026-09-27T10:00:00.000Z',
    createdAt: timestamp,
    updatedAt: timestamp
  }, overrides || {})
}

function join(invite, openid, existingMembership, inputOverrides) {
  validateInviteJoin(invite, existingMembership || null, now)
  return createInvitedMembership(invite, Object.assign({
    memberId: `member_${openid}`,
    openid,
    displayName: openid,
    timestamp
  }, inputOverrides || {}))
}

test('同一token可供成员A加入', () => {
  const invite = activeInvite()
  const member = join(invite, '成员A')
  assert.equal(member.tenantId, 'tenant_a')
  assert.equal(member.openid, '成员A')
})

test('同一token在成员A加入后仍可供成员B加入', () => {
  const invite = activeInvite()
  join(invite, '成员A')
  const memberB = join(invite, '成员B')
  assert.equal(memberB.openid, '成员B')
  assert.equal(invite.status, 'active')
})

test('同一token仍可供第三位成员C加入', () => {
  const invite = activeInvite()
  const members = ['成员A', '成员B', '成员C'].map(openid => join(invite, openid))
  assert.deepEqual(members.map(item => item.openid), ['成员A', '成员B', '成员C'])
  assert.equal(new Set(members.map(item => item.id)).size, 3)
})

test('成员加入不会把token改成used或写入usedBy数组', () => {
  const invite = activeInvite()
  const before = JSON.parse(JSON.stringify(invite))
  join(invite, '成员A')
  assert.deepEqual(invite, before)
  assert.equal(isInviteActive(invite, now), true)

  const source = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/ledger/index.js'), 'utf8')
  const acceptBody = source.slice(source.indexOf('async function acceptInvite'), source.indexOf('exports.main'))
  assert.doesNotMatch(acceptBody, /status:\s*'used'|usedByOpenid|usedAt/)
  assert.doesNotMatch(acceptBody, /collection\('member_invites'\).*\.set/)
})

test('同一openid不能通过邀请重复加入同一企业', () => {
  const invite = activeInvite()
  const existing = join(invite, 'openid_a')
  assert.throws(() => validateInviteJoin(invite, existing, now), /你已加入该企业/)
})

test('token过期后不能加入', () => {
  const invite = activeInvite({ expiresAt: '2026-09-20T09:59:59.000Z' })
  assert.throws(() => validateInvite(invite, now), /已过期/)
  assert.throws(() => join(invite, '成员A'), /已过期/)
})

test('revoked token不能加入', () => {
  const invite = activeInvite({ status: 'revoked', revokedAt: timestamp })
  assert.throws(() => validateInvite(invite, now), /已作废/)
  assert.throws(() => join(invite, '成员A'), /已作废/)
})

test('新成员固定为member和active', () => {
  const member = join(activeInvite(), '成员A')
  assert.equal(member.role, 'member')
  assert.equal(member.status, 'active')
})

test('前端伪造role为admin无效', () => {
  const member = join(activeInvite(), '成员A', null, { role: 'admin' })
  assert.equal(member.role, 'member')
})

test('前端伪造tenantId无效，成员企业只来自invite', () => {
  const member = join(activeInvite({ tenantId: 'tenant_real' }), '成员A', null, { tenantId: 'tenant_fake' })
  assert.equal(member.tenantId, 'tenant_real')
})

test('disabled member不能借inviteToken重新加入绕过停用', () => {
  const invite = activeInvite()
  const disabled = {
    id: 'member_disabled', tenantId: 'tenant_a', openid: 'openid_disabled',
    displayName: '停用成员', role: 'member', status: 'disabled'
  }
  assert.throws(() => validateInviteJoin(invite, disabled, now), /你的企业成员账号已被停用，请联系管理员/)
})

test('管理员可以作废旧token并留下作废信息', () => {
  const revoked = revokeInviteRecord(activeInvite(), 'member_admin', timestamp)
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revokedByMemberId, 'member_admin')
  assert.equal(revoked.revokedAt, timestamp)

  const source = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/ledger/index.js'), 'utf8')
  const page = fs.readFileSync(path.join(projectRoot, 'pages/members/members.wxml'), 'utf8')
  assert.match(source, /REVOKE_MEMBER_INVITE/)
  assert.match(source, /只有管理员可以作废成员邀请/)
  assert.match(page, /bindtap="revokeInvite"/)
})

test('新生成token与旧revoked token相互独立', () => {
  const oldInvite = revokeInviteRecord(activeInvite({ id: 'invite_old', token: 'old-token' }), 'member_admin', timestamp)
  const newInvite = activeInvite({ id: 'invite_new', token: 'new-token', createdAt: '2026-09-20T10:01:00.000Z' })
  assert.notEqual(oldInvite.id, newInvite.id)
  assert.notEqual(oldInvite.token, newInvite.token)
  assert.equal(isInviteActive(oldInvite, now), false)
  assert.equal(isInviteActive(newInvite, now), true)
})

test('旧revoked token永久不能恢复使用', () => {
  const revoked = revokeInviteRecord(activeInvite(), 'member_admin', timestamp)
  const repeatedRevoke = revokeInviteRecord(revoked, 'member_admin', '2026-09-21T10:00:00.000Z')
  assert.equal(repeatedRevoke.status, 'revoked')
  assert.equal(repeatedRevoke.revokedAt, timestamp)
  assert.throws(() => validateInvite(repeatedRevoke, new Date('2026-09-21T10:00:00.000Z').getTime()), /已作废/)
})

