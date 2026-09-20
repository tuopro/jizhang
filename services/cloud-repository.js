const { createMemoryStorage } = require('./storage')
const { createLedgerRepository } = require('./ledger-repository')

function createCloudRepository() {
  const storage = createMemoryStorage()
  let cache = null
  let tenantId = ''
  let identity = null

  function requireReady() {
    if (!cache || !tenantId) throw new Error('企业数据尚未加载，请稍后重试')
    return cache
  }

  function installSnapshot(snapshot) {
    tenantId = snapshot.enterprise.id
    storage.write({ schemaVersion: 1, tenants: { [tenantId]: snapshot } })
    cache = createLedgerRepository(storage)
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
  api.getClientDeletePreview = function (ignoredTenantId, clientId) {
    return call('getClientDeletePreview', { args: [clientId] })
  }
  ;[
    'getEnterprise', 'listClients', 'getClient', 'getCustomerPrice', 'getCustomerPriceForProduct',
    'listCustomerPrices', 'listCustomProducts', 'listProducts', 'getShipment', 'listShipments',
    'listPayments', 'listBillingPeriods', 'getPeriodDetail', 'getClientLedger', 'getDashboard',
    'getStatement', 'getAuditLogs', 'listMembers'
  ].forEach(method => {
    api[method] = function () {
      const args = Array.from(arguments)
      args[0] = tenantId
      return requireReady()[method].apply(null, args)
    }
  })
  api.initializeDemoTenant = () => requireReady().getEnterprise(tenantId)
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
