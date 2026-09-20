const { getRepository, resetRepository, isCloudMode } = require('../../services/repository-instance')
const { accessReason, isInviteError } = require('../../services/access-control')

Page({
  data: { loading: true, joining: false, enterpriseName: '', displayName: '', error: '' },
  onLoad(options) {
    this.inviteToken = decodeURIComponent(options.inviteToken || '')
    if (!this.inviteToken || !isCloudMode()) {
      this.setData({ loading: false, error: '邀请链接无效，或当前不是正式云端模式。' })
      return
    }
    this.repository = getRepository()
    this.repository.bootstrap().then(() => {
      wx.reLaunch({ url: '/pages/index/index' })
    }).catch(identityError => {
      if (accessReason(identityError) === 'disabled') {
        resetRepository()
        wx.reLaunch({ url: '/pages/unauthorized/unauthorized?reason=disabled' })
        return
      }
      if (identityError && identityError.code && identityError.code !== 'MEMBERSHIP_REQUIRED') {
        resetRepository()
        wx.reLaunch({ url: '/pages/unauthorized/unauthorized?reason=unauthorized' })
        return
      }
      this.repository.inspectInvite(this.inviteToken).then(info => {
        this.setData({ loading: false, enterpriseName: info.enterpriseName, error: '' })
      }).catch(inviteError => {
        this.setData({
          loading: false,
          error: isInviteError(inviteError) ? '邀请无效或已过期。' : (inviteError.message || '邀请无效或已过期。')
        })
      })
    })
  },
  onNameInput(event) { this.setData({ displayName: event.detail.value }) },
  join() {
    if (this.data.joining) return
    const displayName = String(this.data.displayName || '').trim()
    if (displayName.length < 2) {
      wx.showModal({ title: '请填写姓名', content: '请输入企业内部使用的真实姓名或常用姓名。', showCancel: false })
      return
    }
    this.setData({ joining: true })
    wx.showLoading({ title: '正在加入' })
    this.repository.acceptInvite(this.inviteToken, displayName).then(() => {
      wx.hideLoading()
      resetRepository()
      wx.showModal({
        title: '加入成功', content: '现在可以与同事共享同一套企业账本。', showCancel: false,
        success: () => wx.reLaunch({ url: '/pages/index/index' })
      })
    }).catch(error => {
      wx.hideLoading()
      this.setData({ joining: false })
      if (accessReason(error) === 'disabled') {
        resetRepository()
        wx.reLaunch({ url: '/pages/unauthorized/unauthorized?reason=disabled' })
        return
      }
      wx.showModal({
        title: '无法加入',
        content: isInviteError(error) ? '邀请无效或已过期。' : (error.message || '请联系管理员重新生成邀请'),
        showCancel: false
      })
    })
  }
})
