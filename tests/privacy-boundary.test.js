const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  stripPrivateIdentityFields,
  clientSnapshot
} = require('../cloudfunctions/ledger/services/client-snapshot')

const root = path.resolve(__dirname, '..')

test('前端快照递归删除openid、邀请token和云数据库内部字段', () => {
  const safe = stripPrivateIdentityFields({
    _id: 'database_id',
    membership: { openid: 'secret_openid', displayName: '成员A' },
    audit: { before: { _openid: 'internal_openid', token: 'secret_token', status: 'active' } }
  })
  assert.deepEqual(safe, {
    membership: { displayName: '成员A' },
    audit: { before: { status: 'active' } }
  })
})

test('成员前端快照只保留必要展示和授权字段', () => {
  const snapshot = clientSnapshot({
    enterprise: { id: 'tenant_a', name: '企业A' },
    memberships: [{
      id: 'member_a', tenantId: 'tenant_a', openid: 'secret', displayName: '成员A',
      role: 'admin', status: 'active', joinedAt: '2026-09-20', privateNote: '不应下发'
    }]
  })
  assert.deepEqual(snapshot.memberships, [{
    id: 'member_a', tenantId: 'tenant_a', displayName: '成员A', role: 'admin', status: 'active',
    joinedAt: '2026-09-20', createdAt: '', updatedAt: ''
  }])
})

test('云函数错误日志不输出openid、payload、客户对象或错误详情', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  const logLine = source.split('\n').find(line => line.includes('console.error')) || ''
  assert.match(logLine, /console\.error\('\[ledger\]', \{ action, code \}\)/)
  assert.doesNotMatch(logLine, /OPENID|openid|payload|error\.message|membership|snapshot/)
})

test('正式配置未申请位置、相册、摄像头或麦克风权限', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(app.permission, undefined)
  assert.equal(app.requiredPrivateInfos, undefined)
})
