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

test('云函数诊断日志不输出请求内容和身份密钥', () => {
  const source = fs.readFileSync(path.join(root, 'cloudfunctions/ledger/index.js'), 'utf8')
  const logLine = source.split('\n').find(line => line.includes('console.error')) || ''
  assert.match(logLine, /console\.error\('\[ledger\]', \{ action, code, errCode, errMsg, errorName, errorMessage \}\)/)
  assert.doesNotMatch(logLine, /OPENID|openid|payload|error\.message|membership|snapshot|content|access_token/)

  const entryLogStart = source.indexOf("console.log('[ledger-content-security-entry]'")
  const entryLogEnd = source.indexOf('\n  })', entryLogStart)
  const entryLog = source.slice(entryLogStart, entryLogEnd)
  assert.ok(entryLogStart >= 0 && entryLogEnd > entryLogStart)
  assert.doesNotMatch(entryLog, /OPENID|openid|token|payload|stack|field\.value/)

  const responseLogStart = source.indexOf("console.log('[ledger-msg-sec-response]'")
  const responseLogEnd = source.indexOf('return response', responseLogStart)
  const responseLog = source.slice(responseLogStart, responseLogEnd)
  assert.ok(responseLogStart >= 0 && responseLogEnd > responseLogStart)
  assert.doesNotMatch(responseLog, /request|OPENID|openid|token|payload|content|stack/)
})

test('正式配置只申请用户主动保存账单所需的相册写入权限', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.deepEqual(Object.keys(app.permission || {}), ['scope.writePhotosAlbum'])
  assert.match(app.permission['scope.writePhotosAlbum'].desc, /主动点击保存|账单图片/)
  assert.equal(app.requiredPrivateInfos, undefined)
})
