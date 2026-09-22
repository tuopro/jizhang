const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { cloudHarness } = require('./helpers/cloud-ledger-harness')
const { tenantId, copy } = require('./helpers/shipment-correction-fixture')
const { generateCodeImage, ensureSceneCode, MAX_IMAGE_BYTES } = require('../cloudfunctions/ledger/services/invite-qrcode')

function setup() {
  const h = cloudHarness()
  h.openid = h.c.members.admin.openid
  h.call = (action, payload = {}) => h.main({ action, payload })
  h.qr = (payload = {}) => h.call('createMemberInviteQRCode', Object.assign({ envVersion: 'trial' }, payload))
  h.invites = () => h.read().tenants[tenantId].memberInvites
  h.inspection = credential => h.call('inspectInvite', credential)
  h.accept = credential => h.call('acceptInvite', Object.assign({ displayName: '测试同事' }, credential))
  return h
}
async function created(h, options) {
  const r = await h.qr(options)
  assert.equal(r.ok, true, r.error)
  return { result: r.result, invite: h.invites().find(i => i.id === r.result.invite.id),
    credential: { qrSceneCode: h.qrRequests.at(-1).scene } }
}

for (const actor of ['owner', 'other', 'creator', 'stranger', 'disabled-admin', 'deleted-admin']) {
  test(`生成权限：${actor} 不能通过伪造前端身份生成二维码`, async () => {
    const h = setup()
    if (actor === 'disabled-admin') h.change(t => { t.memberships.find(m => m.role === 'admin').status = 'disabled' })
    else if (actor === 'deleted-admin') h.change(t => { t.memberships = t.memberships.filter(m => m.role !== 'admin') })
    else h.openid = h.c.members[actor] ? h.c.members[actor].openid : 'fictional-stranger'
    const before = h.read()
    const r = await h.qr({ role: 'admin', openid: h.c.members.admin.openid, memberId: h.c.members.admin.id, tenantId })
    assert.equal(r.ok, false)
    assert.equal(h.qrRequests.length, 0)
    assert.deepEqual(h.read(), before)
  })
}
for (const stage of ['beforeTransaction', 'beforeCommit', 'onQRCode']) {
  for (const mutation of ['disable', 'delete', 'demote', 'move']) {
    test(`生成中 ${stage}/${mutation} 重新读取真实管理员身份并拒绝`, async () => {
      const h = setup()
      const card = await h.call('createMemberInvite')
      const change = () => h.change(t => {
        const admin = t.memberships.find(m => m.role === 'admin')
        if (mutation === 'disable') admin.status = 'disabled'
        if (mutation === 'delete') t.memberships = t.memberships.filter(m => m !== admin)
        if (mutation === 'demote') admin.role = 'member'
        if (mutation === 'move') admin.tenantId = 'unrelated-enterprise'
      })
      if (stage === 'onQRCode') h.onQRCode = () => { change(); return { buffer: Buffer.from('ffd8ff00', 'hex') } }
      else h[stage] = change
      const r = await h.qr({ inviteId: card.result.id })
      assert.equal(r.ok, false)
      assert.equal(r.result, undefined)
      if (stage !== 'onQRCode') assert.equal(h.qrRequests.length, 0)
    })
  }
}

test('当前真实卡片token是192bit/48hex；二维码按需加32位base64url字段且重复生成共用同一邀请', async () => {
  const h = setup()
  const card = await h.call('createMemberInvite')
  const before = h.invites()[0]
  assert.match(before.token, /^[0-9a-f]{48}$/)
  assert.equal(before.qrSceneCode, undefined)
  assert.equal(new Date(before.expiresAt) - new Date(before.createdAt), 7 * 86400000)
  const first = await created(h, { inviteId: card.result.id })
  await created(h, { inviteId: card.result.id })
  await created(h)
  assert.equal(h.invites().length, 1)
  assert.equal(new Set(h.qrRequests.map(r => r.scene)).size, 1)
  assert.match(first.credential.qrSceneCode, /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(first.credential.qrSceneCode, before.token.slice(0, 32))
  assert.equal(first.result.invite.path, card.result.path)
  assert.equal(h.security.length, 0, 'opaque credentials never reach msgSecCheck')
  const after = copy(h.invites()[0]); delete after.qrSceneCode
  assert.deepEqual(after, before, 'token/expiry/status/timestamps are preserved')
  assert.equal(h.read().tenants[tenantId].auditLogs.filter(a => a.action === 'CREATE_MEMBER_INVITE').length, 1)
})

test('无当前邀请时走原create及审计；其它历史邀请不会迁移', async () => {
  const h = setup()
  const r = await h.call('createMemberInvite')
  await h.call('revokeMemberInvite', { inviteId: r.result.id })
  const old = h.invites()[0]
  await created(h)
  assert.equal(h.invites().length, 2)
  assert.deepEqual(h.invites()[0], old)
  assert.equal(old.qrSceneCode, undefined)
})

test('不能指定其它企业邀请，伪造tenant/role/scene不会改变真实绑定', async () => {
  const h = setup()
  h.change(t => t.memberInvites.push({ id: 'foreign-invite', tenantId: 'foreign', token: 'f'.repeat(48), status: 'active', expiresAt: '2099-01-01' }))
  const denied = await h.qr({ inviteId: 'foreign-invite', tenantId: 'foreign', role: 'admin' })
  assert.equal(denied.ok, false)
  assert.equal(h.qrRequests.length, 0)
  h.change(t => { t.memberInvites = [] })
  const c = await created(h, { tenantId: 'foreign', role: 'admin', qrSceneCode: 'f'.repeat(32) })
  assert.equal(c.invite.tenantId, tenantId)
  assert.notEqual(c.credential.qrSceneCode, 'f'.repeat(32))
})

for (const envVersion of ['develop', 'trial', 'release']) {
  test(`${envVersion} 官方API使用对应版本、真实无query路由及合法scene`, async () => {
    const h = setup(); const c = await created(h, { envVersion })
    const request = h.qrRequests[0]
    assert.equal(request.envVersion, envVersion)
    assert.equal(request.checkPath, envVersion === 'release')
    assert.equal(request.page, 'pages/join-enterprise/join-enterprise')
    assert.ok(JSON.parse(fs.readFileSync('app.json')).pages.includes(request.page))
    assert.equal(request.page.includes('?'), false)
    assert.match(request.scene, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(c.result.image.envVersion, envVersion)
    assert.ok(Buffer.from(c.result.image.base64, 'base64').length)
  })
}
for (const envVersion of ['', 'review', 'Trial', 'release&role=admin', null, {}, 1]) {
  test(`非法版本 ${JSON.stringify(envVersion)} 在创建邀请/API之前拒绝`, async () => {
    const h = setup(); const before = h.read()
    const r = await h.qr({ envVersion })
    assert.equal(r.code, 'INVITE_QR_ENV_INVALID')
    assert.equal(h.qrRequests.length, 0)
    assert.deepEqual(h.read(), before)
  })
}

for (const firstChannel of ['qr', 'card']) {
  test(`${firstChannel} 先加入后另一渠道仍可加入；OPENID/tenant/member审计全部来自真实身份`, async () => {
    const h = setup(); const c = await created(h)
    const credentials = { qr: c.credential, card: { inviteToken: c.invite.token } }
    for (const [index, channel] of [firstChannel, firstChannel === 'qr' ? 'card' : 'qr'].entries()) {
      h.openid = `fictional-new-${index}`
      assert.equal((await h.inspection(credentials[channel])).ok, true)
      const r = await h.accept(Object.assign({}, credentials[channel], { openid: 'forged-openid', memberId: 'forged-id', tenantId: 'forged-tenant', role: 'admin', status: 'disabled' }))
      assert.equal(r.ok, true, r.error)
      assert.equal(r.result.tenantId, tenantId)
      assert.equal(r.result.role, 'member')
      assert.equal(r.result.status, 'active')
      assert.equal(r.result.memberId, `member_${crypto.createHash('sha256').update(h.openid).digest('hex').slice(0, 24)}`)
      const t = h.read().tenants[tenantId]
      const member = t.memberships.find(m => m.id === r.result.memberId)
      assert.equal(member.openid, h.openid)
      const audit = t.auditLogs.find(a => a.action === 'JOIN_ENTERPRISE_BY_INVITE' && a.memberId === member.id)
      assert.deepEqual(Object.keys(audit).sort(), ['id', 'tenantId', 'action', 'entityType', 'entityId', 'performedByMemberId', 'performedByNameSnapshot', 'inviteId', 'memberId', 'displayName', 'joinedAt', 'createdAt'].sort())
      assert.equal(audit.performedByMemberId, member.id)
      assert.equal(audit.inviteId, c.invite.id)
    }
    assert.deepEqual(h.invites()[0], c.invite, 'accept does not mark used or add usedByOpenid')
    assert.equal(h.security.length, 2)
    assert.ok(h.security.every(s => !s.content.includes(c.invite.token) && !s.content.includes(c.credential.qrSceneCode)))
  })
}

for (const invalidation of ['revoke', 'expire']) {
  test(`${invalidation} 后卡片/二维码同时拒绝inspect及确认；缓存预览不能绕过`, async () => {
    const h = setup(); const c = await created(h)
    h.openid = 'fictional-new'
    assert.equal((await h.inspection(c.credential)).ok, true)
    if (invalidation === 'revoke') {
      h.openid = h.c.members.admin.openid
      await h.call('revokeMemberInvite', { inviteId: c.invite.id })
    } else h.change(t => { t.memberInvites[0].expiresAt = '2000-01-01T00:00:00.000Z' })
    h.openid = 'fictional-new'
    const before = h.read()
    for (const credential of [c.credential, { inviteToken: c.invite.token }]) {
      assert.equal((await h.inspection(credential)).code, invalidation === 'revoke' ? 'INVITE_REVOKED' : 'INVITE_EXPIRED')
      assert.equal((await h.accept(credential)).code, invalidation === 'revoke' ? 'INVITE_REVOKED' : 'INVITE_EXPIRED')
    }
    assert.deepEqual(h.read(), before)
    h.openid = h.c.members.admin.openid
    assert.equal((await h.qr({ inviteId: c.invite.id })).ok, false)
  })
  test(`微信API等待中发生 ${invalidation} 不再返回二维码图片`, async () => {
    const h = setup(); const c = await created(h)
    h.onQRCode = () => {
      h.change(t => {
        if (invalidation === 'revoke') t.memberInvites[0].status = 'revoked'
        else t.memberInvites[0].expiresAt = '2000-01-01'
      })
      return { buffer: Buffer.from('ffd8ff00', 'hex') }
    }
    assert.equal((await h.qr({ inviteId: c.invite.id })).ok, false)
  })
}

test('二维码不能恢复disabled成员，active成员已加入语义不变，不能加入其它企业', async () => {
  const h = setup(); const c = await created(h)
  h.openid = h.c.members.owner.openid
  const already = await h.inspection(c.credential)
  assert.equal(already.result.alreadyMember, true)
  assert.equal((await h.accept(c.credential)).code, 'ALREADY_MEMBER')
  h.change(t => { t.memberships.find(m => m.openid === h.openid).status = 'disabled' })
  assert.equal((await h.accept(c.credential)).code, 'MEMBERSHIP_DISABLED')
  assert.equal((await h.inspection(c.credential)).code, 'MEMBERSHIP_DISABLED')
  h.change(t => { t.memberships.find(m => m.openid === h.openid).tenantId = 'another-enterprise' })
  assert.equal((await h.accept(c.credential)).code, 'MEMBERSHIP_CONFLICT')
  assert.equal((await h.inspection(c.credential)).code, 'MEMBERSHIP_CONFLICT')
})

for (const code of ['', '%', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'tenant_a', 'a'.repeat(32) + '&role=admin', {}, 'f'.repeat(32)]) {
  test(`无效/不存在scene ${JSON.stringify(code)} 拒绝且不写membership`, async () => {
    const h = setup(); await created(h); h.openid = 'fictional-new'; const before = h.read()
    assert.equal((await h.inspection({ qrSceneCode: code })).code, 'INVITE_INVALID')
    assert.equal((await h.accept({ qrSceneCode: code })).code, 'INVITE_INVALID')
    assert.deepEqual(h.read(), before)
  })
}

test('同时提交二维码与卡片凭证拒绝，不会fallback到另一个有效邀请', async () => {
  const h = setup(); const c = await created(h); h.openid = 'fictional-new'
  const credentials = { inviteToken: c.invite.token, qrSceneCode: 'bad' }
  assert.equal((await h.inspection(credentials)).code, 'INVITE_INVALID')
  assert.equal((await h.accept(credentials)).code, 'INVITE_INVALID')
})

test('重复scene记录保守拒绝，不能解析到错误tenant', async () => {
  const h = setup(); const c = await created(h)
  h.change(t => t.memberInvites.push(Object.assign({}, c.invite, { id: 'duplicate', tenantId: 'other' })))
  assert.equal((await h.inspection(c.credential)).code, 'INVITE_INVALID')
  assert.equal((await h.qr({ inviteId: c.invite.id })).code, 'INVITE_INVALID')
})

test('随机scene碰撞有界重试且不覆盖其它邀请', async () => {
  let attempts = 0; const writes = []
  const tx = { collection: () => ({
    where: () => ({ limit: () => ({ get: async () => ({ data: ++attempts < 3 ? [{ id: 'existing' }] : [] }) }) }),
    doc: () => ({ set: async value => writes.push(value) })
  }) }
  const code = await ensureSceneCode(tx, { id: 'target', token: 'a'.repeat(48) })
  assert.equal(attempts, 3)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].data.qrSceneCode, code)
  attempts = -99
  await assert.rejects(ensureSceneCode(tx, { id: 'target' }), { code: 'INVITE_QR_UNAVAILABLE' })
  assert.equal(attempts, -94)
})

test('同时生成同一邀请时事务冲突重试后复用同一scene，仅有一份CREATE审计', async () => {
  const h = setup()
  const results = await Promise.all([h.qr(), h.qr(), h.qr()])
  assert.ok(results.every(r => r.ok), JSON.stringify(results.map(r => r.code)))
  assert.equal(h.invites().length, 1)
  assert.equal(new Set(h.qrRequests.map(r => r.scene)).size, 1)
  assert.equal(h.read().tenants[tenantId].auditLogs.filter(a => a.action === 'CREATE_MEMBER_INVITE').length, 1)
})

for (const mode of ['sdk', 'json', 'not-image', 'oversize']) {
  test(`API ${mode} 安全失败，不记录/返回凭证或buffer；邀请仍然可用于卡片`, async () => {
    const h = setup(); const c = await created(h)
    const secret = `${c.invite.token}/${c.credential.qrSceneCode}/private-openid/private-tenant`
    h.onQRCode = () => {
      if (mode === 'sdk') throw Object.assign(new Error(secret), { code: secret, buffer: secret })
      if (mode === 'json') return { errCode: 40001, errmsg: secret, buffer: Buffer.from(secret) }
      return { buffer: mode === 'oversize' ? Buffer.alloc(MAX_IMAGE_BYTES + 1) : Buffer.from(secret) }
    }
    const r = await h.qr({ inviteId: c.invite.id })
    assert.equal(r.ok, false)
    for (const value of [c.invite.token, c.credential.qrSceneCode, 'private-openid', 'private-tenant']) {
      assert.equal(JSON.stringify([r, h.logs]).includes(value), false)
    }
    h.openid = 'fictional-new'
    assert.equal((await h.accept({ inviteToken: c.invite.token })).ok, true)
  })
}

test('固定官方API权限；PUBLIC_ACTIONS不扩充；无存储上传/长期密钥/第三方API依赖', () => {
  const config = JSON.parse(fs.readFileSync('cloudfunctions/ledger/config.json'))
  assert.deepEqual(config.permissions.openapi, ['security.msgSecCheck', 'wxacode.getUnlimited'])
  const { PUBLIC_ACTIONS, ACTIVE_MEMBER_ACTIONS } = require('../cloudfunctions/ledger/services/access-control')
  assert.deepEqual([...PUBLIC_ACTIONS], ['inspectInvite', 'acceptInvite'])
  assert.ok(ACTIVE_MEMBER_ACTIONS.has('createMemberInviteQRCode'))
  const source = fs.readFileSync('cloudfunctions/ledger/services/invite-qrcode.js', 'utf8')
  assert.match(source, /cloud\.openapi\.wxacode\.getUnlimited/)
  assert.doesNotMatch(source, /uploadFile|access_token|AppSecret|SecretKey|SecretId|fetch\(|https?:|console\./)
})

test('生成PNG和JPEG都只返回base64和固定图片信息', async () => {
  for (const [hex, ext] of [['89504e470d0a1a0a', 'png'], ['ffd8ff00', 'jpg']]) {
    const value = await generateCodeImage({ openapi: { wxacode: { getUnlimited: async () => ({ buffer: Buffer.from(hex, 'hex') }) } } }, 'a'.repeat(32), 'trial')
    assert.equal(value.extension, ext)
    assert.equal(Buffer.from(value.base64, 'base64').toString('hex'), hex)
    assert.deepEqual(Object.keys(value).sort(), ['base64', 'envVersion', 'extension'])
  }
})

for (const change of ['revoke', 'expire', 'already-joined']) {
  test(`accept事务提交冲突后${change}必须重读邀请/成员并拒绝`, async () => {
    const h = setup(); const c = await created(h); h.openid = 'fictional-conflict'
    assert.equal((await h.inspection(c.credential)).ok, true)
    h.beforeCommit = () => h.change(t => {
      if (change === 'revoke') t.memberInvites[0].status = 'revoked'
      else if (change === 'expire') t.memberInvites[0].expiresAt = '2000-01-01'
      else t.memberships.push({ id: 'concurrent-member', tenantId, openid: h.openid, role: 'member', status: 'active' })
    })
    const r = await h.accept(c.credential)
    assert.equal(r.code, { revoke: 'INVITE_REVOKED', expire: 'INVITE_EXPIRED', 'already-joined': 'ALREADY_MEMBER' }[change])
    assert.equal(h.read().tenants[tenantId].auditLogs.filter(a => a.action === 'JOIN_ENTERPRISE_BY_INVITE').length, 0)
  })
}

test('scene使用完整24随机字节；缺少真实微信身份不得生成或接受邀请', async () => {
  const h = setup(); const c = await created(h)
  assert.equal(Buffer.from(c.credential.qrSceneCode, 'base64url').length, 24)
  h.openid = ''
  assert.equal((await h.qr({ openid: h.c.members.admin.openid })).code, 'WECHAT_IDENTITY_UNAVAILABLE')
  assert.equal((await h.accept(Object.assign({}, c.credential, { openid: 'forged' }))).code, 'WECHAT_IDENTITY_UNAVAILABLE')
})
