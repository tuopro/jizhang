const { createMemoryStorage } = require('./storage')
const { createLedgerRepository } = require('./ledger-repository')

function createCloudRepository() {
  const storage = createMemoryStorage()
  let readingSnapshot = false
  let readSnapshot = null
  let cache = null
  let tenantId = ''
  let identity = null

  // A detached working copy exists only during synchronous read/model construction.
  // Domain getters still clone their results; writes always go through the cloud.
  function withReadSnapshot(callback) {
    if (readingSnapshot) return callback()
    readingSnapshot = true
    try { return callback() } finally {
      readingSnapshot = false
      readSnapshot = null
    }
  }

  const viewStorage = {
    read() {
      if (!readingSnapshot) return storage.read()
      if (!readSnapshot) readSnapshot = storage.read()
      return readSnapshot
    },
    write() { throw new Error('云端快照只能通过服务端操作更新') }
  }

  function requireReady() {
    if (!cache || !tenantId) throw new Error('企业数据尚未加载，请稍后重试')
    return cache
  }

  function installSnapshot(snapshot) {
    tenantId = snapshot.enterprise.id
    storage.write({ schemaVersion: 1, tenants: { [tenantId]: snapshot } })
    cache = createLedgerRepository(viewStorage, { actor: identity && Object.assign({}, identity, { id: identity.memberId }) })
  }

  function call(action, payload) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      const unavailable = new Error('当前微信环境无法连接正式云端账本')
      unavailable.code = 'CLOUD_UNAVAILABLE'
      return Promise.reject(unavailable)
    }
    return wx.cloud.callFunction({ name: 'ledger', data: { action, payload: payload || {} } })
      .then(response => {
        const data = response && response.result
        if (!data || data.ok !== true) {
          const error = new Error((data && data.error) || '云端服务返回异常')
          error.code = data && data.code || 'REMOTE_SERVICE_ERROR'
          throw error
        }
        if (action === 'bootstrap' || action === 'acceptInvite') identity = data.result
        if (data.snapshot) installSnapshot(data.snapshot)
        return data.result
      })
  }

  function bootstrap() {
    return call('bootstrap').then(result => {
      identity = result
      return result
    })
  }

  const api = {
    bootstrap,
    withReadSnapshot,
    isCloudRepository: true,
    getIdentity: () => identity,
    inspectInvite: inviteToken => call('inspectInvite', { inviteToken }),
    getActiveMemberInvite: () => call('getActiveMemberInvite'),
    acceptInvite: (inviteToken, displayName) => call('acceptInvite', { inviteToken, displayName }).then(result => {
      identity = result
      return result
    }),
    createMemberInvite: () => call('createMemberInvite'),
    revokeMemberInvite: inviteId => call('revokeMemberInvite', { inviteId })
  }
  api.getStatementExportMeta = function (ignoredTenantId, clientId, periodId) {
    return call('getStatementExportMeta', { clientId, periodId })
  }
  api.getStatementExportPage = function (ignoredTenantId, request) {
    return call('getStatementExportPage', request)
  }
  api.createStatementExcel = function (ignoredTenantId, clientId, periodId) {
    return call('createStatementExcel', { clientId, periodId })
  }
  api.cleanupStatementExportFile = function (ignoredTenantId, fileID) {
    return call('cleanupStatementExportFile', { fileID })
  }
  api.getClientDeletePreview = function (ignoredTenantId, clientId) {
    return call('getClientDeletePreview', { args: [clientId] })
  }
  api.listCustomerPrices = function (ignoredTenantId, clientId) {
    return call('listCustomerPrices', { args: [clientId] })
  }
  ;[
    'getEnterprise', 'listClients', 'getClient', 'getCustomerPrice', 'getCustomerPriceForProduct',
    'getCustomerPriceAccess', 'getCustomProductCreateAccess', 'listCustomProducts', 'listProducts', 'getShipment', 'getShipmentEditContext', 'listShipments',
    'listPayments', 'listBillingPeriods', 'getPeriodDetail', 'getClientLedger', 'getDashboard',
    'getStatement', 'getAuditLogs', 'listMembers'
  ].forEach(method => {
    api[method] = function () {
      const args = Array.from(arguments)
      args[0] = tenantId
      return withReadSnapshot(() => {
        try { return requireReady()[method].apply(null, args) } catch (error) {
          // Quick entry keeps its existing missing-price/manual-confirmation flow.
          // Unauthorized prices are never supplied by the server snapshot.
          if (error.code === 'CUSTOMER_PRICE_FORBIDDEN' &&
            (method === 'getCustomerPrice' || method === 'getCustomerPriceForProduct')) return null
          throw error
        }
      })
    }
  })
  api.initializeDemoTenant = () => api.getEnterprise(tenantId)
  api.initializeTenant = () => { throw new Error('云端企业只能由登录身份初始化') }
  ;[
    'updateEnterprise', 'saveClient', 'saveCustomerPrice', 'createCustomProduct',
    'updateCustomProduct', 'postShipment', 'recordPayment', 'closeBillingPeriod',
    'updateClientOwner', 'updateBillingPeriodOwner', 'updateMemberDisplayName',
    'setMemberStatus', 'assignUnownedClients', 'deleteClient'
  ].forEach(method => {
    api[method] = function () {
      const args = Array.from(arguments)
      return call(method, { args: args.slice(1) })
    }
  })
  api.setCustomProductActive = function (ignoredTenantId, productId, active) {
    return call('setCustomProductActive', { args: [productId, active] })
  }
  api.setProductActive = function (ignoredTenantId, productId, active) {
    return call('setProductActive', { args: [productId, active] })
  }
  api.updateShipment = function (ignoredTenantId, shipmentId, payload) {
    return call('updateShipment', { args: [shipmentId, payload] })
  }
  return api
}

module.exports = { createCloudRepository }
