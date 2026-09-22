const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { cleanupWithRetry, createAndDownloadExcel } = require('../services/excel-export-client')
const { cloudPrefix, cleanupStatementExportFile } = require('../cloudfunctions/ledger/services/statement-export-file')
const { createFixture, fakeDatabase } = require('../scripts/performance-fixture')
const member = { id: 'member_a', tenantId: 'tenant_a' }
const fileFor = (m = member) => `cloud://env.bucket/${cloudPrefix(m)}1789990000000-0123456789abcdef01234567.xlsx`
const fileID = fileFor()
const flush = () => new Promise(resolve => setImmediate(resolve))

function clientFixture() {
  const calls = []
  const repository = {
    async createStatementExcel() { calls.push('create'); return { fileID, fileName: 'statement.xlsx' } },
    async cleanupStatementExportFile() { calls.push('cleanup'); return { cleaned: true } }
  }
  const api = {
    cloud: { downloadFile(options) { calls.push('download'); options.success({ tempFilePath: '/tmp/local.xlsx' }) } },
    openDocument(options) { calls.push(['open', options.filePath]); options.success({}) },
    shareFileMessage(options) { calls.push(['share', options.filePath]); options.success({}) },
    showLoading() {}, hideLoading() { calls.push('hideLoading') },
    showModal(options) { calls.push(['modal', options.title]) }
  }
  return { calls, repository, api }
}
function pageFixture() {
  const f = clientFixture()
  const filename = path.resolve(__dirname, '../pages/statement/statement.js')
  let page
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename), wx: f.api, Page: config => { page = config }
  }, { filename })
  page.data = { ...page.data, period: { id: 'period_a' } }
  page.setData = patch => { assert.ok(!page.excelPageUnloaded, 'no updates to unloaded page'); Object.assign(page.data, patch) }
  Object.assign(page, { repository: f.repository, tenantId: 'tenant_a', clientId: 'client_a' })
  return { ...f, page }
}

for (const mode of ['share-success', 'share-cancel', 'share-fail', 'open-fail', 'open-cancel']) {
  test(`页面 ${mode} 使用本地文件，打开/分享前已cleanup且不再依赖云文件`, async () => {
    const f = pageFixture()
    if (mode.startsWith('open-')) f.api.openDocument = options => {
      f.calls.push(['open', options.filePath]); options.fail({ errMsg: mode })
    }
    if (mode === 'share-cancel' || mode === 'share-fail') f.api.shareFileMessage = options => {
      f.calls.push(['share', options.filePath]); options.fail({ errMsg: mode })
    }
    f.page.exportExcel()
    await flush()
    assert.deepEqual(f.calls.slice(0, 4), ['create', 'download', 'cleanup', ['open', '/tmp/local.xlsx']])
    assert.equal(f.page.data.excelReady, true)
    assert.equal(f.page.data.exportingExcel, false)
    if (mode.startsWith('share-')) { f.page.shareExcel(); await flush(); assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'share' && call[1] === '/tmp/local.xlsx')) }
    assert.equal(f.calls.filter(call => call === 'cleanup').length, 1)
    if (mode === 'share-cancel' || mode === 'share-success') assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'modal'))
  })
}

test('下载中退出页面，回调到达后仍cleanup，不对退出页面setData或自动打开', async () => {
  const f = pageFixture()
  let download
  f.api.cloud.downloadFile = options => { download = options; f.calls.push('download') }
  f.page.exportExcel()
  await flush()
  f.page.onUnload()
  download.success({ tempFilePath: '/tmp/local.xlsx' })
  await flush()
  assert.ok(f.calls.includes('cleanup'))
  assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'open'))
})

test('进度回调抛错不能跳过finally cleanup', async () => {
  const f = clientFixture()
  let progressCalls = 0
  const result = await createAndDownloadExcel(f.repository, 't', 'c', 'p', f.api, () => {
    if (++progressCalls === 3) throw new Error('page disposed')
  })
  assert.equal(result.cloudFileCleaned, true)
  assert.deepEqual(f.calls, ['create', 'download', 'cleanup'])
})

test('下载回调没有本地路径时拒绝打开但仍cleanup', async () => {
  const f = clientFixture()
  f.api.cloud.downloadFile = options => options.success({})
  await assert.rejects(createAndDownloadExcel(f.repository, 't', 'c', 'p', f.api), /下载失败/)
  assert.ok(f.calls.includes('cleanup'))
})

test('cleanup首次失败第二次成功，脱敏日志不输出错误正文或fileID', async t => {
  const logs = t.mock.method(console, 'warn', () => {})
  let attempts = 0
  const cleaned = await cleanupWithRetry({ async cleanupStatementExportFile() {
    if (++attempts === 1) throw Object.assign(new Error(fileID), { code: 'private-customer-openid' })
    return { cleaned: true }
  } }, 't', fileID)
  assert.equal(cleaned, true)
  assert.equal(attempts, 2)
  assert.deepEqual(logs.mock.calls[0].arguments, ['[excel-temp-cleanup]', { attempt: 1, code: 'CLEANUP_FAILED' }])
})

test('cleanup两次均失败仍返回本地Excel，不调用账务写入或弹清理错误', async t => {
  t.mock.method(console, 'warn', () => {})
  const f = clientFixture()
  f.repository.cleanupStatementExportFile = async () => { f.calls.push('cleanup'); throw new Error('offline') }
  const result = await createAndDownloadExcel(f.repository, 't', 'c', 'p', f.api)
  assert.equal(result.filePath, '/tmp/local.xlsx')
  assert.equal(result.cloudFileCleaned, false)
  assert.deepEqual(f.calls, ['create', 'download', 'cleanup', 'cleanup'])
})

test('cleanup未确认或调用挂起最多重试一次且有超时，不无限等待', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const response of [undefined, { cleaned: false }, new Promise(() => {})]) {
    let attempts = 0
    assert.equal(await cleanupWithRetry({ cleanupStatementExportFile() { attempts++; return response } }, 't', fileID, 2), false)
    assert.equal(attempts, 2)
  }
})

test('服务端重复删除幂等，支持返回或抛出官方不存在code', async () => {
  for (const missing of [-503003, 'STORAGE_FILE_NONEXIST', 'TCB_STORAGE_FILE_NOT_EXISTS', 'NoSuchKey']) {
    let deleted = false
    const cloud = { async deleteFile() { const status = deleted ? missing : 0; deleted = true; return { fileList: [{ fileID, status }] } } }
    assert.deepEqual(await cleanupStatementExportFile(cloud, member, { fileID }), { cleaned: true })
    assert.deepEqual(await cleanupStatementExportFile(cloud, member, { fileID }), { cleaned: true })
    cloud.deleteFile = async () => { throw Object.assign(new Error('missing'), { code: missing }) }
    assert.deepEqual(await cleanupStatementExportFile(cloud, member, { fileID }), { cleaned: true })
  }
})

for (const [name, invalid] of Object.entries({
  otherTenant: fileFor({ ...member, tenantId: 'tenant_other' }),
  otherMember: fileFor({ ...member, id: 'member_other' }),
  outside: fileID.replace('statement-exports/', 'images/'),
  nested: fileID.replace('statement-exports/', 'other/statement-exports/'),
  image: fileID.replace('.xlsx', '.png'),
  nongenerated: fileID.replace(/178999.*$/, 'manual.xlsx'),
  traversal: fileID.replace('statement-exports/', '../statement-exports/'),
  encoded: fileID.replace('statement-exports/', '%73tatement-exports/'),
  suffix: fileID + '?x=1',
  otherEnvironment: fileID.replace('env.bucket', 'other-env.bucket')
})) {
  test(`cleanup拒绝 ${name}，伪造payload身份不能扩大范围`, async () => {
    let calls = 0
    const cloud = { getWXContext: () => ({ ENV: 'env' }), deleteFile() { calls++ } }
    await assert.rejects(cleanupStatementExportFile(cloud, member, { fileID: invalid, tenantId: 'tenant_other', role: 'admin', memberId: 'member_other' }), /无权清理/)
    assert.equal(calls, 0)
  })
}

test('deleteFile缺失结果、错配fileID和失败状态均不能误报成功或泄露原始错误', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const result of [undefined, {}, { fileList: [] }, { fileList: [{ fileID: 'other', status: 0 }] }, { fileList: [{ fileID, status: -1, errMsg: 'private' }] }]) {
    await assert.rejects(cleanupStatementExportFile({ deleteFile: async () => result }, member, { fileID }), error => {
      assert.match(error.message, /清理未确认/)
      assert.ok(!error.message.includes('private'))
      return true
    })
  }
})

function ledgerFixture() {
  const fixture = createFixture(2, 4)
  const db = fakeDatabase(fixture)
  let calls = 0
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: fixture.openid, ENV: 'env' }),
    async deleteFile({ fileList }) { calls++; return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) } } }
  const filename = path.resolve(__dirname, '../cloudfunctions/ledger/index.js')
  const localRequire = createRequire(filename)
  const sandbox = { exports: {}, require: name => name === 'wx-server-sdk' ? cloud : localRequire(name), console: { log() {}, error() {} } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return { fixture, calls: () => calls, main: sandbox.exports.main }
}

for (const mode of ['active', 'disabled', 'deleted', 'stranger', 'missing-openid', 'forged-other-tenant']) {
  test(`真实ledger action：${mode}，按OPENID及active membership授权且不改数据库`, async () => {
    const h = ledgerFixture()
    const m = h.fixture.snapshot.memberships[0]
    m.role = 'member'
    if (mode === 'disabled') m.status = 'disabled'
    if (mode === 'deleted') h.fixture.snapshot.memberships.splice(0)
    if (mode === 'stranger') h.fixture.openid = 'unknown-openid'
    if (mode === 'missing-openid') h.fixture.openid = ''
    const before = JSON.stringify(h.fixture.snapshot)
    const target = mode === 'forged-other-tenant' ? { ...m, tenantId: 'other' } : m
    const response = await h.main({ action: 'cleanupStatementExportFile', role: 'admin', tenantId: target.tenantId,
      payload: { fileID: fileFor(target), role: 'admin', status: 'active', memberId: m.id, tenantId: target.tenantId } })
    assert.equal(response.ok, mode === 'active', JSON.stringify(response))
    assert.equal(h.calls(), mode === 'active' ? 1 : 0)
    assert.equal(JSON.stringify(h.fixture.snapshot), before)
  })
}
