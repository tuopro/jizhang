const PRIVACY_CONSENT_VERSION = '2026-09-v2'
const PRIVACY_CONSENT_STORAGE_KEY = 'ledger_privacy_consent'
const PRIVACY_GATE_URL = '/pages/privacy-consent/privacy-consent'

let pendingRoute = null
let privacySetting = null
let privacySettingPromise = null
let redirecting = false

function getWxApi() {
  return typeof wx === 'undefined' ? null : wx
}

function readPrivacyConsent() {
  const api = getWxApi()
  if (!api || typeof api.getStorageSync !== 'function') return null
  try {
    const value = api.getStorageSync(PRIVACY_CONSENT_STORAGE_KEY)
    return value && typeof value === 'object' ? value : null
  } catch (error) {
    return null
  }
}

function hasCurrentPrivacyConsent() {
  const value = readPrivacyConsent()
  return Boolean(
    value && value.version === PRIVACY_CONSENT_VERSION &&
    typeof value.agreedAt === 'string' && value.agreedAt
  )
}

function savePrivacyConsent(now) {
  const api = getWxApi()
  if (!api || typeof api.setStorageSync !== 'function') {
    throw new Error('当前环境无法保存隐私同意状态')
  }
  const record = {
    version: PRIVACY_CONSENT_VERSION,
    agreedAt: (now instanceof Date ? now : new Date()).toISOString()
  }
  api.setStorageSync(PRIVACY_CONSENT_STORAGE_KEY, record)
  return record
}

function getWechatPrivacySetting(options) {
  const api = getWxApi()
  const refresh = Boolean(options && options.refresh)
  if (refresh) {
    privacySetting = null
    privacySettingPromise = null
  }
  if (privacySetting) return Promise.resolve(privacySetting)
  if (privacySettingPromise) return privacySettingPromise
  if (!api || typeof api.getPrivacySetting !== 'function') {
    privacySetting = { supported: false, needAuthorization: false, privacyContractName: '' }
    return Promise.resolve(privacySetting)
  }

  privacySettingPromise = new Promise((resolve, reject) => {
    api.getPrivacySetting({
      success: result => resolve({
        supported: true,
        needAuthorization: Boolean(result && result.needAuthorization),
        privacyContractName: String(result && result.privacyContractName || '')
      }),
      fail: error => reject(error || new Error('无法读取微信隐私授权状态'))
    })
  }).then(result => {
    privacySetting = result
    privacySettingPromise = null
    return result
  }, error => {
    privacySettingPromise = null
    throw error
  })
  return privacySettingPromise
}

function markWechatPrivacyAuthorized() {
  privacySetting = {
    supported: true,
    needAuthorization: false,
    privacyContractName: privacySetting && privacySetting.privacyContractName || ''
  }
  privacySettingPromise = null
}

function normalizeRoutePath(route) {
  const value = String(route || '').replace(/^\/+/, '')
  return value ? `/${value}` : '/pages/index/index'
}

function copyQuery(query) {
  const copied = {}
  Object.keys(query || {}).forEach(key => {
    const value = query[key]
    if (value !== undefined && value !== null) copied[key] = String(value)
  })
  return copied
}

function rememberPendingRoute(page, options) {
  if (pendingRoute) return
  const route = options && options.route || page && page.route || 'pages/index/index'
  const query = options && options.query || page && page.options || {}
  pendingRoute = { path: normalizeRoutePath(route), query: copyQuery(query) }
}

function buildRouteUrl(route) {
  const value = route || { path: '/pages/index/index', query: {} }
  const queryText = Object.keys(value.query || {}).map(key =>
    `${encodeURIComponent(key)}=${encodeURIComponent(value.query[key])}`
  ).join('&')
  return `${value.path}${queryText ? `?${queryText}` : ''}`
}

function takePendingRouteUrl() {
  const route = pendingRoute
  pendingRoute = null
  return buildRouteUrl(route)
}

function redirectToPrivacyGate(page, options) {
  const api = getWxApi()
  rememberPendingRoute(page, options)
  if (!api || typeof api.reLaunch !== 'function' || redirecting) return false
  redirecting = true
  api.reLaunch({
    url: PRIVACY_GATE_URL,
    complete: () => { redirecting = false }
  })
  return false
}

function ensurePrivacyConsent(page, options) {
  if (!hasCurrentPrivacyConsent()) {
    return Promise.resolve(redirectToPrivacyGate(page, options))
  }
  return getWechatPrivacySetting().then(setting => {
    if (setting.needAuthorization) return redirectToPrivacyGate(page, options)
    return true
  }, () => redirectToPrivacyGate(page, options))
}

function runAfterPrivacyConsent(page, callback, options) {
  return ensurePrivacyConsent(page, options).then(allowed => {
    if (!allowed) return false
    callback()
    return true
  })
}

function openPrivacyContract() {
  const api = getWxApi()
  if (!api || typeof api.openPrivacyContract !== 'function') {
    return Promise.reject(new Error('当前微信版本暂不支持打开隐私保护指引'))
  }
  return new Promise((resolve, reject) => {
    api.openPrivacyContract({ success: resolve, fail: reject })
  })
}

module.exports = {
  PRIVACY_CONSENT_VERSION,
  PRIVACY_CONSENT_STORAGE_KEY,
  PRIVACY_GATE_URL,
  readPrivacyConsent,
  hasCurrentPrivacyConsent,
  savePrivacyConsent,
  getWechatPrivacySetting,
  markWechatPrivacyAuthorized,
  ensurePrivacyConsent,
  runAfterPrivacyConsent,
  takePendingRouteUrl,
  openPrivacyContract
}
