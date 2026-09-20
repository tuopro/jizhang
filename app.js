App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ traceUser: false })
    }
  },

  globalData: {
    tenantId: '',
    dataAccessMode: 'cloud',
    role: ''
  }
})
