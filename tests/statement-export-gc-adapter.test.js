const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createStorageAdapter, requireRuntime } = require('../cloudfunctions/statement-export-gc/services/storage-adapter')
const { AGE_MS, CURSOR_KEY, runGc } = require('../cloudfunctions/statement-export-gc/services/gc')
const policy = require('../cloudfunctions/statement-export-gc/services/export-file-policy')
const key = `statement-exports/${'a'.repeat(24)}/${'b'.repeat(24)}/1789990000000-${'c'.repeat(24)}.xlsx`
// Deliberately synthetic placeholders; no real credentials are loaded by tests.
const runtime = { TENCENTCLOUD_RUNENV: 'SCF', TENCENTCLOUD_SECRETID: 'mock-runtime-id',
  TENCENTCLOUD_SECRETKEY: 'mock-runtime-key', TENCENTCLOUD_SESSIONTOKEN: 'mock-session', TCB_ENV: 'env', TENCENTCLOUD_REGION: 'ap-shanghai' }
function adapterFixture(basePath = '') {
  const calls = []
  const config = { env: 'env', bucket: 'bucket', region: 'ap-shanghai', basePath }
  const physical = name => basePath ? `${basePath}/${name}` : name
  const responses = {
    getBucket: { IsTruncated: 'false', Contents: [{ Key: physical(key), LastModified: '2026-09-20T12:00:00Z', ETag: 'etag' }] },
    headObject: { headers: { 'last-modified': 'Sun, 20 Sep 2026 12:00:00 GMT', date: 'Tue, 22 Sep 2026 12:00:00 GMT', etag: 'etag' } },
    getObject: { Body: Buffer.from(JSON.stringify({ version: 1, marker: key })) }, putObject: {}
  }
  const cos = Object.fromEntries(Object.keys(responses).map(method => [method, (options, done) => {
    calls.push({ method, options })
    const result = responses[method]
    done(result instanceof Error ? result : null, result instanceof Error ? undefined : result)
  }]))
  class Manager {
    constructor(options) { calls.push({ method: 'manager', options }); this.storage = {
      getStorageConfig: () => config, getCos: () => cos, cloudPathToFileId: name => `cloud://env.bucket/${name}`
    } }
    currentEnvironment() { return { lazyInit: async () => {} } }
  }
  const cloud = { async deleteFile(options) {
    calls.push({ method: 'delete', options })
    return { fileList: options.fileList.map(fileID => ({ fileID, status: 0 })) }
  } }
  return { calls, config, responses, cloud, Manager, create: () => createStorageAdapter(cloud, runtime, Manager) }
}

for (const field of ['TENCENTCLOUD_RUNENV', 'TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'TENCENTCLOUD_SESSIONTOKEN']) {
  test(`GC 缺少官方临时运行时 ${field} 时关闭清理，不降级为长期凭证`, async () => {
    const env = { ...runtime }; delete env[field]
    let created = false
    await assert.rejects(createStorageAdapter({}, env, class { constructor() { created = true } }), { code: 'GC_CREDENTIALS_UNAVAILABLE' })
    assert.equal(created, false)
  })
}

test('GC 仅使用服务端当前环境，缺失/异常环境拒绝', () => {
  assert.equal(requireRuntime(runtime), 'env')
  assert.equal(requireRuntime({ ...runtime, TCB_ENV: undefined, SCF_NAMESPACE: 'env-alt' }), 'env-alt')
  for (const TCB_ENV of ['', '../other']) assert.throws(() => requireRuntime({ ...runtime, TCB_ENV }), { code: 'GC_STORAGE_UNAVAILABLE' })
})

for (const basePath of ['', 'shared/environment-a']) {
  test(`GC ${basePath || '独立桶'} 适配器固定prefix和真实HEAD LastModified，删除只交给云存储fileID接口`, async () => {
    const f = adapterFixture(basePath)
    const adapter = await f.create()
    const page = await adapter.listPage('', 100)
    assert.equal(page.files[0].Key, key)
    assert.equal(page.hasMore, false)
    const head = await adapter.head(key)
    assert.equal(head.LastModified, 'Sun, 20 Sep 2026 12:00:00 GMT')
    assert.notEqual(head.LastModified, f.responses.headObject.headers.date)
    assert.equal((await adapter.deleteBatch([key]))[0].status, 0)
    assert.deepEqual(f.calls.find(call => call.method === 'manager').options, { envId: 'env', region: 'ap-shanghai' })
    const list = f.calls.find(call => call.method === 'getBucket').options
    assert.equal(list.Prefix, `${basePath ? basePath + '/' : ''}statement-exports/`)
    assert.equal(list.MaxKeys, 100)
    assert.equal(list.Bucket, 'bucket')
    assert.deepEqual(f.calls.find(call => call.method === 'delete').options.fileList, [`cloud://env.bucket/${key}`])
  })
}

test('GC 游标只读写固定小型云对象，不设置ACL或读写数据库', async () => {
  const f = adapterFixture('shared/environment-a')
  const adapter = await f.create()
  assert.equal(await adapter.loadCursor(), key)
  await adapter.saveCursor(key)
  const write = f.calls.find(call => call.method === 'putObject').options
  assert.equal(write.Key, `shared/environment-a/${CURSOR_KEY}`)
  assert.deepEqual(JSON.parse(write.Body), { version: 1, marker: key })
  assert.equal(write.ACL, undefined)
  await assert.rejects(adapter.saveCursor('other/file'), { code: 'GC_INVALID_CURSOR' })
})

test('GC 不存在、损坏或超大的游标安全从头扫描', async () => {
  const f = adapterFixture()
  const adapter = await f.create()
  for (const result of [Object.assign(new Error('missing'), { code: 'NoSuchKey' }), { Body: 'bad json' },
    { Body: 'x'.repeat(4097) }, { Body: '{"version":1,"marker":"other/"}' }, { Body: '{"version":2,"marker":""}' }]) {
    f.responses.getObject = result
    assert.equal(await adapter.loadCursor(), '')
  }
  f.responses.getObject = Object.assign(new Error('denied'), { code: 'AccessDenied' })
  await assert.rejects(adapter.loadCursor(), { code: 'AccessDenied' })
})

test('GC SDK环境元数据不匹配或共享前缀非法时拒绝', async () => {
  for (const patch of [{ env: 'other' }, { bucket: '' }, { region: '' }, { basePath: '../other' }]) {
    const f = adapterFixture()
    Object.assign(f.config, patch)
    await assert.rejects(f.create(), { code: 'GC_STORAGE_UNAVAILABLE' })
    assert.equal(f.calls.length, 1)
  }
})

test('GC 适配器拒绝非法前缀/删除key/批次大小/共享桶外响应', async () => {
  const f = adapterFixture('shared/environment-a')
  const adapter = await f.create()
  for (const name of ['other/x.xlsx', '../' + key, key.replace('.xlsx', '.png')]) {
    await assert.rejects(adapter.head(name), { code: 'GC_INVALID_PAGE' })
    await assert.rejects(adapter.deleteBatch([name]), { code: 'GC_INVALID_PAGE' })
  }
  await assert.rejects(adapter.listPage('other/', 100), { code: 'GC_INVALID_PAGE' })
  await assert.rejects(adapter.listPage('', 101), { code: 'GC_INVALID_PAGE' })
  await assert.rejects(adapter.deleteBatch(Array(21).fill(key)), { code: 'GC_INVALID_PAGE' })
  f.responses.getBucket.Contents[0].Key = 'shared/other-environment/' + key
  await assert.rejects(adapter.listPage('', 100), { code: 'GC_INVALID_PAGE' })
})

test('GC adapter保留逐文件失败/不存在状态，不把缺失返回当成功', async () => {
  const f = adapterFixture()
  f.cloud.deleteFile = async () => ({ fileList: [{ fileID: `cloud://env.bucket/${key}`, status: -503003 }] })
  const adapter = await f.create()
  assert.equal((await adapter.deleteBatch([key]))[0].status, -503003)
  f.cloud.deleteFile = async () => ({ fileList: [{ fileID: 'other', status: 0 }] })
  assert.equal((await adapter.deleteBatch([key]))[0].status, 'CLEANUP_UNCONFIRMED')
})

function entryFixture(openid = '') {
  const now = Date.now()
  let created = 0
  const deleted = []
  const logs = []
  const old = { Key: key, LastModified: new Date(now - AGE_MS - 10000).toISOString() }
  const fresh = { Key: key.replace(/c{24}\.xlsx$/, 'd'.repeat(24) + '.xlsx'), LastModified: new Date(now).toISOString() }
  const storage = { loadCursor: async () => '', saveCursor: async () => {},
    listPage: async () => ({ files: [old, fresh], hasMore: false }), head: async () => old,
    deleteBatch: async keys => { deleted.push(...keys); return keys.map(key => ({ key, status: 0 })) } }
  const cloud = { init() {}, getWXContext: () => ({ OPENID: openid }) }
  const filename = path.resolve(__dirname, '../cloudfunctions/statement-export-gc/index.js')
  const sandbox = { exports: {}, require: name => {
    if (name === 'wx-server-sdk') return cloud
    if (name === './services/gc') return { runGc }
    if (name === './services/export-file-policy') return policy
    if (name === './services/storage-adapter') return { createStorageAdapter: async (...args) => { assert.equal(args.length, 1); created++; return storage } }
    throw new Error('unexpected dependency')
  }, console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args) } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  return { main: sandbox.exports.main, deleted, logs, created: () => created }
}

test('GC 真正入口忽略伪造Type/TriggerName/prefix/cutoff/age/deleteAll/fileID/tenantId，不能删除新文件', async () => {
  const f = entryFixture()
  const result = await f.main({ Type: 'Timer', TriggerName: 'statementExportGcHourly', prefix: '/', directory: '/', cutoff: '9999-01-01',
    age: 0, deleteAll: true, fileID: 'cloud://other/images/x.png', tenantId: 'other' })
  assert.equal(result.ok, true)
  assert.equal(result.deleted, 1)
  assert.deepEqual(f.deleted, [key])
  assert.ok(!JSON.stringify(f.logs).includes(key))
})

test('GC 使用真实上下文拒绝小程序主动调用，伪造Timer事件无效', async () => {
  const f = entryFixture('actual-wechat-user')
  assert.equal((await f.main({ Type: 'Timer', OPENID: '', deleteAll: true })).code, 'GC_CLIENT_CALL_REJECTED')
  assert.equal(f.created(), 0)
  assert.equal(f.deleted.length, 0)
})
