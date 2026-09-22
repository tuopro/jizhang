const test = require('node:test')
const assert = require('node:assert/strict')
const { runGc, AGE_MS, LIMITS, CURSOR_KEY } = require('../cloudfunctions/statement-export-gc/services/gc')
const NOW = Date.parse('2026-09-22T12:00:00.000Z')
const iso = time => new Date(time).toISOString()
const key = (n, tenant = 'a', member = 'b') => `statement-exports/${tenant.repeat(24)}/${member.repeat(24)}/1789990000000-${n.toString(16).padStart(24, '0')}.xlsx`
const row = (n, age = AGE_MS, extra = {}) => ({ Key: key(n), LastModified: iso(NOW - age), ETag: 'original', ...extra })
function fixture(rows) {
  const objects = new Map(rows.map(file => [file.Key, { ...file }]))
  const state = { cursor: '', pages: [], batches: [], heads: [], logs: [] }
  const storage = {
    async loadCursor() { return state.cursor },
    async saveCursor(marker) { state.cursor = marker },
    async listPage(marker, limit) {
      state.pages.push({ marker, limit })
      const sorted = [...objects.values()].filter(file => file.Key > marker).sort((a, b) => a.Key < b.Key ? -1 : 1)
      const files = sorted.slice(0, limit).map(file => ({ ...file }))
      return { files, hasMore: sorted.length > limit, nextMarker: files.length ? files[files.length - 1].Key : '' }
    },
    async head(name) {
      state.heads.push(name)
      if (!objects.has(name)) throw Object.assign(new Error('missing'), { code: 'NoSuchKey' })
      return { ...objects.get(name) }
    },
    async deleteBatch(keys) {
      state.batches.push(keys)
      return keys.map(name => ({ key: name, status: objects.delete(name) ? 0 : -503003 }))
    }
  }
  const run = (limits, clock = () => NOW) => runGc(storage, { clock, limits, log: entry => state.logs.push(entry) })
  return { objects, state, storage, run }
}

test('GC 使用真实 LastModified：47h59m、未来、无时区及无效日期不删，48h边界可删', async () => {
  const f = fixture([row(1, AGE_MS - 60000), row(2), row(3, AGE_MS + 1), row(4, -1000),
    row(5, 0, { LastModified: 'invalid' }), row(6, 0, { LastModified: '2020-01-01T00:00:00' }),
    row(7, 0, { LastModified: '2026-09-20T20:00:00+08:00' })])
  const result = await f.run()
  assert.deepEqual(f.state.batches.flat(), [key(2), key(3), key(7)])
  assert.equal(result.deleted, 3)
  assert.equal(f.objects.size, 4)
})

test('GC 不按文件名时间戳删文件，也不删除非项目生成xlsx、图片或游标', async () => {
  const f = fixture([row(1, 1000), row(2, AGE_MS, { Key: key(2).replace('1789990000000', '9999999999999') }),
    row(3, AGE_MS, { Key: 'statement-exports/manual.xlsx' }), row(4, AGE_MS, { Key: key(4).replace('.xlsx', '.png') }),
    row(5, AGE_MS, { Key: CURSOR_KEY })])
  assert.equal((await f.run()).deleted, 1)
  assert.ok(f.objects.has(key(1)))
  assert.equal(f.objects.size, 4)
})

test('GC 分页跨tenant/member目录，删除后使用字典序marker继续，不因数组位移漏页', async () => {
  const rows = Array.from({ length: 13 }, (_, i) => row(i + 1, AGE_MS, { Key: key(i + 1, i < 7 ? 'a' : 'c', i % 2 ? 'b' : 'd') }))
  const f = fixture(rows)
  const result = await f.run({ pageSize: 3 })
  assert.equal(result.deleted, 13)
  assert.equal(f.objects.size, 0)
  assert.equal(f.state.pages.length, 5)
  assert.equal(f.state.cursor, '')
})

test('GC 单次删除尝试上限200，每批最多20；保存游标让新实例继续剩余文件', async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => row(i + 1)))
  const first = await f.run()
  assert.equal(first.deleted, LIMITS.maxDeleted)
  assert.equal(first.hasMore, true)
  assert.ok(f.state.batches.every(batch => batch.length <= 20))
  assert.equal(f.state.cursor, key(200))
  const next = await runGc({ ...f.storage }, { clock: () => NOW })
  assert.equal(next.deleted, 5)
  assert.equal(f.objects.size, 0)
  assert.equal(f.state.cursor, '')
})

test('GC 扫描上限1000后保存游标，下一轮能越过大量年轻文件', async () => {
  const f = fixture([...Array.from({ length: 1000 }, (_, i) => row(i + 1, 0)), row(1001)])
  assert.equal((await f.run()).scanned, 1000)
  assert.equal(f.state.cursor, key(1000))
  assert.equal((await f.run()).deleted, 1)
})

test('GC 部分删除失败继续处理其它文件，失败项在下一轮全目录扫描重试', async () => {
  const f = fixture([row(1), row(2), row(3)])
  const original = f.storage.deleteBatch
  f.storage.deleteBatch = async keys => {
    const results = await original(keys.filter(name => name !== key(2)))
    return [...results, { key: key(2), status: 'AccessDenied', errMsg: 'private content' }]
  }
  const result = await f.run()
  assert.equal(result.deleted, 2)
  assert.equal(result.failed, 1)
  assert.deepEqual(f.state.logs, [{ code: 'AccessDenied' }])
  f.storage.deleteBatch = original
  assert.equal((await f.run()).deleted, 1)
  assert.equal((await f.run()).deleted, 0)
})

test('GC 全批失败和空删除结果不误报成功，仍受尝试次数上限保护', async () => {
  for (const response of [null, new Error('private content')]) {
    const f = fixture(Array.from({ length: 6 }, (_, i) => row(i + 1)))
    f.storage.deleteBatch = async () => { if (response instanceof Error) throw response; return response }
    const result = await f.run({ maxDeleted: 4, batchSize: 2 })
    assert.equal(result.deleted, 0)
    assert.equal(result.failed, 4)
    assert.equal(result.hasMore, true)
    assert.equal(f.state.cursor, key(4))
    assert.ok(!JSON.stringify(f.state.logs).includes('private'))
  }
})

test('GC list与HEAD之间文件被更新或ETag变化时跳过，HEAD已不存在视为幂等', async () => {
  const f = fixture([row(1), row(2), row(3), row(4)])
  const original = f.storage.head
  f.storage.head = async name => {
    if (name === key(1)) f.objects.get(name).LastModified = iso(NOW)
    if (name === key(2)) f.objects.get(name).ETag = 'changed'
    if (name === key(3)) f.objects.delete(name)
    if (name === key(4)) throw Object.assign(new Error('private'), { code: 'AccessDenied' })
    return original(name)
  }
  const result = await f.run()
  assert.equal(result.deleted, 0)
  assert.equal(result.changed, 2)
  assert.equal(result.missing, 1)
  assert.equal(result.failed, 1)
  assert.equal(f.state.batches.length, 0)
})

test('GC 扫描中新增年轻文件不会被误删', async () => {
  const f = fixture([row(1), row(3)])
  const original = f.storage.listPage
  f.storage.listPage = async (...args) => {
    const result = await original(...args)
    f.objects.set(key(2), row(2, 0))
    return result
  }
  const result = await f.run({ pageSize: 1 })
  assert.equal(result.deleted, 2)
  assert.ok(f.objects.has(key(2)))
})

test('GC 超过本轮时间预算后保存进度，下一轮继续', async () => {
  const f = fixture([row(1), row(2), row(3)])
  let now = NOW
  const original = f.storage.deleteBatch
  f.storage.deleteBatch = async keys => { const result = await original(keys); now += LIMITS.maxRunMs; return result }
  assert.equal((await f.run({ batchSize: 1 }, () => now)).deleted, 1)
  assert.equal(f.state.cursor, key(1))
  f.storage.deleteBatch = original
  assert.equal((await f.run()).deleted, 2)
})

test('GC 无效持久游标安全重置，空目录可重复执行', async () => {
  const f = fixture([])
  f.state.cursor = 'other/../file'
  assert.equal((await f.run()).scanned, 0)
  assert.equal(f.state.cursor, '')
  assert.deepEqual(f.state.logs, [{ code: 'GC_INVALID_CURSOR' }])
  assert.equal((await f.run()).deleted, 0)
})

for (const [name, page] of Object.entries({
  outside: { files: [row(1, AGE_MS, { Key: 'other/file.xlsx' })], hasMore: false },
  traversal: { files: [row(1, AGE_MS, { Key: 'statement-exports/../file.xlsx' })], hasMore: false },
  backwards: { files: [row(2), row(1)], hasMore: false },
  repeated: { files: [row(1), row(1)], hasMore: false },
  emptyContinuation: { files: [], hasMore: true, nextMarker: key(1) },
  wrongContinuation: { files: [row(1)], hasMore: true, nextMarker: key(2) },
  oversized: { files: Array.from({ length: 101 }, (_, i) => row(i + 1)), hasMore: false }
})) {
  test(`GC 无效列表 ${name} 在删除前拒绝`, async () => {
    const f = fixture([])
    f.storage.listPage = async () => page
    await assert.rejects(f.run(), { code: 'GC_INVALID_PAGE' })
    assert.equal(f.state.batches.length, 0)
  })
}

test('GC 文件已被即时cleanup删除时，批量返回不存在仍幂等成功', async () => {
  const f = fixture([row(1)])
  f.storage.deleteBatch = async keys => keys.map(name => ({ key: name, status: -503003 }))
  assert.equal((await f.run()).deleted, 1)
})
