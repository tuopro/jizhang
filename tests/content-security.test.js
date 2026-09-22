const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  MAX_TEXT_CHARACTERS,
  CONTENT_SECURITY_VERSION,
  CONTENT_SECURITY_SCENE,
  collectChangedTextFields,
  splitTextFields,
  normalizeMsgSecCheckResponse,
  assertTextContentSafe
} = require('../services/content-security')

const root = path.resolve(__dirname, '..')

function snapshot(overrides) {
  return Object.assign({
    enterprise: {},
    memberships: [],
    clients: [],
    customProducts: [],
    shipments: [],
    payments: [],
    auditLogs: []
  }, overrides || {})
}

function fieldsFor(action, before, after, result) {
  return collectChangedTextFields({ action, before, after, result })
}

async function rejectedBy(fields, suggestion) {
  return assert.rejects(
    assertTextContentSafe({
      fields,
      openid: 'openid_from_server',
      checkApi: async () => ({ errcode: 0, result: { suggest: suggestion || 'risky', label: 20006 } })
    }),
    error => error && error.code === 'CONTENT_SECURITY_REJECTED' &&
      !/20006|risky|review/i.test(error.message)
  )
}

test('1 安全文本允许创建客户，并使用官方2.0资料场景', async () => {
  const before = snapshot()
  const after = snapshot({ clients: [{ id: 'client_1', name: '杭州电气', contact: '王先生', note: '月底对账' }] })
  const fields = fieldsFor('saveClient', before, after, { id: 'client_1' })
  const calls = []
  const result = await assertTextContentSafe({
    fields,
    openid: 'openid_from_server',
    checkApi: async request => { calls.push(request); return { errcode: 0, result: { suggest: 'pass', label: 100 } } }
  })
  assert.equal(result.checked, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].version, CONTENT_SECURITY_VERSION)
  assert.equal(calls[0].scene, CONTENT_SECURITY_SCENE)
  assert.equal(calls[0].openid, 'openid_from_server')
  assert.match(calls[0].content, /客户名称：杭州电气/)
  assert.match(calls[0].content, /客户联系人：王先生/)
  assert.match(calls[0].content, /客户备注：月底对账/)
})

test('1.1 wx-server-sdk 成功包装的 errCode=0 和 pass 必须放行', async () => {
  const sdkResponse = {
    result: { suggest: 'pass', label: 100 },
    detail: [],
    traceId: 'trace_from_sdk',
    errMsg: 'openapi.security.msgSecCheck:ok',
    errCode: 0
  }
  assert.deepEqual(normalizeMsgSecCheckResponse(sdkResponse), {
    hasResponse: true,
    errcode: 0,
    errmsg: 'openapi.security.msgSecCheck:ok',
    result: { suggest: 'pass', label: 100 }
  })
  const result = await assertTextContentSafe({
    fields: [{ label: '客户名称', value: '测试02' }],
    openid: 'openid_from_server',
    checkApi: async () => sdkResponse
  })
  assert.deepEqual(result, { checked: true, chunkCount: 1 })
})

test('2 风险文本拒绝创建客户', async () => {
  const fields = fieldsFor(
    'saveClient',
    snapshot(),
    snapshot({ clients: [{ id: 'client_1', name: '风险客户', contact: '', note: '' }] }),
    { id: 'client_1' }
  )
  await rejectedBy(fields)
})

test('3 风险 displayName 拒绝成员加入', async () => {
  await rejectedBy([{ label: '企业成员姓名', value: '风险姓名' }])
})

test('4 风险 displayName 拒绝管理员修改成员姓名', async () => {
  const before = snapshot({ memberships: [{ id: 'member_1', displayName: '原姓名' }] })
  const after = snapshot({ memberships: [{ id: 'member_1', displayName: '风险姓名' }] })
  const fields = fieldsFor('updateMemberDisplayName', before, after, { id: 'member_1' })
  assert.deepEqual(fields, [{ label: '企业成员姓名', value: '风险姓名' }])
  await rejectedBy(fields)
})

test('5 风险 sourceText 拒绝正式发货入账', async () => {
  const shipment = { id: 'shipment_1', sourceText: '风险发货原文', note: '', logistics: {}, lines: [] }
  const fields = fieldsFor('postShipment', snapshot(), snapshot({ shipments: [shipment] }), shipment)
  assert.deepEqual(fields, [{ label: '发货原始输入', value: '风险发货原文' }])
  await rejectedBy(fields)

  const lineShipment = {
    id: 'shipment_2', sourceText: '', note: '', logistics: {},
    lines: [{ sourceText: '风险商品行原文' }]
  }
  const lineFields = fieldsFor('postShipment', snapshot(), snapshot({ shipments: [lineShipment] }), lineShipment)
  assert.deepEqual(lineFields, [{ label: '第1项商品原文', value: '风险商品行原文' }])
  await rejectedBy(lineFields)
})

test('6 风险 shipment note 拒绝保存', async () => {
  const shipment = { id: 'shipment_1', sourceText: '', note: '风险发货备注', logistics: {}, lines: [] }
  const fields = fieldsFor('postShipment', snapshot(), snapshot({ shipments: [shipment] }), shipment)
  assert.deepEqual(fields, [{ label: '发货备注', value: '风险发货备注' }])
  await rejectedBy(fields)
})

test('7 风险 payment note 拒绝保存', async () => {
  const payment = { id: 'payment_1', note: '风险收款备注' }
  const fields = fieldsFor('recordPayment', snapshot(), snapshot({ payments: [payment] }), payment)
  assert.deepEqual(fields, [{ label: '收款备注', value: '风险收款备注' }])
  await rejectedBy(fields)
})

test('8 风险账目修正 reason 拒绝保存', async () => {
  const shipment = { id: 'shipment_1', sourceText: '原文', note: '', logistics: {}, lines: [] }
  const before = snapshot({ shipments: [shipment] })
  const after = snapshot({
    shipments: [shipment],
    auditLogs: [{ id: 'audit_1', action: 'UPDATE_SHIPMENT', reason: '风险修正原因' }]
  })
  const fields = fieldsFor('updateShipment', before, after, shipment)
  assert.deepEqual(fields, [{ label: '账目修正原因', value: '风险修正原因' }])
  await rejectedBy(fields)
})

test('9 风险自定义产品名称拒绝保存', async () => {
  const product = { id: 'product_1', name: '风险自定义产品', aliases: [], recognitionKeywords: [], specialTags: [] }
  const fields = fieldsFor('createCustomProduct', snapshot(), snapshot({ customProducts: [product] }), product)
  assert.deepEqual(fields, [{ label: '自定义产品名称', value: '风险自定义产品' }])
  await rejectedBy(fields)
})

test('10 微信内容安全 API 异常时不静默放行，仅保留脱敏诊断', async () => {
  await assert.rejects(
    assertTextContentSafe({
      fields: [{ label: '客户名称', value: '私密客户文本' }],
      openid: 'openid_from_server',
      checkApi: async request => {
        const error = new Error('do not log this generic error message')
        error.errCode = -604101
        error.errMsg = `permission denied content=${request.content} openid=${request.openid} access_token=secret_token`
        throw error
      }
    }),
    error => error && error.code === 'CONTENT_SECURITY_UNAVAILABLE' &&
      error.wechatErrCode === '-604101' &&
      /permission denied/.test(error.wechatErrMsg) &&
      !/私密客户文本|openid_from_server|secret_token/.test(error.wechatErrMsg) &&
      !/do not log/.test(error.message)
  )
})

test('10.1 本地 JavaScript 异常记录脱敏 name/message，不冒充微信错误', async () => {
  await assert.rejects(
    assertTextContentSafe({
      fields: [{ label: '客户名称', value: '私密客户文本' }],
      openid: 'openid_from_server',
      checkApi: async request => {
        throw new TypeError(`adapter failed: ${request.content} openid=${request.openid}`)
      }
    }),
    error => error && error.code === 'CONTENT_SECURITY_UNAVAILABLE' &&
      error.wechatErrCode === undefined && error.wechatErrMsg === undefined &&
      error.localErrorName === 'TypeError' && /adapter failed/.test(error.localErrorMessage) &&
      !/私密客户文本|openid_from_server/.test(error.localErrorMessage)
  )
})

test('10.2 微信原始 v2 非零 errcode 才按 API 异常处理', async () => {
  await assert.rejects(
    assertTextContentSafe({
      fields: [{ label: '客户名称', value: '测试客户' }],
      openid: 'openid_from_server',
      checkApi: async () => ({ errcode: 40001, errmsg: 'invalid credential' })
    }),
    error => error && error.code === 'CONTENT_SECURITY_UNAVAILABLE' &&
      error.wechatErrCode === '40001' && error.wechatErrMsg === 'invalid credential'
  )
})

test('11 没有新增或修改自由文本时跳过检查，已有账单读取不受 API 异常影响', async () => {
  let called = false
  const result = await assertTextContentSafe({
    fields: [],
    openid: 'openid_from_server',
    checkApi: async () => { called = true; throw new Error('不应调用') }
  })
  assert.deepEqual(result, { checked: false, chunkCount: 0 })
  assert.equal(called, false)
})

test('12 金额、日期、ID、电话和固定枚举不参与普通文本审核', () => {
  const before = snapshot({ enterprise: { id: 'tenant_1', name: '企业A', contact: '', address: '', phone: '10000', defaultUnit: '米' } })
  const after = snapshot({ enterprise: { id: 'tenant_1', name: '企业A', contact: '', address: '', phone: '20000', defaultUnit: '根' } })
  assert.deepEqual(fieldsFor('updateEnterprise', before, after, after.enterprise), [])

  const payment = { id: 'payment_1', note: '', amountCents: 10000, paymentDate: '2026-09-20', method: '现金' }
  assert.deepEqual(fieldsFor('recordPayment', snapshot(), snapshot({ payments: [payment] }), payment), [])

  const product = {
    id: 'product_1', name: '', aliases: [], recognitionKeywords: [],
    unitLengthMeters: 1.2, lengthDescription: '1.2米/根', specialTags: ['定尺', '非标']
  }
  assert.deepEqual(
    fieldsFor('createCustomProduct', snapshot(), snapshot({ customProducts: [product] }), product),
    []
  )
})

test('13 前端伪造 contentSafe=true 不会形成服务端放行依据', () => {
  const before = snapshot({ clients: [{ id: 'client_1', name: '原客户', contact: '', note: '' }] })
  const after = snapshot({ clients: [{ id: 'client_1', name: '原客户', contact: '', note: '' }] })
  const fields = collectChangedTextFields({
    action: 'saveClient', before, after, result: { id: 'client_1' },
    args: [{ contentSafe: true, name: '未持久化伪造值' }], contentSafe: true
  })
  assert.deepEqual(fields, [])
})

test('14 直接调用 ledger 云函数仍使用服务端 OPENID 和统一安全检查', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  assert.match(source, /const context = cloud\.getWXContext\(\)/)
  assert.match(source, /mutate\(context\.OPENID, membership, action/)
  assert.match(source, /acceptInvite\(context\.OPENID, event\.payload/)
  assert.match(source, /cloud\.openapi\.security\.msgSecCheck\(request\)/)
  assert.doesNotMatch(source, /event[^\n]*openid|payload[^\n]*openid|contentSafe/)
})

test('14.1 ledger 云函数声明 msgSecCheck 云调用权限', () => {
  const configPath = path.join(root, 'cloudfunctions/ledger/config.json')
  assert.equal(fs.existsSync(configPath), true)
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.ok(config.permissions && Array.isArray(config.permissions.openapi))
  assert.equal(
    config.permissions.openapi.filter(permission => permission === 'security.msgSecCheck').length,
    1
  )
})

test('15 一次请求的多个自由文本字段会组合成一次检查', async () => {
  const calls = []
  await assertTextContentSafe({
    fields: [
      { label: '客户名称', value: '杭州电气' },
      { label: '客户联系人', value: '王先生' },
      { label: '客户备注', value: '月底对账' }
    ],
    openid: 'openid_from_server',
    checkApi: async request => { calls.push(request); return { errcode: 0, result: { suggest: 'pass' } } }
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0].content, /客户名称/)
  assert.match(calls[0].content, /客户联系人/)
  assert.match(calls[0].content, /客户备注/)
})

test('16 超长文本按官方2500字上限安全分段', async () => {
  const fields = [{ label: '发货原始输入', value: '线'.repeat(6000) }]
  const chunks = splitTextFields(fields)
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every(content => Array.from(content).length <= MAX_TEXT_CHARACTERS))
  const calls = []
  await assertTextContentSafe({
    fields,
    openid: 'openid_from_server',
    checkApi: async request => { calls.push(request); return { errcode: 0, result: { suggest: 'pass' } } }
  })
  assert.equal(calls.length, chunks.length)
})

test('17 被拒绝文本在数据库持久化之前拦截', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  const mutateSource = source.slice(source.indexOf('async function mutate'), source.indexOf('async function readAction'))
  assert.ok(mutateSource.indexOf('await assertTextContentSafe') >= 0)
  assert.ok(mutateSource.indexOf('await assertTextContentSafe') < mutateSource.indexOf('await persistChanges'))

  const inviteSource = source.slice(source.indexOf('async function acceptInvite'), source.indexOf('exports.main'))
  assert.ok(inviteSource.indexOf('await assertTextContentSafe') < inviteSource.indexOf("collection('memberships')"))
})

test('18 内容安全实现和错误日志不会输出完整文本、openid或邀请 token', () => {
  const serviceSource = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/services/content-security.js'), 'utf8')
  const indexSource = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  assert.doesNotMatch(serviceSource, /console\.(log|error|warn)/)
  const logLine = indexSource.split('\n').find(line => line.includes('console.error')) || ''
  assert.match(logLine, /\{ action, code, errCode, errMsg, errorName, errorMessage \}/)
  assert.doesNotMatch(logLine, /openid|OPENID|inviteToken|payload|content|access_token|error\.message/)

  const entryLogStart = indexSource.indexOf("console.log('[ledger-content-security-entry]'")
  const entryLogEnd = indexSource.indexOf('\n  })', entryLogStart)
  const entryLog = indexSource.slice(entryLogStart, entryLogEnd)
  assert.ok(entryLogStart >= 0 && entryLogEnd > entryLogStart)
  assert.match(entryLog, /action: 'saveClient'/)
  assert.match(entryLog, /enteredContentSecurity: true/)
  assert.match(entryLog, /fieldCount: safeFields\.length/)
  assert.match(indexSource, /'客户名称': 'client\.name'/)
  assert.match(indexSource, /'客户联系人': 'client\.contact'/)
  assert.match(indexSource, /'客户备注': 'client\.note'/)
  assert.doesNotMatch(entryLog, /OPENID|openid|token|payload|stack|field\.value/)

  const responseLogStart = indexSource.indexOf("console.log('[ledger-msg-sec-response]'")
  const responseLogEnd = indexSource.indexOf('return response', responseLogStart)
  const responseLog = indexSource.slice(responseLogStart, responseLogEnd)
  assert.ok(responseLogStart >= 0 && responseLogEnd > responseLogStart)
  assert.match(responseLog, /hasResponse/)
  assert.match(responseLog, /Object\.keys\(response \|\| \{\}\)/)
  assert.match(responseLog, /response && response\.errCode/)
  assert.match(responseLog, /response && response\.errcode/)
  assert.match(responseLog, /response && response\.result && response\.result\.suggest/)
  assert.match(responseLog, /response && response\.result && response\.result\.label/)
  assert.match(responseLog, /response && \(response\.trace_id \|\| response\.traceId\)/)
  assert.doesNotMatch(responseLog, /request|openid|token|content|payload|stack/)
})

test('19 正常发货的金额、运费和账期字段不进入安全检查', () => {
  const shipment = {
    id: 'shipment_1', sourceText: '', note: '', logistics: { provider: '顺丰', raw: '' }, lines: [],
    clientId: 'client_1', periodId: 'period_1', shipmentDate: '2026-09-20',
    itemsSubtotalCents: 180000, freightCents: 12000, totalAmountCents: 192000
  }
  assert.deepEqual(fieldsFor('postShipment', snapshot(), snapshot({ shipments: [shipment] }), shipment), [])
})

test('20 review 与 risky 一样拒绝，只有明确 pass 才放行', async () => {
  await rejectedBy([{ label: '客户备注', value: '需要人工复核的文本' }], 'review')
  await assert.rejects(
    assertTextContentSafe({
      fields: [{ label: '客户备注', value: '无法判断的文本' }],
      openid: 'openid_from_server',
      checkApi: async () => ({ errcode: 0, result: { suggest: 'unknown' } })
    }),
    error => error && error.code === 'CONTENT_SECURITY_UNAVAILABLE'
  )
})

test('21 物流原始文本和非固定物流商名称接受审核，固定物流商枚举不重复审核', async () => {
  const shipment = {
    id: 'shipment_1', sourceText: '', note: '', lines: [],
    logistics: { provider: '园区专线', raw: '园区专线送货，联系门卫' }
  }
  const fields = fieldsFor('postShipment', snapshot(), snapshot({ shipments: [shipment] }), shipment)
  assert.deepEqual(fields, [
    { label: '物流原始文本', value: '园区专线送货，联系门卫' },
    { label: '物流公司名称', value: '园区专线' }
  ])
  await rejectedBy(fields)

  const fixed = Object.assign({}, shipment, { logistics: { provider: '顺丰', raw: '' } })
  assert.deepEqual(fieldsFor('postShipment', snapshot(), snapshot({ shipments: [fixed] }), fixed), [])
})
