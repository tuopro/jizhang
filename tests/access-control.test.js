const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  PUBLIC_ACTIONS,
  ACTIVE_MEMBER_ACTIONS,
  requireActiveMembership
} = require('../cloudfunctions/ledger/services/access-control')
const {
  validateInvite,
  validateInviteJoin,
  createInvitedMembership
} = require('../cloudfunctions/ledger/services/member-security')

const root = path.resolve(__dirname, '..')
const cloudIndex = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
const cloudRepository = fs.readFileSync(path.join(root, 'services/cloud-repository.js'), 'utf8')
const pageContext = fs.readFileSync(path.join(root, 'services/page-context.js'), 'utf8')
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
const now = new Date('2026-09-20T12:00:00.000Z').getTime()

const admin = { id: 'member_admin', tenantId: 'tenant_a', role: 'admin', status: 'active' }
const member = { id: 'member_staff', tenantId: 'tenant_a', role: 'member', status: 'active' }

function assertProtectedRead(method) {
  assert.match(cloudRepository, new RegExp(`['\"]${method}['\"]`))
  assert.ok(ACTIVE_MEMBER_ACTIONS.has('bootstrap'))
  assert.ok(!PUBLIC_ACTIONS.has('bootstrap'))
  assert.throws(() => requireActiveMembership(null), error => error.code === 'MEMBERSHIP_REQUIRED')
}

function assertProtectedAction(action) {
  assert.ok(ACTIVE_MEMBER_ACTIONS.has(action), `${action} must require an active membership`)
  assert.ok(!PUBLIC_ACTIONS.has(action))
  assert.throws(() => requireActiveMembership(null), error => error.code === 'MEMBERSHIP_REQUIRED')
}

function activeInvite(overrides) {
  return Object.assign({
    id: 'invite_a', tenantId: 'tenant_a', token: 'token_a', status: 'active',
    expiresAt: '2026-09-27T12:00:00.000Z'
  }, overrides || {})
}

test('1 active admin 可正常建立企业身份', () => {
  assert.equal(requireActiveMembership(admin), admin)
})

test('2 active member 可正常建立企业身份', () => {
  assert.equal(requireActiveMembership(member), member)
})

test('3 无 membership 不能读取客户列表', () => {
  assertProtectedRead('listClients')
})

test('4 无 membership 不能读取客户详情', () => {
  assertProtectedRead('getClient')
})

test('5 无 membership 不能读取账期', () => {
  assertProtectedRead('listBillingPeriods')
  assertProtectedRead('getPeriodDetail')
})

test('6 无 membership 不能读取历史账', () => {
  assertProtectedRead('getStatement')
})

test('7 无 membership 不能读取客户价格', () => {
  assertProtectedRead('getCustomerPrice')
  assertProtectedRead('listCustomerPrices')
})

test('8 无 membership 不能新增客户', () => {
  assertProtectedAction('saveClient')
})

test('9 无 membership 不能记发货', () => {
  assertProtectedAction('postShipment')
})

test('10 无 membership 不能登记收款', () => {
  assertProtectedAction('recordPayment')
})

test('11 无 membership 不能结清账期', () => {
  assertProtectedAction('closeBillingPeriod')
})

test('12 无 membership 不能调用删除与删除预览', () => {
  assertProtectedAction('deleteClient')
  assertProtectedAction('getClientDeletePreview')
})

test('13 disabled member 不能读取企业快照', () => {
  assert.throws(
    () => requireActiveMembership(Object.assign({}, member, { status: 'disabled' })),
    error => error.code === 'MEMBERSHIP_DISABLED'
  )
})

test('14 disabled member 不能写入', () => {
  assertProtectedAction('postShipment')
  assert.throws(
    () => requireActiveMembership(Object.assign({}, member, { status: 'disabled' })),
    error => error.code === 'MEMBERSHIP_DISABLED'
  )
})

test('15 disabled member 不能通过 inviteToken 重新加入', () => {
  assert.throws(
    () => validateInviteJoin(activeInvite(), Object.assign({}, member, { status: 'disabled' }), now),
    error => error.code === 'MEMBERSHIP_DISABLED'
  )
})

test('16 无 membership 加有效 inviteToken 可进入加入流程', () => {
  const invite = validateInvite(activeInvite(), now)
  assert.doesNotThrow(() => validateInviteJoin(invite, null, now))
  const joined = createInvitedMembership(invite, {
    memberId: 'member_new', openid: 'openid_new', displayName: '新成员', timestamp: '2026-09-20T12:00:00.000Z'
  })
  assert.equal(joined.role, 'member')
  assert.equal(joined.status, 'active')
})

test('17 无效 token 不能加入', () => {
  assert.throws(() => validateInvite(null, now), error => error.code === 'INVITE_INVALID')
})

test('18 过期 token 不能加入', () => {
  assert.throws(
    () => validateInvite(activeInvite({ expiresAt: '2026-09-20T11:59:59.000Z' }), now),
    error => error.code === 'INVITE_EXPIRED'
  )
})

test('19 revoked token 不能加入', () => {
  assert.throws(
    () => validateInvite(activeInvite({ status: 'revoked' }), now),
    error => error.code === 'INVITE_REVOKED'
  )
})

test('20 同一成员不能重复加入', () => {
  assert.throws(
    () => validateInviteJoin(activeInvite(), member, now),
    error => error.code === 'ALREADY_MEMBER'
  )
})

test('21 前端伪造 tenantId 不参与服务端授权', () => {
  assert.doesNotMatch(cloudIndex, /event\s*\.\s*tenantId|payload\s*\.\s*tenantId/)
  assert.match(cloudIndex, /membership\.tenantId/)
})

test('22 前端伪造 memberId 不参与服务端身份建立', () => {
  assert.doesNotMatch(cloudIndex, /payload\s*\.\s*memberId/)
  assert.match(cloudIndex, /stableId\('member',\s*openid\)/)
})

test('23 前端伪造 role admin 不参与服务端授权', () => {
  assert.doesNotMatch(cloudIndex, /payload\s*\.\s*role/)
  assert.match(cloudIndex, /membership\.role/)
})

test('24 直接访问任一正式页仍会进入统一身份检查', () => {
  const publicPages = new Set([
    'pages/join-enterprise/join-enterprise',
    'pages/privacy-consent/privacy-consent',
    'pages/unauthorized/unauthorized'
  ])
  appJson.pages.filter(page => !publicPages.has(page)).forEach(page => {
    const source = fs.readFileSync(path.join(root, `${page}.js`), 'utf8')
    assert.match(source, /loadPage|prepareRepository/, `${page} must use the centralized page guard`)
  })
  assert.match(pageContext, /handleAccessError/)
  assert.match(pageContext, /pages\/unauthorized\/unauthorized/)
})

test('25 陌生用户不会自动创建 enterprise', () => {
  assert.doesNotMatch(cloudIndex, /ensureInitialAdmin|stableId\('tenant',\s*openid\)/)
  assert.match(cloudIndex, /requireActiveMembership\(await getMembership\(context\.OPENID\)\)/)
})

test('26 陌生用户不会自动创建 admin membership', () => {
  assert.doesNotMatch(cloudIndex, /displayName:\s*'管理员',\s*role:\s*'admin',\s*status:\s*'active'/)
  assert.match(cloudIndex, /createInvitedMembership/)
})

test('27 账单导出 action 全部要求 active membership 且不是公开入口', () => {
  ;[
    'getStatementExportMeta',
    'getStatementExportPage',
    'createStatementExcel',
    'cleanupStatementExportFile'
  ].forEach(assertProtectedAction)
})
