const { call, saveImagesToAlbum } = require('./photo-album')

function parseInviteOptions(options) {
  const input = options || {}
  try {
    if (Object.prototype.hasOwnProperty.call(input, 'scene')) {
      if (Object.prototype.hasOwnProperty.call(input, 'inviteToken') || typeof input.scene !== 'string') return null
      // WeChat getUnlimited passes its encoded scene through Page.onLoad.
      const code = decodeURIComponent(input.scene)
      return /^[A-Za-z0-9_-]{32}$/.test(code) ? { qrSceneCode: code } : null
    }
    if (typeof input.inviteToken !== 'string') return null
    const token = decodeURIComponent(input.inviteToken)
    return token || null
  } catch (error) {
    return null
  }
}

function currentEnvVersion(api) {
  let value
  try { value = api.getAccountInfoSync().miniProgram.envVersion } catch (error) { /* fail closed */ }
  if (!['develop', 'trial', 'release'].includes(value)) throw new Error('无法识别当前小程序版本，请重新打开后重试')
  return value
}

function formatInviteExpiry(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间无效'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

let fileSequence = 0
async function writeCodeImage(api, image) {
  if (!image || !['png', 'jpg'].includes(image.extension) || typeof image.base64 !== 'string' ||
      !image.base64.length || image.base64.length > 524288 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
    throw new Error('小程序码图片无效，请重新生成')
  }
  const fs = api.getFileSystemManager()
  const filePath = `${api.env.USER_DATA_PATH}/ledger-invite-qr-${Date.now()}-${++fileSequence}.${image.extension}`
  try {
    await call(fs, 'writeFile', { filePath, data: image.base64, encoding: 'base64' })
    return filePath
  } catch (error) {
    await removeCodeImage(api, filePath)
    throw new Error('图片保存到本机失败，请稍后重试')
  }
}

async function removeCodeImage(api, filePath) {
  const prefix = `${api.env && api.env.USER_DATA_PATH}/ledger-invite-qr-`
  if (typeof filePath !== 'string' || !filePath.startsWith(prefix) ||
      !/^\d+-\d+\.(png|jpg)$/.test(filePath.slice(prefix.length))) return
  try { await call(api.getFileSystemManager(), 'unlink', { filePath }) } catch (error) { /* best effort, local only */ }
}

function previewCodeImage(api, filePath) {
  return call(api, 'previewImage', { current: filePath, urls: [filePath] })
}

function saveCodeImage(api, filePath) {
  return saveImagesToAlbum(api, [filePath], null, {
    permissionMessage: '保存邀请二维码需要写入系统相册。你可以在设置中开启，也可以继续预览小程序码。'
  })
}

module.exports = { parseInviteOptions, currentEnvVersion, formatInviteExpiry, writeCodeImage, removeCodeImage, previewCodeImage, saveCodeImage }
