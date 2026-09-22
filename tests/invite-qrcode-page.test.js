const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { cloudHarness } = require('./helpers/cloud-ledger-harness')
const { tenantId, copy } = require('./helpers/shipment-correction-fixture')
const { installWx, instantiatePage } = require('../scripts/benchmark-performance')
const { parseInviteOptions, currentEnvVersion, writeCodeImage, removeCodeImage } = require('../services/invite-qrcode')
const { compileWxml, findNodes } = require('./helpers/wxml-render')
const flush = () => new Promise(resolve => setImmediate(resolve))
let renderMembers
test.before(async () => { renderMembers = await compileWxml('pages/members/members') })
const qrButtons = data => findNodes(renderMembers(data), node => node.tag === 'wx-button' && node.attr.bindtap === 'showQRCode')

function context(actor = 'admin', existingHarness) {
  const h = existingHarness || cloudHarness()
  h.openid = h.c.members[actor] ? h.c.members[actor].openid : actor
  installWx({})
  ;['cloud-repository', 'repository-instance', 'page-context', 'privacy-consent'].forEach(name => delete require.cache[require.resolve(`../services/${name}`)])
  const c = { h, requests: [], modals: [], urls: [], toasts: [], writes: [], files: new Map(), album: [], previews: [], albumPermissionCalls: 0 }
  c.stored = { version: '2026-09-v2', agreedAt: '2026-09-22T00:00:00.000Z' }
  wx.getStorageSync = () => c.stored
  wx.setStorageSync = (key, value) => { c.writes.push({ key, value }); c.stored = value }
  wx.cloud.callFunction = async request => { c.requests.push(request.data); return { result: await h.main(request.data) } }
  wx.showModal = request => c.modals.push(request)
  wx.showToast = request => c.toasts.push(request)
  wx.reLaunch = request => { c.urls.push(request.url); if (request.complete) request.complete() }
  wx.env = { USER_DATA_PATH: '/fake-user-data' }
  wx.getFileSystemManager = () => ({
    writeFile(request) {
      if (c.onWrite) return c.onWrite(request)
      c.files.set(request.filePath, Buffer.from(request.data, request.encoding)); request.success()
    },
    unlink({ filePath, success }) { c.files.delete(filePath); success() }
  })
  wx.previewImage = request => { c.previews.push(request); request.success() }
  wx.getSetting = request => { c.albumPermissionCalls += 1; request.success({ authSetting: { 'scope.writePhotosAlbum': c.albumPermission } }) }
  wx.authorize = request => { c.albumPermissionCalls += 1; request.success() }
  wx.saveImageToPhotosAlbum = request => {
    if (c.onSave) return c.onSave(request)
    assert.ok(c.files.has(request.filePath)); c.album.push(request.filePath); request.success()
  }
  return c
}
async function members(c) {
  const { page } = instantiatePage('pages/members/members')
  page.onShow(); await flush(); return page
}
async function generate(c, page) {
  await page.showQRCode(); await flush()
  assert.ok(page.data.qrImagePath, c.modals.at(-1) && c.modals.at(-1).content)
  return { qrSceneCode: c.h.qrRequests.at(-1).scene }
}
async function joinPage(c, options) {
  const { page } = instantiatePage('pages/join-enterprise/join-enterprise')
  page.onLoad(options); page.onShow(); await flush(); return page
}

test.afterEach(() => { delete global.wx; delete global.Page; delete global.getApp })

for (const actor of ['admin', 'owner']) {
  test(`${actor} + active invite：真实身份加载后WXML渲染二维码入口`, async () => {
    const c = context(actor)
    const actualOpenid = c.h.openid
    c.h.openid = c.h.c.members.admin.openid
    const invite = await c.h.main({ action: 'createMemberInvite' })
    assert.equal(invite.result.status, 'active')
    c.h.openid = actualOpenid
    const page = await members(c)
    assert.equal(page.data.isAdmin, actor === 'admin')
    const buttons = qrButtons(page.data)
    assert.equal(buttons.length, actor === 'admin' ? 1 : 0)
    if (actor === 'admin') {
      assert.equal(page.data.invite.status, 'active')
      assert.equal(page.data.qrImagePath, '', 'entry must exist before any code image is generated')
      assert.equal(buttons[0].children.join(''), '邀请二维码')
      assert.equal(buttons[0].attr.disabled, false)
    }
    page.showQRCode(); await flush()
    assert.equal(c.h.qrRequests.length, actor === 'admin' ? 1 : 0)
    assert.equal(c.albumPermissionCalls, 0, 'generation must not ask for album access')
    const markup = fs.readFileSync('pages/members/members.wxml', 'utf8')
    assert.ok(markup.indexOf('wx:if="{{isAdmin}}"') < markup.indexOf('bindtap="showQRCode"'))
    assert.doesNotMatch(markup, /inviteToken|qrSceneCode|tenantId|openid/)
  })
}

test('同一邀请展示企业/有效期、支持预览和用户点击后保存；收起删除本机工作文件', async () => {
  const c = context(); const page = await members(c); await generate(c, page)
  const filePath = page.data.qrImagePath
  assert.ok(c.files.get(filePath).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
  assert.equal(page.data.qrEnterpriseName, '修正测试企业')
  assert.match(page.data.qrExpiresAtText, /^\d{4}-\d\d-\d\d \d\d:\d\d$/)
  assert.equal(page.onShareAppMessage().path, page.data.invite.path)
  assert.equal(c.albumPermissionCalls, 0)
  await page.previewQRCode()
  assert.deepEqual(c.previews[0].urls, [filePath])
  assert.equal(c.albumPermissionCalls, 0)
  await page.saveQRCode()
  assert.deepEqual(c.album, [filePath])
  assert.equal(c.albumPermissionCalls, 2)
  assert.equal(c.writes.length, 0)
  assert.equal(JSON.stringify(page.data).includes('base64'), false)
  page.clearQRCode(); await flush()
  assert.equal(c.files.size, 0)
  assert.equal(page.data.qrImagePath, '')
  assert.equal(c.h.read().tenants[tenantId].memberInvites.length, 1)
})

test('保存拒绝走原openSetting流程、二维码文案正确、失败不改变邀请', async () => {
  const c = context(); const page = await members(c); await generate(c, page)
  const before = c.h.read(); c.albumPermission = false
  const saving = page.saveQRCode(); await flush()
  const modal = c.modals.at(-1)
  assert.match(modal.content, /邀请二维码/)
  let settings = 0
  wx.openSetting = request => { settings += 1; request.success({ authSetting: { 'scope.writePhotosAlbum': true } }) }
  modal.success({ confirm: true }); await saving
  assert.equal(settings, 1)
  assert.equal(c.album.length, 1)
  assert.deepEqual(c.h.read(), before)
  c.onSave = request => request.fail({ errMsg: 'system album failed' })
  c.albumPermission = true
  await page.saveQRCode()
  assert.equal(page.data.qrSaving, false)
  assert.match(c.modals.at(-1).title, /保存失败/)
  assert.deepEqual(c.h.read(), before)
})

test('用户拒绝相册授权不影响二维码预览及invite', async () => {
  const c = context(); const page = await members(c); await generate(c, page)
  const before = c.h.read(); c.albumPermission = false
  const saving = page.saveQRCode(); await flush()
  c.modals.at(-1).success({ confirm: false }); await saving
  assert.equal(c.album.length, 0)
  await page.previewQRCode()
  assert.equal(c.previews.length, 1)
  assert.deepEqual(c.h.read(), before)
})

test('重复点击二维码仅一次调用，再次生成仍共用卡片invite及scene', async () => {
  const c = context(); const page = await members(c)
  page.showQRCode(); page.showQRCode(); await flush()
  assert.equal(c.h.qrRequests.length, 1)
  const first = page.data.invite
  await generate(c, page)
  assert.equal(c.h.qrRequests.length, 2)
  assert.equal(c.h.qrRequests[0].scene, c.h.qrRequests[1].scene)
  assert.equal(page.data.invite.path, first.path)
  assert.equal(c.files.size, 1)
})

test('作废清除预览且卡片和二维码同时失效', async () => {
  const c = context(); const page = await members(c); const credential = await generate(c, page)
  page.revokeInvite()
  assert.match(c.modals.at(-1).content, /邀请卡片和小程序码/)
  c.modals.at(-1).success({ confirm: true }); await flush()
  assert.equal(page.data.invite, null)
  assert.equal(page.data.qrImagePath, '')
  assert.equal(c.files.size, 0)
  c.h.openid = 'fictional-visitor'
  const r = await c.h.main({ action: 'inspectInvite', payload: credential })
  assert.equal(r.code, 'INVITE_REVOKED')
})

test('页面退出后迟到的图片写入会清理，不更新退出页面', async () => {
  const c = context(); const page = await members(c)
  let write
  c.onWrite = request => { write = request }
  page.showQRCode(); await flush()
  assert.ok(write)
  page.onUnload()
  const state = JSON.stringify(page.data)
  c.files.set(write.filePath, Buffer.from(write.data, 'base64')); write.success(); await flush()
  assert.equal(JSON.stringify(page.data), state)
  assert.equal(c.files.size, 0)
})

test('保存中退出，保留文件到保存完成再删除；不显示退出页成功提示', async () => {
  const c = context(); const page = await members(c); await generate(c, page)
  let save
  c.onSave = request => { save = request }
  const saving = page.saveQRCode(); await flush(); page.onUnload()
  assert.equal(c.files.size, 1)
  save.success(); await saving
  assert.equal(c.files.size, 0)
  assert.equal(c.toasts.length, 0)
})

test('本机写入失败只影响二维码展示，不撤销已有邀请', async () => {
  const c = context(); const page = await members(c)
  c.onWrite = request => request.fail({ errMsg: 'disk full' })
  page.showQRCode(); await flush()
  assert.equal(page.data.qrImagePath, '')
  assert.equal(page.data.qrLoading, false)
  assert.equal(c.h.read().tenants[tenantId].memberInvites[0].status, 'active')
  assert.match(c.modals.at(-1).content, /本机失败/)
})

test('审核演示场景：陌生微信扫码先隐私gate，恢复scene，明确确认后只加入该企业member', async () => {
  const c = context()
  c.h.change((t, root) => {
    t.enterprise.name = '德赛记账审核演示'
    const other = copy(t)
    other.enterprise = { id: 'tenant_other', name: '隔离测试企业' }
    for (const key of Object.keys(other)) if (Array.isArray(other[key])) other[key] = []
    other.clients = [{ id: 'secret-other-client', tenantId: 'tenant_other', name: '不可泄露测试客户' }]
    root.tenants.tenant_other = other
  })
  const admin = await members(c); const credential = await generate(c, admin)
  const newcomer = context('fictional-reviewer', c.h); newcomer.stored = null
  const options = { scene: encodeURIComponent(credential.qrSceneCode) }
  const first = await joinPage(newcomer, options)
  assert.equal(newcomer.requests.length, 0)
  assert.equal(newcomer.urls.at(-1), '/pages/privacy-consent/privacy-consent')
  first.onUnload()
  const privacy = require('../services/privacy-consent')
  privacy.savePrivacyConsent(new Date('2026-09-22T01:00:00.000Z'))
  privacy.markWechatPrivacyAuthorized()
  const route = privacy.takePendingRouteUrl()
  assert.equal(route, `/pages/join-enterprise/join-enterprise?scene=${credential.qrSceneCode}`)
  assert.equal(JSON.stringify(newcomer.writes).includes(credential.qrSceneCode), false)
  assert.deepEqual(Object.keys(newcomer.writes[0].value).sort(), ['agreedAt', 'version'])
  const page = await joinPage(newcomer, { scene: decodeURIComponent(route.split('scene=')[1]) })
  assert.equal(page.data.enterpriseName, '德赛记账审核演示')
  assert.equal(page.data.inviteStatus, '有效')
  assert.match(page.data.expiresAtText, /^\d{4}-/)
  assert.deepEqual(newcomer.requests.map(r => r.action), ['inspectInvite'])
  assert.equal(c.h.read().tenants[tenantId].memberships.some(m => m.openid === 'fictional-reviewer'), false)
  page.onNameInput({ detail: { value: '审核体验同事' } })
  page.join(); page.join(); await flush()
  assert.equal(newcomer.requests.filter(r => r.action === 'acceptInvite').length, 1)
  const member = c.h.read().tenants[tenantId].memberships.find(m => m.openid === 'fictional-reviewer')
  assert.equal(member.role, 'member'); assert.equal(member.status, 'active'); assert.equal(member.tenantId, tenantId)
  const result = await c.h.main({ action: 'bootstrap' })
  assert.equal(result.result.tenantId, tenantId)
  assert.equal(JSON.stringify(result).includes('不可泄露测试客户'), false)
})

for (const options of [
  {}, { scene: '%' }, { scene: 'unknown' }, { scene: 'a'.repeat(32) + '&tenantId=other' },
  { scene: 'a'.repeat(32), inviteToken: 'b'.repeat(48) }, { scene: 123 },
  { scene: '%25' + 'a'.repeat(31) }, { inviteToken: '%' }
]) {
  test(`页面非法scene安全拒绝且不fallback ${JSON.stringify(options)}`, async () => {
    const c = context('fictional-new'); const page = await joinPage(c, options)
    assert.match(page.data.error, /无效/)
    assert.equal(c.requests.length, 0)
    assert.equal(c.urls.length, 0)
    assert.equal(page.data.enterpriseName, '')
    page.join(); await flush(); assert.equal(c.requests.length, 0)
  })
}

test('合法形状但不存在scene不会打开已登录企业', async () => {
  const c = context('admin'); const page = await joinPage(c, { scene: 'f'.repeat(32) })
  assert.match(page.data.error, /无效/)
  assert.equal(c.urls.length, 0)
  assert.equal(c.requests.some(r => r.action === 'bootstrap'), false)
})

test('只解码一次scene，微信编码参数恢复正确，不解释其它业务字段', () => {
  const code = 'ab'.repeat(16)
  assert.deepEqual(parseInviteOptions({ scene: '%61b'.repeat(16) }), { qrSceneCode: code })
  assert.equal(parseInviteOptions({ scene: '%2561' + 'a'.repeat(31) }), null)
  assert.equal(parseInviteOptions({ inviteToken: 'a'.repeat(48) }), 'a'.repeat(48))
  assert.deepEqual(parseInviteOptions({ scene: code, role: 'admin', tenantId: 'other' }), { qrSceneCode: code })
})

for (const invalidation of ['revoke', 'expire']) {
  test(`预览后${invalidation}，确认时服务端拒绝；前后台返回重新inspect并清空旧企业信息`, async () => {
    const admin = context(); const page = await members(admin); const credential = await generate(admin, page)
    const c = context('fictional-new', admin.h)
    const join = await joinPage(c, { scene: credential.qrSceneCode })
    assert.equal(join.data.error, '')
    c.h.change(t => {
      if (invalidation === 'revoke') t.memberInvites[0].status = 'revoked'
      else t.memberInvites[0].expiresAt = '2000-01-01'
    })
    join.setData({ displayName: '测试同事' }); join.join(); await flush()
    assert.match(join.data.error, invalidation === 'revoke' ? /作废/ : /过期/)
    assert.equal(c.h.read().tenants[tenantId].memberships.some(m => m.openid === 'fictional-new'), false)
    join.onShow(); await flush()
    assert.equal(join.data.enterpriseName, '')
    assert.match(join.data.error, invalidation === 'revoke' ? /作废/ : /过期/)
  })
}

for (const state of ['active', 'disabled', 'other-tenant']) {
  test(`${state} 已有membership扫码使用同一安全规则`, async () => {
    const admin = context(); const page = await members(admin); const credential = await generate(admin, page)
    admin.h.change(t => {
      const member = t.memberships.find(m => m.id === admin.h.c.members.owner.id)
      if (state === 'disabled') member.status = 'disabled'
      if (state === 'other-tenant') member.tenantId = 'tenant_other'
    })
    const c = context('owner', admin.h)
    const join = await joinPage(c, { scene: credential.qrSceneCode })
    assert.equal(c.requests.some(r => r.action === 'acceptInvite'), false)
    if (state === 'active') {
      assert.equal(c.urls.at(-1), '/pages/index/index')
      assert.equal(c.toasts.at(-1).title, '你已加入该企业')
    } else if (state === 'disabled') assert.match(c.urls.at(-1), /reason=disabled/)
    else { assert.match(join.data.error, /其他企业/); assert.equal(c.urls.length, 0) }
  })
}

test('加入页面退出后的inspect迟到响应不会覆盖页面或跳转', async () => {
  const admin = context(); const page = await members(admin); const credential = await generate(admin, page)
  const c = context('fictional-new', admin.h)
  let resolve
  wx.cloud.callFunction = () => new Promise(done => { resolve = done })
  const { page: join } = instantiatePage('pages/join-enterprise/join-enterprise')
  join.onLoad({ scene: credential.qrSceneCode }); await flush(); join.onUnload()
  const state = JSON.stringify(join.data)
  resolve({ result: { ok: true, result: { enterpriseName: '迟到企业', expiresAt: '2099-01-01' } } }); await flush()
  assert.equal(JSON.stringify(join.data), state)
  assert.equal(c.urls.length, 0)
})

for (const value of ['develop', 'trial', 'release']) {
  test(`前端准确取得${value}并提交白名单版本`, async () => {
    const c = context(); wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: value } })
    const page = await members(c); await generate(c, page)
    assert.equal(c.requests.find(r => r.action === 'createMemberInviteQRCode').payload.envVersion, value)
  })
}

test('无法读取运行版本时不生成猜测的trial/release码', async () => {
  const c = context(); wx.getAccountInfoSync = () => { throw new Error('unavailable') }
  assert.throws(() => currentEnvVersion(wx), /无法识别/)
  const page = await members(c); page.showQRCode(); await flush()
  assert.equal(c.h.qrRequests.length, 0)
  assert.equal(page.data.qrLoading, false)
})

test('本机图片验证限制体积及格式，清理不删除其它业务文件', async () => {
  const c = context()
  for (const image of [{ extension: 'xlsx', base64: 'YWJj' }, { extension: 'png', base64: '%%%' }, { extension: 'png', base64: 'a'.repeat(524292) }]) {
    await assert.rejects(writeCodeImage(wx, image), /无效/)
  }
  c.files.set('/fake-user-data/statement.png', Buffer.from('bill'))
  await removeCodeImage(wx, '/fake-user-data/statement.png')
  await removeCodeImage(wx, '/fake-user-data/ledger-invite-qr-../../statement.png')
  assert.equal(c.files.size, 1)
})


test('WXML初始未知身份不渲染邀请入口，二维码相关data均已初始化', () => {
  context()
  const { page } = instantiatePage('pages/members/members')
  assert.equal(page.data.isAdmin, false)
  assert.equal(page.data.invite, null)
  assert.equal(page.data.qrLoading, false)
  assert.equal(page.data.qrSaving, false)
  assert.equal(page.data.qrImagePath, '')
  assert.equal(qrButtons(page.data).length, 0)
})

test('WXML普通member即使残留active invite或图片也不显示二维码入口', async () => {
  const c = context('owner'); const page = await members(c)
  page.setData({ invite: { status: 'active', id: 'cached-invite' }, qrImagePath: '/cached.png' })
  assert.equal(qrButtons(page.data).length, 0)
  assert.equal(findNodes(renderMembers(page.data), node => node.tag === 'wx-image').length, 0)
})

test('WXML管理员无当前invite仍可看到二维码入口以创建有效邀请', async () => {
  const c = context(); const page = await members(c)
  assert.equal(page.data.invite, null)
  const buttons = qrButtons(page.data)
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].attr.disabled, false)
})

test('WXML管理员的加载和保存状态只禁用二维码按钮，不隐藏入口', async () => {
  const c = context(); const page = await members(c)
  for (const state of ['inviteLoading', 'qrLoading', 'qrSaving']) {
    const data = Object.assign({}, page.data, { invite: { status: 'active' }, [state]: true })
    const buttons = qrButtons(data)
    assert.equal(buttons.length, 1, state)
    assert.equal(buttons[0].attr.disabled, true, state)
  }
})


test('上传根目录及二维码前端模块显式包含项保持正确，仍开启无依赖文件过滤', () => {
  const project = JSON.parse(fs.readFileSync('project.config.json', 'utf8'))
  assert.equal(project.miniprogramRoot, './')
  assert.equal(project.setting.ignoreDevUnusedFiles, true)
  assert.equal(project.setting.ignoreUploadUnusedFiles, true)
  assert.ok(project.packOptions.include.some(item => item.type === 'folder' && item.value === 'pages'))
  assert.ok(project.packOptions.include.some(item => item.type === 'file' && item.value === 'services/invite-qrcode.js'))
  assert.ok(fs.existsSync('services/invite-qrcode.js'))
})
