const {
  getWechatPrivacySetting,
  markWechatPrivacyAuthorized,
  savePrivacyConsent,
  takePendingRouteUrl,
  openPrivacyContract
} = require('../../services/privacy-consent')

Page({
  data: {
    checked: false,
    declined: false,
    privacyStatusReady: false,
    needWechatPrivacyAuthorization: false,
    checkingPrivacy: false,
    agreeing: false,
    error: ''
  },

  onLoad() {
    this.refreshPrivacyStatus()
  },

  refreshPrivacyStatus() {
    if (this.data.checkingPrivacy) return
    this.setData({ checkingPrivacy: true, privacyStatusReady: false, error: '' })
    getWechatPrivacySetting({ refresh: true }).then(setting => {
      this.setData({
        checkingPrivacy: false,
        privacyStatusReady: true,
        needWechatPrivacyAuthorization: Boolean(setting.needAuthorization),
        error: ''
      })
    }).catch(() => {
      this.setData({
        checkingPrivacy: false,
        privacyStatusReady: false,
        error: '暂时无法确认微信隐私授权状态，请重试。'
      })
    })
  },

  onConsentChange(event) {
    const values = event && event.detail && event.detail.value || []
    this.setData({ checked: values.includes('agreed') })
  },

  openPrivacyGuide() {
    openPrivacyContract().catch(() => {
      wx.showModal({
        title: '暂时无法打开',
        content: '请稍后重试，或将微信升级到最新版本后查看。',
        showCancel: false
      })
    })
  },

  disagree() {
    this.setData({ checked: false, declined: true, agreeing: false })
  },

  reconsider() {
    this.setData({ checked: false, declined: false, agreeing: false })
    this.refreshPrivacyStatus()
  },

  agreeAndContinue() {
    if (!this.data.checked || !this.data.privacyStatusReady || this.data.agreeing) return
    if (this.data.needWechatPrivacyAuthorization) return
    this.completeConsent()
  },

  handleAgreePrivacyAuthorization() {
    if (!this.data.checked || !this.data.privacyStatusReady || this.data.agreeing) return
    markWechatPrivacyAuthorized()
    this.completeConsent()
  },

  completeConsent() {
    if (this.data.agreeing) return
    this.setData({ agreeing: true })
    try {
      savePrivacyConsent()
    } catch (error) {
      this.setData({ agreeing: false })
      wx.showModal({
        title: '无法保存同意状态',
        content: error.message || '请检查微信存储状态后重试。',
        showCancel: false
      })
      return
    }
    wx.reLaunch({
      url: takePendingRouteUrl(),
      fail: () => {
        this.setData({ agreeing: false })
        wx.showModal({ title: '无法继续', content: '请重新打开小程序。', showCancel: false })
      }
    })
  }
})
