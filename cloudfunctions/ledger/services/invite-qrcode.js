const crypto = require('crypto')
const { createServiceError } = require('./service-errors')

const JOIN_PAGE = 'pages/join-enterprise/join-enterprise'
const SCENE_PATTERN = /^[A-Za-z0-9_-]{32}$/
const MAX_IMAGE_BYTES = 384 * 1024

function validateEnvVersion(value) {
  if (!['develop', 'trial', 'release'].includes(value)) {
    throw createServiceError('INVITE_QR_ENV_INVALID', '无法识别当前小程序版本，请重新打开后重试')
  }
  return value
}

function validateSceneCode(value) {
  if (typeof value !== 'string' || !SCENE_PATTERN.test(value)) {
    throw createServiceError('INVITE_INVALID', '邀请小程序码无效')
  }
  return value
}

async function findSceneInvites(source, code) {
  const response = await source.collection('member_invites')
    .where({ qrSceneCode: validateSceneCode(code) }).limit(2).get()
  return response.data || []
}

async function ensureSceneCode(transaction, invite) {
  if (invite.qrSceneCode) {
    const matches = await findSceneInvites(transaction, invite.qrSceneCode)
    if (matches.length !== 1 || matches[0].id !== invite.id) {
      throw createServiceError('INVITE_INVALID', '邀请小程序码无效，请作废邀请后重新生成')
    }
    return invite.qrSceneCode
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Independent 192-bit bearer credential; keep the full entropy of the card token.
    const code = crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    if ((await findSceneInvites(transaction, code)).length) continue
    await transaction.collection('member_invites').doc(invite.id).set({
      data: Object.assign({}, invite, { qrSceneCode: code })
    })
    return code
  }
  throw createServiceError('INVITE_QR_UNAVAILABLE', '小程序码暂时无法生成，请稍后重试')
}

async function generateCodeImage(cloud, code, envVersion) {
  const scene = validateSceneCode(code)
  validateEnvVersion(envVersion)
  let response
  try {
    response = await cloud.openapi.wxacode.getUnlimited({
      scene, page: JOIN_PAGE, envVersion,
      // The join page can exist in trial/develop before its first release.
      checkPath: envVersion === 'release', width: 430
    })
  } catch (error) {
    // SDK errors may contain the request or binary response. Never forward them.
    throw createServiceError('INVITE_QR_UNAVAILABLE', '微信小程序码生成失败，请确认对应版本已上传后重试')
  }
  const buffer = response && response.buffer
  if ((response && (response.errCode || response.errcode)) || !Buffer.isBuffer(buffer) || !buffer.length) {
    throw createServiceError('INVITE_QR_UNAVAILABLE', '微信小程序码生成失败，请稍后重试')
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw createServiceError('INVITE_QR_TOO_LARGE', '小程序码图片过大，请稍后重新生成')
  }
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (!png && !jpeg) throw createServiceError('INVITE_QR_UNAVAILABLE', '微信返回的小程序码图片无效，请稍后重试')
  return { base64: buffer.toString('base64'), extension: png ? 'png' : 'jpg', envVersion }
}

module.exports = { JOIN_PAGE, MAX_IMAGE_BYTES, validateEnvVersion, validateSceneCode, findSceneInvites, ensureSceneCode, generateCodeImage }
