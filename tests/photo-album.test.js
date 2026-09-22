const test = require('node:test')
const assert = require('node:assert/strict')

const { ensureAlbumPermission, saveImagesToAlbum } = require('../services/photo-album')

function api(overrides) {
  return Object.assign({
    getSetting({ success }) { success({ authSetting: { 'scope.writePhotosAlbum': true } }) },
    authorize({ success }) { success({}) },
    showModal({ success }) { success({ confirm: true }) },
    openSetting({ success }) { success({ authSetting: { 'scope.writePhotosAlbum': true } }) },
    saveImageToPhotosAlbum({ success }) { success({}) }
  }, overrides || {})
}

test('首次相册授权后按顺序保存全部图片并报告进度', async () => {
  const saved = []
  const progress = []
  const wxApi = api({
    getSetting({ success }) { success({ authSetting: {} }) },
    saveImageToPhotosAlbum({ filePath, success }) { saved.push(filePath); success({}) }
  })
  const count = await saveImagesToAlbum(wxApi, ['a.png', 'b.png'], (done, total) => progress.push([done, total]))
  assert.equal(count, 2)
  assert.deepEqual(saved, ['a.png', 'b.png'])
  assert.deepEqual(progress, [[1, 2], [2, 2]])
})

test('曾拒绝相册权限时允许进入设置重新开启', async () => {
  let opened = false
  const wxApi = api({
    getSetting({ success }) { success({ authSetting: { 'scope.writePhotosAlbum': false } }) },
    openSetting({ success }) { opened = true; success({ authSetting: { 'scope.writePhotosAlbum': true } }) }
  })
  await ensureAlbumPermission(wxApi)
  assert.equal(opened, true)
})

test('用户取消重新授权时不写相册且返回可识别取消状态', async () => {
  let saved = false
  const wxApi = api({
    getSetting({ success }) { success({ authSetting: { 'scope.writePhotosAlbum': false } }) },
    showModal({ success }) { success({ confirm: false, cancel: true }) },
    saveImageToPhotosAlbum({ success }) { saved = true; success({}) }
  })
  await assert.rejects(saveImagesToAlbum(wxApi, ['a.png']), error => error.code === 'USER_CANCELLED')
  assert.equal(saved, false)
})
