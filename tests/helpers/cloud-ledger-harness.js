const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { setup, copy, tenantId } = require('./shipment-correction-fixture')

// Execute the real cloud entry point and domain with an in-memory transactional
// database. No network or production data. Failed callbacks never commit writes.
function cloudHarness(creator) {
  const c = setup(creator)
  let root = c.storage.read()
  Object.values(root.tenants).forEach(t => { t.memberInvites = [] })
  let version = 0
  const fields = {
    clients: 'clients', products: 'customProducts', customer_prices: 'customerPrices',
    shipments: 'shipments', payments: 'payments', billing_periods: 'billingPeriods',
    audit_logs: 'auditLogs', memberships: 'memberships', member_invites: 'memberInvites'
  }
  const h = {
    c, openid: c.members.owner.openid, queries: [], security: [], qrRequests: [], logs: [], attempts: 0, commits: 0,
    read: () => copy(root),
    change(callback) { callback(root.tenants[tenantId], root); version += 1 }
  }
  function source(getRoot, scope) {
    return {
      collection(name) {
        const rows = () => Object.values(getRoot().tenants).flatMap(t => name === 'enterprises' ? [t.enterprise] : (t[fields[name]] || []))
        return {
          doc(id) {
            return {
              async get() {
                h.queries.push({ scope, name, id })
                const data = rows().find(row => row.id === id)
                if (!data) throw new Error('document not found')
                return { data: copy(data) }
              },
              async set({ data }) {
                assert.notEqual(scope, 'outside', 'writes must be transactional')
                const t = getRoot().tenants[data.tenantId]
                if (name === 'enterprises') t.enterprise = copy(data)
                else {
                  const list = t[fields[name]]
                  const index = list.findIndex(row => row.id === id)
                  if (index >= 0) list[index] = copy(data)
                  else list.push(copy(data))
                }
              },
              async remove() {
                assert.notEqual(scope, 'outside')
                for (const t of Object.values(getRoot().tenants)) t[fields[name]] = t[fields[name]].filter(row => row.id !== id)
              }
            }
          },
          where(criteria) {
            return { limit(limit) { return { async get() {
              h.queries.push({ scope, name, criteria: copy(criteria) })
              return { data: copy(rows().filter(row => Object.entries(criteria).every(([key, value]) => row[key] === value)).slice(0, limit)) }
            } } } }
          }
        }
      }
    }
  }
  const db = source(() => root, 'outside')
  db.runTransaction = async callback => {
    if (h.beforeTransaction) { const hook = h.beforeTransaction; h.beforeTransaction = null; hook() }
    for (let retry = 0; retry < 3; retry += 1) {
      h.attempts += 1
      const readVersion = version
      const draft = copy(root)
      const result = await callback(source(() => draft, `transaction-${h.attempts}`))
      if (h.beforeCommit) { const hook = h.beforeCommit; h.beforeCommit = null; hook() }
      if (version !== readVersion) continue // Model database optimistic conflict retry.
      if (JSON.stringify(draft) !== JSON.stringify(root)) { root = draft; version += 1 }
      h.commits += 1
      return result
    }
    throw new Error('transaction conflict')
  }
  const cloud = {
    init() {}, database: () => db, getWXContext: () => ({ OPENID: h.openid }),
    openapi: { security: { msgSecCheck: async request => {
      h.security.push(copy(request))
      return { errCode: 0, result: { suggest: h.rejectText ? 'risky' : 'pass', label: 100 } }
    } }, wxacode: { getUnlimited: async request => {
      h.qrRequests.push(copy(request))
      if (h.onQRCode) return h.onQRCode(request)
      return { buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9eUAAAAASUVORK5CYII=', 'base64') }
    } } }
  }
  const filename = path.resolve(__dirname, '../../cloudfunctions/ledger/index.js')
  const localRequire = createRequire(filename)
  const sandbox = {
    exports: {}, require: name => name === 'wx-server-sdk' ? cloud : localRequire(name),
    console: { log(...args) { h.logs.push(args) }, error(...args) { h.logs.push(args) } }
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename })
  h.main = sandbox.exports.main
  h.save = (extra, id = c.shipment.id) => h.main({
    action: 'updateShipment', tenantId: 'forged-tenant', role: 'admin', memberId: c.members.admin.id,
    payload: { tenantId: 'forged-tenant', role: 'admin', memberId: c.members.admin.id, args: [id, c.payload(extra)] }
  })
  return h
}

module.exports = { cloudHarness }
