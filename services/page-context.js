const {
  getRepository,
  prepareRepository,
  getActiveTenantId,
  isCloudMode,
  resetRepository
} = require('./repository-instance')
const { isAccessError, accessReason } = require('./access-control')
const { runAfterPrivacyConsent } = require('./privacy-consent')

let redirectingForAccess = false

function handleAccessError(error) {
  if (!isAccessError(error)) return false
  resetRepository()
  if (redirectingForAccess) return true
  redirectingForAccess = true
  const reason = accessReason(error)
  wx.reLaunch({
    url: `/pages/unauthorized/unauthorized?reason=${reason}`,
    complete: () => { redirectingForAccess = false }
  })
  return true
}

function loadPage(page, callback, onError) {
  runAfterPrivacyConsent(page, () => {
    if (!isCloudMode()) {
      getRepository().initializeDemoTenant()
      callback(getRepository(), getActiveTenantId())
      return
    }
    const repository = getRepository()
    const refreshing = page && page._loadedRepository === repository
    if (!refreshing) wx.showLoading({ title: '加载中' })
    else if (wx.showNavigationBarLoading) wx.showNavigationBarLoading()
    const finishLoading = () => {
      if (!refreshing) wx.hideLoading()
      else if (wx.hideNavigationBarLoading) wx.hideNavigationBarLoading()
    }
    prepareRepository().then(() => {
      finishLoading()
      const current = getRepository()
      current.withReadSnapshot(() => callback(current, getActiveTenantId()))
      if (page) page._loadedRepository = current
    }).catch(error => {
      finishLoading()
      if (handleAccessError(error)) {
        if (onError) onError(error)
        return
      }
      if (onError) {
        onError(error)
        return
      }
      wx.showModal({
        title: '数据加载失败',
        content: error.message || '请检查云开发环境和 ledger 云函数',
        showCancel: false
      })
    })
  })
}

function handleMutation(result, onSuccess, onError) {
  if (result && typeof result.then === 'function') {
    wx.showLoading({ title: '保存中' })
    result.then(value => {
      wx.hideLoading()
      onSuccess(value)
    }).catch(error => {
      wx.hideLoading()
      if (handleAccessError(error)) return
      if (onError) onError(error)
      else wx.showModal({ title: '保存失败', content: error.message || '请稍后重试', showCancel: false })
    })
    return
  }
  onSuccess(result)
}

module.exports = { loadPage, handleMutation, handleAccessError }
