function call(api, method, options) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== 'function') {
      reject(new Error(`当前微信版本不支持 ${method}`))
      return
    }
    api[method](Object.assign({}, options || {}, { success: resolve, fail: reject }))
  })
}

function userCancelled(message) {
  const error = new Error(message || '用户取消相册授权')
  error.code = 'USER_CANCELLED'
  return error
}

async function openAlbumSettings(api) {
  const modal = await call(api, 'showModal', {
    title: '需要相册权限',
    content: '保存账单图片需要写入系统相册。你可以在设置中开启，也可以继续使用预览和分享当前页。',
    confirmText: '去设置',
    cancelText: '暂不'
  })
  if (!modal.confirm) throw userCancelled()
  const setting = await call(api, 'openSetting')
  if (!setting.authSetting || setting.authSetting['scope.writePhotosAlbum'] !== true) {
    throw userCancelled('未开启相册权限')
  }
  return true
}

async function ensureAlbumPermission(api) {
  const setting = await call(api, 'getSetting')
  const state = setting.authSetting && setting.authSetting['scope.writePhotosAlbum']
  if (state === true) return true
  if (state === false) return openAlbumSettings(api)
  try {
    await call(api, 'authorize', { scope: 'scope.writePhotosAlbum' })
    return true
  } catch (error) {
    return openAlbumSettings(api)
  }
}

async function saveImagesToAlbum(api, imagePaths, onProgress) {
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : []
  if (!paths.length) throw new Error('没有可保存的账单图片')
  await ensureAlbumPermission(api)
  for (let index = 0; index < paths.length; index += 1) {
    await call(api, 'saveImageToPhotosAlbum', { filePath: paths[index] })
    if (onProgress) onProgress(index + 1, paths.length)
  }
  return paths.length
}

module.exports = { call, ensureAlbumPermission, saveImagesToAlbum }
