const { loadPage, handleAccessError } = require('../../services/page-context')
const { loadStatementExportDocument } = require('../../services/statement-export-client')
const { paginateStatement, PAGE_LAYOUT } = require('../../services/statement-paginator')
const { renderStatementPage } = require('../../services/statement-image-renderer')
const { saveImagesToAlbum } = require('../../services/photo-album')

function canvasToTempFile(canvas) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      x: 0,
      y: 0,
      width: PAGE_LAYOUT.width,
      height: PAGE_LAYOUT.height,
      destWidth: PAGE_LAYOUT.width,
      destHeight: PAGE_LAYOUT.height,
      fileType: 'png',
      quality: 1,
      success: result => resolve(result.tempFilePath),
      fail: error => reject(error || new Error('Canvas 图片生成失败'))
    })
  })
}

Page({
  data: {
    generating: true,
    saving: false,
    progressText: '准备账单数据…',
    saveProgress: '',
    error: '',
    imagePaths: [],
    currentIndex: 0,
    currentPath: '',
    pageLabel: '',
    totalPages: 0
  },

  onLoad(options) {
    this.clientId = options.clientId || ''
    this.periodId = options.periodId || ''
  },

  onReady() {
    this.generate()
  },

  generate() {
    if (this.generatingTask) return this.generatingTask
    this.setData({ generating: true, error: '', imagePaths: [], currentPath: '', progressText: '读取账单数据…' })
    this.generatingTask = new Promise((resolve, reject) => {
      loadPage(this, (repository, tenantId) => {
        loadStatementExportDocument(repository, tenantId, this.clientId, this.periodId, progress => {
          const label = progress.resource === 'shipments' ? '发货记录' : progress.resource === 'payments' ? '收款记录' : '账单信息'
          this.setData({ progressText: `正在读取${label}… ${progress.loaded || ''}`.trim() })
        }).then(document => this.createImages(document)).then(resolve, reject)
      }, reject)
    })
    const finish = () => {
      this.generatingTask = null
      this.setData({ generating: false })
    }
    this.generatingTask = this.generatingTask.then(value => {
      finish()
      return value
    }, error => {
      this.canvasTask = null
      if (!handleAccessError(error)) {
        this.setData({ error: error.message || '账单图片生成失败' })
        wx.showModal({ title: '生成失败', content: error.message || '请稍后重试', showCancel: false })
      }
      finish()
    })
    return this.generatingTask
  },

  getCanvas() {
    if (this.canvasTask) return this.canvasTask
    this.canvasTask = new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#statementCanvas').fields({ node: true, size: true }).exec(result => {
        const canvas = result && result[0] && result[0].node
        if (!canvas) {
          reject(new Error('无法创建账单 Canvas，请重试'))
          return
        }
        canvas.width = PAGE_LAYOUT.width
        canvas.height = PAGE_LAYOUT.height
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('当前微信版本不支持账单图片 Canvas'))
          return
        }
        resolve({ canvas, context })
      })
    })
    return this.canvasTask
  },

  async createImages(document) {
    const { canvas, context } = await this.getCanvas()
    const measureText = (value, size, weight) => {
      context.font = `${weight || '400'} ${size}px sans-serif`
      return context.measureText(String(value == null ? '' : value)).width
    }
    const pages = paginateStatement(document, { measureText })
    const imagePaths = []
    for (let index = 0; index < pages.length; index += 1) {
      this.setData({ progressText: `正在生成第 ${index + 1} / ${pages.length} 页…` })
      renderStatementPage(context, document, pages[index])
      imagePaths.push(await canvasToTempFile(canvas))
    }
    this.document = document
    this.pages = pages
    this.setData({
      imagePaths,
      currentIndex: 0,
      currentPath: imagePaths[0] || '',
      pageLabel: imagePaths.length ? `第 1 / ${imagePaths.length} 页` : '',
      totalPages: imagePaths.length,
      progressText: ''
    })
  },

  retry() {
    this.generate()
  },

  setCurrent(index) {
    const paths = this.data.imagePaths
    if (!paths.length) return
    const next = Math.max(0, Math.min(paths.length - 1, Number(index)))
    this.setData({ currentIndex: next, currentPath: paths[next], pageLabel: `第 ${next + 1} / ${paths.length} 页` })
  },

  previousPage() {
    this.setCurrent(this.data.currentIndex - 1)
  },

  nextPage() {
    this.setCurrent(this.data.currentIndex + 1)
  },

  previewAll() {
    if (!this.data.imagePaths.length) return
    wx.previewImage({ current: this.data.currentPath, urls: this.data.imagePaths })
  },

  shareCurrent() {
    if (!this.data.currentPath || this.data.generating) return
    if (typeof wx.showShareImageMenu !== 'function') {
      wx.showModal({ title: '当前微信版本不支持', content: '请先保存当前账单图片，再从微信相册发送。', showCancel: false })
      return
    }
    wx.showShareImageMenu({
      path: this.data.currentPath,
      fail: error => {
        const message = String(error && error.errMsg || '')
        if (/cancel/i.test(message)) return
        wx.showModal({ title: '分享失败', content: '可先保存图片，再从微信相册发送。', showCancel: false })
      }
    })
  },

  saveAll() {
    if (this.data.saving || this.data.generating || !this.data.imagePaths.length) return
    this.setData({ saving: true, saveProgress: '准备保存…' })
    saveImagesToAlbum(wx, this.data.imagePaths, (saved, total) => {
      this.setData({ saveProgress: `已保存 ${saved} / ${total}` })
    }).then(total => {
      wx.showToast({ title: `已保存 ${total} 张`, icon: 'success' })
    }).then(total => {
      this.setData({ saving: false })
      return total
    }, error => {
      this.setData({ saving: false })
      if (error && error.code === 'USER_CANCELLED') {
        wx.showToast({ title: '未保存图片', icon: 'none' })
        return
      }
      wx.showModal({
        title: '保存失败',
        content: `${error.message || '请稍后重试'}。已保存的图片仍保留在相册中，可再次尝试。`,
        showCancel: false
      })
    })
  }
})
