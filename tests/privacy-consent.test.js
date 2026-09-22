const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const servicePath = path.join(root, 'services/privacy-consent.js')

function createHarness(options) {
  let stored = options && options.stored
  const calls = []
  global.wx = {
    getStorageSync(key) {
      calls.push({ name: 'getStorageSync', key })
      return stored
    },
    setStorageSync(key, value) {
      calls.push({ name: 'setStorageSync', key, value })
      stored = value
    },
    reLaunch(input) {
      calls.push({ name: 'reLaunch', url: input.url })
      if (input.complete) input.complete()
    },
    getPrivacySetting(input) {
      calls.push({ name: 'getPrivacySetting' })
      if (options && options.settingError) input.fail(new Error('privacy setting unavailable'))
      else input.success({
        needAuthorization: Boolean(options && options.needAuthorization),
        privacyContractName: '《线槽记账助手隐私保护指引》'
      })
    },
    openPrivacyContract(input) {
      calls.push({ name: 'openPrivacyContract' })
      input.success()
    }
  }
  delete require.cache[require.resolve(servicePath)]
  return {
    service: require(servicePath),
    calls,
    stored: () => stored
  }
}

test.afterEach(() => {
  delete global.wx
  delete global.Page
  delete require.cache[require.resolve(servicePath)]
})

test('1 新用户首次进入必须跳转隐私同意页', async () => {
  const { service, calls } = createHarness()
  let businessStarted = false
  const allowed = await service.runAfterPrivacyConsent(
    { route: 'pages/index/index', options: {} },
    () => { businessStarted = true }
  )
  assert.equal(allowed, false)
  assert.equal(businessStarted, false)
  assert.deepEqual(calls.filter(call => call.name === 'reLaunch'), [
    { name: 'reLaunch', url: '/pages/privacy-consent/privacy-consent' }
  ])
  assert.equal(calls.some(call => call.name === 'getPrivacySetting'), false)
})

test('2 checkbox 默认未勾选，未勾选时同意按钮 disabled 且不保存', () => {
  const { service, calls } = createHarness()
  const pageSource = fs.readFileSync(path.join(root, 'pages/privacy-consent/privacy-consent.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/privacy-consent/privacy-consent.wxml'), 'utf8')
  assert.match(pageSource, /checked:\s*false/)
  assert.match(wxml, /disabled="\{\{!checked \|\| !privacyStatusReady \|\| agreeing\}\}"/)

  let pageDefinition
  global.Page = definition => { pageDefinition = definition }
  delete require.cache[require.resolve(path.join(root, 'pages/privacy-consent/privacy-consent.js'))]
  require(path.join(root, 'pages/privacy-consent/privacy-consent.js'))
  const page = Object.assign({}, pageDefinition, {
    data: Object.assign({}, pageDefinition.data, { privacyStatusReady: true }),
    setData(update) { Object.assign(this.data, update) }
  })
  page.agreeAndContinue()
  assert.equal(calls.some(call => call.name === 'setStorageSync'), false)
  assert.equal(service.hasCurrentPrivacyConsent(), false)
})

test('3 点击不同意只进入未同意状态，不执行业务回调', async () => {
  const { service } = createHarness()
  let businessStarted = false
  await service.runAfterPrivacyConsent(
    { route: 'pages/history/history', options: {} },
    () => { businessStarted = true }
  )
  assert.equal(businessStarted, false)
  const pageSource = fs.readFileSync(path.join(root, 'pages/privacy-consent/privacy-consent.js'), 'utf8')
  const disagreeBlock = pageSource.slice(pageSource.indexOf('disagree()'), pageSource.indexOf('reconsider()'))
  assert.match(disagreeBlock, /declined:\s*true/)
  assert.doesNotMatch(disagreeBlock, /bootstrap|prepareRepository|getRepository|setStorageSync/)
})

test('4 同意当前版本且微信不再要求授权后才执行业务回调', async () => {
  const { service } = createHarness()
  let businessCalls = 0
  service.savePrivacyConsent(new Date('2026-09-20T12:00:00.000Z'))
  const allowed = await service.runAfterPrivacyConsent(
    { route: 'pages/index/index', options: {} },
    () => { businessCalls += 1 }
  )
  assert.equal(allowed, true)
  assert.equal(businessCalls, 1)
})

test('5 已同意当前版本的二次进入不重复显示 gate', async () => {
  const current = { version: '2026-09-v2', agreedAt: '2026-09-20T12:00:00.000Z' }
  const { service, calls } = createHarness({ stored: current })
  let started = false
  await service.runAfterPrivacyConsent({ route: 'pages/index/index' }, () => { started = true })
  assert.equal(started, true)
  assert.equal(calls.some(call => call.name === 'reLaunch'), false)
})

test('6 本地版本不一致时必须重新同意', async () => {
  const { service, calls } = createHarness({
    stored: { version: '2026-08-v1', agreedAt: '2026-08-01T00:00:00.000Z' }
  })
  let started = false
  await service.runAfterPrivacyConsent({ route: 'pages/index/index' }, () => { started = true })
  assert.equal(started, false)
  assert.equal(calls.some(call => call.name === 'reLaunch'), true)
})

test('7 即使本地已同意，微信平台重新要求授权时仍会进入 gate', async () => {
  const { service, calls } = createHarness({
    stored: { version: '2026-09-v2', agreedAt: '2026-09-20T12:00:00.000Z' },
    needAuthorization: true
  })
  let started = false
  await service.runAfterPrivacyConsent({ route: 'pages/index/index' }, () => { started = true })
  assert.equal(started, false)
  assert.equal(calls.some(call => call.name === 'getPrivacySetting'), true)
  assert.equal(calls.some(call => call.name === 'reLaunch'), true)
})

test('8 邀请链接先进隐私 gate，同意后原样恢复 inviteToken 路由', async () => {
  const token = 'invite secret + /'
  const { service } = createHarness()
  await service.runAfterPrivacyConsent(
    { route: 'pages/join-enterprise/join-enterprise' },
    () => {},
    { route: 'pages/join-enterprise/join-enterprise', query: { inviteToken: token } }
  )
  assert.equal(
    service.takePendingRouteUrl(),
    `/pages/join-enterprise/join-enterprise?inviteToken=${encodeURIComponent(token)}`
  )
})

test('9 inviteToken 不会写入隐私 localStorage', async () => {
  const { service, calls } = createHarness()
  await service.runAfterPrivacyConsent(
    { route: 'pages/join-enterprise/join-enterprise' },
    () => {},
    { route: 'pages/join-enterprise/join-enterprise', query: { inviteToken: 'secret_token' } }
  )
  service.savePrivacyConsent(new Date('2026-09-20T12:00:00.000Z'))
  const write = calls.find(call => call.name === 'setStorageSync')
  assert.deepEqual(write.value, {
    version: '2026-09-v2',
    agreedAt: '2026-09-20T12:00:00.000Z'
  })
  assert.doesNotMatch(JSON.stringify(write.value), /invite|token|secret/i)
})

test('10 所有页面直接访问都不能绕过统一 privacy gate', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  appJson.pages.filter(page => page !== 'pages/privacy-consent/privacy-consent').forEach(page => {
    const source = fs.readFileSync(path.join(root, `${page}.js`), 'utf8')
    assert.match(source, /loadPage|runAfterPrivacyConsent/, `${page} must use the centralized privacy guard`)
  })
  const pageContext = fs.readFileSync(path.join(root, 'services/page-context.js'), 'utf8')
  assert.ok(pageContext.indexOf('runAfterPrivacyConsent') < pageContext.indexOf('prepareRepository()'))
})

test('11 隐私同意不等于 membership 授权，原身份拦截仍在 gate 之后', () => {
  const pageContext = fs.readFileSync(path.join(root, 'services/page-context.js'), 'utf8')
  const repositoryInstance = fs.readFileSync(path.join(root, 'services/repository-instance.js'), 'utf8')
  const cloudIndex = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  assert.match(pageContext, /handleAccessError/)
  assert.match(repositoryInstance, /current\.bootstrap\(\)/)
  assert.match(cloudIndex, /requireActiveMembership\(await getMembership\(context\.OPENID\)\)/)
  assert.doesNotMatch(fs.readFileSync(servicePath, 'utf8'), /membership|tenantId|memberId|role/)
})

test('12 陌生用户、disabled member 和 active member 仍使用原 bootstrap 身份结果', () => {
  const accessTests = fs.readFileSync(path.join(root, 'tests/access-control.test.js'), 'utf8')
  assert.match(accessTests, /MEMBERSHIP_REQUIRED/)
  assert.match(accessTests, /MEMBERSHIP_DISABLED/)
  assert.match(accessTests, /active admin/)
  assert.match(accessTests, /active member/)
})

test('13 “我的 → 隐私保护指引”通过 wx.openPrivacyContract 长期可见', () => {
  const js = fs.readFileSync(path.join(root, 'pages/mine/mine.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/mine/mine.wxml'), 'utf8')
  const service = fs.readFileSync(servicePath, 'utf8')
  assert.match(wxml, /隐私保护指引/)
  assert.match(wxml, /bindtap="openPrivacyGuide"/)
  assert.match(js, /openPrivacyContract/)
  assert.match(service, /api\.openPrivacyContract/)
})

test('14 官方隐私授权使用 getPrivacySetting 和 agreePrivacyAuthorization 组件', () => {
  const service = fs.readFileSync(servicePath, 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/privacy-consent/privacy-consent.wxml'), 'utf8')
  assert.match(service, /api\.getPrivacySetting/)
  assert.match(wxml, /open-type="agreePrivacyAuthorization"/)
  assert.match(wxml, /bindagreeprivacyauthorization="handleAgreePrivacyAuthorization"/)
  assert.match(wxml, /id="privacy-agree-button"/)
})

test('15 隐私 localStorage 只包含版本和同意时间', () => {
  const { service, stored } = createHarness()
  const result = service.savePrivacyConsent(new Date('2026-09-20T12:00:00.000Z'))
  assert.deepEqual(result, {
    version: service.PRIVACY_CONSENT_VERSION,
    agreedAt: '2026-09-20T12:00:00.000Z'
  })
  assert.deepEqual(stored(), result)
  assert.doesNotMatch(JSON.stringify(result), /openid|tenantId|memberId|client|phone|address|amount|bill|inviteToken/i)
})

test('16 隐私平台状态读取失败时不启动业务', async () => {
  const { service } = createHarness({
    stored: { version: '2026-09-v2', agreedAt: '2026-09-20T12:00:00.000Z' },
    settingError: true
  })
  let started = false
  const allowed = await service.runAfterPrivacyConsent(
    { route: 'pages/index/index' },
    () => { started = true }
  )
  assert.equal(allowed, false)
  assert.equal(started, false)
})
