const { loadPage } = require('../../services/page-context')
const { getRepository, isCloudMode, resetRepository } = require('../../services/repository-instance')
const { canShowDeveloperTools } = require('../../services/runtime-flags')

Page({
  data: { enterpriseName: '', modeText: '', roleText: '管理员', displayName: '', isAdmin: false, showDeveloperTools: false },
  onShow() {
    loadPage(this, (repository, tenantId) => {
      const identity = repository.isCloudRepository && repository.getIdentity()
      this.setData({
        enterpriseName: repository.getEnterprise(tenantId).name,
        modeText: isCloudMode() ? '微信云端账本' : '本机演示账本',
        roleText: identity && identity.role === 'member' ? '成员' : '管理员',
        displayName: identity && identity.displayName || '管理员',
        isAdmin: !identity || identity.role !== 'member',
        showDeveloperTools: canShowDeveloperTools(identity || { role: 'admin' })
      })
    })
  },
  go(event) {
    const url = event.currentTarget.dataset.url
    if (url === '/pages/clients/clients') wx.switchTab({ url })
    else wx.navigateTo({ url })
  },
  logout() {
    wx.showModal({
      title: '退出登录', content: '将清除本机缓存并退出当前账本。微信身份不会被删除，下次进入仍可登录所属企业。', confirmText: '确认退出',
      success: result => {
        if (!result.confirm) return
        wx.clearStorageSync()
        resetRepository()
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  }
})
