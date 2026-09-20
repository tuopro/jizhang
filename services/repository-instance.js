const { createWxStorage } = require('./storage')
const { createLedgerRepository } = require('./ledger-repository')
const { createCloudRepository } = require('./cloud-repository')
const { DEMO_TENANT_ID } = require('../data/demo-seed')

let repository = null
let readyPromise = null
let activeTenantId = DEMO_TENANT_ID

function shouldUseCloud() {
  if (typeof wx === 'undefined' || typeof getApp !== 'function') return false
  const app = getApp()
  return Boolean(app && app.globalData && app.globalData.dataAccessMode === 'cloud')
}

function getRepository() {
  if (!repository) {
    repository = shouldUseCloud()
      ? createCloudRepository()
      : createLedgerRepository(createWxStorage())
  }
  return repository
}

function prepareRepository() {
  const current = getRepository()
  if (!shouldUseCloud()) {
    current.initializeDemoTenant()
    activeTenantId = DEMO_TENANT_ID
    return Promise.resolve({ tenantId: activeTenantId, role: 'local-demo' })
  }
  if (!readyPromise) {
    const pending = current.bootstrap().then(identity => {
      activeTenantId = identity.tenantId
      return identity
    })
    readyPromise = pending.then(identity => {
      readyPromise = null
      return identity
    }, error => {
      readyPromise = null
      throw error
    })
  }
  return readyPromise
}

function getActiveTenantId() {
  return activeTenantId
}

function isCloudMode() {
  return shouldUseCloud()
}

function resetRepository() {
  repository = null
  readyPromise = null
  activeTenantId = DEMO_TENANT_ID
}

module.exports = {
  getRepository,
  prepareRepository,
  getActiveTenantId,
  isCloudMode,
  resetRepository
}
