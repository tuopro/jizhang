const { isCloudMode } = require('../../services/repository-instance')
const { loadPage } = require('../../services/page-context')

Page({
  data: { cloud: false },
  onLoad() {
    loadPage(this, () => this.setData({ cloud: isCloudMode() }))
  }
})
