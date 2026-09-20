Page({
  data: {
    disabled: false,
    title: '德赛企业记账',
    message: '本工具仅供本企业授权成员使用。'
  },

  onLoad(options) {
    const disabled = options && options.reason === 'disabled'
    this.setData({
      disabled,
      message: disabled
        ? '你的企业成员账号已停用，请联系管理员。'
        : '本工具仅供本企业授权成员使用。'
    })
  },

  retry() {
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
