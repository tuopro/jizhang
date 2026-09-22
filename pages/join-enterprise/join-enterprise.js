const { getRepository, resetRepository, isCloudMode } = require('../../services/repository-instance')
const { accessReason } = require('../../services/access-control')
const { runAfterPrivacyConsent } = require('../../services/privacy-consent')
const { parseInviteOptions, formatInviteExpiry } = require('../../services/invite-qrcode')

Page({
  data: { loading: true, joining: false, enterpriseName: '', expiresAtText: '', inviteStatus: '', displayName: '', error: '' },
  onLoad(options) {
    this.inviteOptions = options || {}
    this._unloaded = false
    this.refreshInvite()
  },
  onShow() {
    // onLoad handles the first show. Every return from the background rechecks.
    if (this._shown) this.refreshInvite()
    this._shown = true
  },
  onUnload() { this._unloaded = true; this._request = (this._request || 0) + 1 },
  refreshInvite() {
    return runAfterPrivacyConsent(this, () => this.loadInvite(this.inviteOptions), {
      route: 'pages/join-enterprise/join-enterprise', query: this.inviteOptions || {}
    })
  },
  async loadInvite(options) {
    if (this._unloaded || this.data.joining) return
    const request = this._request = (this._request || 0) + 1
    this.credential = parseInviteOptions(options)
    this.setData({ loading: true, enterpriseName: '', expiresAtText: '', inviteStatus: '', error: '' })
    if (!this.credential || !isCloudMode()) {
      this.setData({ loading: false, error: '邀请链接或小程序码无效，或当前不是正式云端模式。' })
      return
    }
    this.repository = getRepository()
    try {
      // Inspect first: unknown/malformed/other-enterprise scenes must not fall
      // through bootstrap and open a cached or unrelated enterprise.
      const info = await this.repository.inspectInvite(this.credential)
      if (this._unloaded || this._request !== request) return
      if (info.alreadyMember) {
        resetRepository()
        wx.showToast({ title: '你已加入该企业', icon: 'none' })
        wx.reLaunch({ url: '/pages/index/index' })
        return
      }
      this.setData({ loading: false, enterpriseName: info.enterpriseName,
        expiresAtText: formatInviteExpiry(info.expiresAt), inviteStatus: '有效', error: '' })
    } catch (error) {
      if (this._unloaded || this._request !== request) return
      if (accessReason(error) === 'disabled') {
        resetRepository()
        wx.reLaunch({ url: '/pages/unauthorized/unauthorized?reason=disabled' })
        return
      }
      this.setData({ loading: false, error: error.message || '邀请无效或已过期。' })
    }
  },
  onNameInput(event) { this.setData({ displayName: event.detail.value }) },
  join() {
    if (this._unloaded || this.data.joining || this.data.loading || this.data.error || !this.credential) return
    const displayName = String(this.data.displayName || '').trim()
    if (displayName.length < 2) {
      wx.showModal({ title: '请填写姓名', content: '请输入企业内部使用的真实姓名或常用姓名。', showCancel: false })
      return
    }
    return runAfterPrivacyConsent(this, () => {
      if (this._unloaded || this.data.joining) return
      this.setData({ joining: true })
      wx.showLoading({ title: '正在加入' })
      this.repository.acceptInvite(this.credential, displayName).then(() => {
        wx.hideLoading()
        resetRepository()
        if (this._unloaded) return
        wx.showModal({
          title: '加入成功', content: '现在可以与同事共享同一套企业账本。', showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/index/index' })
        })
      }).catch(error => {
        wx.hideLoading()
        if (this._unloaded) return
        this.setData({ joining: false })
        if (accessReason(error) === 'disabled') {
          resetRepository()
          wx.reLaunch({ url: '/pages/unauthorized/unauthorized?reason=disabled' })
          return
        }
        if (error.code === 'ALREADY_MEMBER') {
          resetRepository()
          wx.showToast({ title: '你已加入该企业', icon: 'none' })
          wx.reLaunch({ url: '/pages/index/index' })
          return
        }
        this.setData({ error: error.message || '请联系管理员重新生成邀请' })
        wx.showModal({ title: '无法加入', content: this.data.error, showCancel: false })
      })
    }, { route: 'pages/join-enterprise/join-enterprise', query: this.inviteOptions || {} })
  }
})
