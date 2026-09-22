const MAX_TEXT_CHARACTERS = 2500
const CONTENT_SECURITY_VERSION = 2
const CONTENT_SECURITY_SCENE = 1
const MAX_WECHAT_ERR_CODE_CHARACTERS = 32
const MAX_WECHAT_ERR_MSG_CHARACTERS = 240
const MAX_LOCAL_ERROR_NAME_CHARACTERS = 80
const MAX_LOCAL_ERROR_MESSAGE_CHARACTERS = 240

const FIXED_LOGISTICS_PROVIDERS = new Set([
  '长荣物流', '德邦物流', '安能物流', '顺丰', '中通'
])
const FIXED_SPECIAL_TAGS = new Set([
  '定尺', '定制', '非标', '短料', '加长', '裁切', '装潢', '特殊'
])

function sanitizeWechatDiagnostic(value, redactions, maxCharacters) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  let diagnostic = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  ;(redactions || [])
    .map(textValue)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .forEach(secret => { diagnostic = diagnostic.split(secret).join('[REDACTED]') })
  diagnostic = diagnostic.replace(
    /(access[_-]?token|openid|inviteToken)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[REDACTED]'
  )
  return sliceCharacters(diagnostic, 0, maxCharacters)
}

function createContentSecurityError(code, message, wechatError, redactions) {
  const error = new Error(message)
  error.code = code
  const hasWechatError = Boolean(wechatError && typeof wechatError === 'object' && (
    wechatError.errCode !== undefined || wechatError.errcode !== undefined ||
    wechatError.errMsg !== undefined || wechatError.errmsg !== undefined
  ))
  const rawErrCode = hasWechatError
    ? (wechatError.errCode !== undefined
        ? wechatError.errCode
        : wechatError.errcode)
    : ''
  const rawErrMsg = hasWechatError
    ? (wechatError.errMsg !== undefined ? wechatError.errMsg : wechatError.errmsg)
    : ''
  const wechatErrCode = sanitizeWechatDiagnostic(
    rawErrCode, redactions, MAX_WECHAT_ERR_CODE_CHARACTERS
  )
  const wechatErrMsg = sanitizeWechatDiagnostic(
    rawErrMsg, redactions, MAX_WECHAT_ERR_MSG_CHARACTERS
  )
  if (wechatErrCode) error.wechatErrCode = wechatErrCode
  if (wechatErrMsg) error.wechatErrMsg = wechatErrMsg
  if (wechatError && typeof wechatError === 'object' && !hasWechatError) {
    const localErrorName = sanitizeWechatDiagnostic(
      wechatError.name, redactions, MAX_LOCAL_ERROR_NAME_CHARACTERS
    )
    const localErrorMessage = sanitizeWechatDiagnostic(
      wechatError.message, redactions, MAX_LOCAL_ERROR_MESSAGE_CHARACTERS
    )
    if (localErrorName) error.localErrorName = localErrorName
    if (localErrorMessage) error.localErrorMessage = localErrorMessage
  }
  return error
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key))
}

function normalizeMsgSecCheckResponse(response) {
  if (!response || typeof response !== 'object') {
    return { hasResponse: false, errcode: null, errmsg: '', result: null }
  }

  // 微信原始 v2 响应使用 errcode/errmsg；wx-server-sdk 成功包装使用 errCode/errMsg。
  const rawCode = hasOwn(response, 'errcode')
    ? response.errcode
    : (hasOwn(response, 'errCode') ? response.errCode : null)
  const numericCode = rawCode === null || rawCode === '' ? null : Number(rawCode)
  const errmsg = hasOwn(response, 'errmsg')
    ? response.errmsg
    : (hasOwn(response, 'errMsg') ? response.errMsg : '')

  return {
    hasResponse: true,
    errcode: Number.isFinite(numericCode) ? numericCode : null,
    errmsg,
    result: response.result && typeof response.result === 'object' ? response.result : null
  }
}

function textValue(value) {
  return String(value == null ? '' : value).trim()
}

function addField(fields, label, value) {
  const text = textValue(value)
  if (text) fields.push({ label, value: text })
}

function addChangedField(fields, label, beforeValue, afterValue) {
  const beforeText = textValue(beforeValue)
  const afterText = textValue(afterValue)
  if (afterText && afterText !== beforeText) addField(fields, label, afterText)
}

function textArray(value) {
  if (!Array.isArray(value)) return []
  return value.map(textValue).filter(Boolean)
}

function addNewArrayFields(fields, label, beforeValue, afterValue, excludedValues) {
  const beforeTexts = new Set(textArray(beforeValue))
  textArray(afterValue).forEach(value => {
    if (!beforeTexts.has(value) && !(excludedValues && excludedValues.has(value))) addField(fields, label, value)
  })
}

function findById(snapshot, collectionName, id) {
  if (!snapshot || !id || !Array.isArray(snapshot[collectionName])) return null
  return snapshot[collectionName].find(item => item && item.id === id) || null
}

function collectShipmentFields(fields, beforeShipment, afterShipment) {
  if (!afterShipment) return
  addChangedField(fields, '发货原始输入', beforeShipment && beforeShipment.sourceText, afterShipment.sourceText)
  addChangedField(fields, '发货备注', beforeShipment && beforeShipment.note, afterShipment.note)

  const beforeLogistics = beforeShipment && beforeShipment.logistics || {}
  const afterLogistics = afterShipment.logistics || {}
  addChangedField(fields, '物流原始文本', beforeLogistics.raw, afterLogistics.raw)
  if (afterLogistics.provider && !FIXED_LOGISTICS_PROVIDERS.has(afterLogistics.provider)) {
    addChangedField(fields, '物流公司名称', beforeLogistics.provider, afterLogistics.provider)
  }

  const beforeLines = beforeShipment && Array.isArray(beforeShipment.lines) ? beforeShipment.lines : []
  const afterLines = Array.isArray(afterShipment.lines) ? afterShipment.lines : []
  const fullSourceText = textValue(afterShipment.sourceText)
  afterLines.forEach((line, index) => {
    const lineSourceText = textValue(line && line.sourceText)
    if (fullSourceText && lineSourceText && fullSourceText.includes(lineSourceText)) return
    addChangedField(
      fields,
      `第${index + 1}项商品原文`,
      beforeLines[index] && beforeLines[index].sourceText,
      lineSourceText
    )
  })
}

function collectNewAuditReasons(fields, before, after) {
  const previousIds = new Set((before && before.auditLogs || []).map(item => item && item.id).filter(Boolean))
  ;(after && after.auditLogs || []).forEach(item => {
    if (!item || previousIds.has(item.id)) return
    addField(fields, '账目修正原因', item.reason)
  })
}

function collectChangedTextFields(input) {
  const action = String(input && input.action || '')
  const before = input && input.before || {}
  const after = input && input.after || {}
  const result = input && input.result || {}
  const fields = []

  if (action === 'updateEnterprise') {
    const previous = before.enterprise || {}
    const current = after.enterprise || {}
    addChangedField(fields, '企业名称', previous.name, current.name)
    addChangedField(fields, '企业联系人', previous.contact, current.contact)
    addChangedField(fields, '企业地址', previous.address, current.address)
  }

  if (action === 'saveClient') {
    const previous = findById(before, 'clients', result.id)
    const current = findById(after, 'clients', result.id)
    addChangedField(fields, '客户名称', previous && previous.name, current && current.name)
    addChangedField(fields, '客户联系人', previous && previous.contact, current && current.contact)
    addChangedField(fields, '客户备注', previous && previous.note, current && current.note)
  }

  if (action === 'createCustomProduct' || action === 'updateCustomProduct') {
    const previous = findById(before, 'customProducts', result.id)
    const current = findById(after, 'customProducts', result.id)
    addChangedField(fields, '自定义产品名称', previous && previous.name, current && current.name)
    addChangedField(fields, '自定义产品备注', previous && previous.note, current && current.note)
    const generatedLengthDescription = current && Number(current.unitLengthMeters) > 0
      ? `${Number(current.unitLengthMeters)}米/根`
      : ''
    if (!generatedLengthDescription || textValue(current && current.lengthDescription) !== generatedLengthDescription) {
      addChangedField(fields, '自定义产品长度描述', previous && previous.lengthDescription, current && current.lengthDescription)
    }
    addNewArrayFields(fields, '自定义产品别名', previous && previous.aliases, current && current.aliases)
    addNewArrayFields(fields, '自定义产品识别关键词', previous && previous.recognitionKeywords, current && current.recognitionKeywords)
    addNewArrayFields(fields, '自定义产品特殊标签', previous && previous.specialTags, current && current.specialTags, FIXED_SPECIAL_TAGS)
  }

  if (action === 'postShipment' || action === 'updateShipment') {
    const previous = findById(before, 'shipments', result.id)
    const current = findById(after, 'shipments', result.id)
    collectShipmentFields(fields, previous, current)
    collectNewAuditReasons(fields, before, after)
  }

  if (action === 'recordPayment') {
    const previous = findById(before, 'payments', result.id)
    const current = findById(after, 'payments', result.id)
    addChangedField(fields, '收款备注', previous && previous.note, current && current.note)
  }

  if (action === 'updateMemberDisplayName') {
    const previous = findById(before, 'memberships', result.id)
    const current = findById(after, 'memberships', result.id)
    addChangedField(fields, '企业成员姓名', previous && previous.displayName, current && current.displayName)
  }

  return fields
}

function characterLength(value) {
  return Array.from(String(value || '')).length
}

function sliceCharacters(value, start, end) {
  return Array.from(String(value || '')).slice(start, end).join('')
}

function splitTextFields(fields, maxCharacters) {
  const limit = Number.isInteger(maxCharacters) && maxCharacters > 8
    ? maxCharacters
    : MAX_TEXT_CHARACTERS
  const chunks = []
  let current = ''

  ;(fields || []).forEach(field => {
    const value = textValue(field && field.value)
    if (!value) return
    const rawLabel = textValue(field && field.label) || '文本'
    const label = sliceCharacters(rawLabel, 0, Math.max(1, limit - 2))
    const prefix = `${label}：`
    const capacity = Math.max(1, limit - characterLength(prefix))

    for (let offset = 0; offset < characterLength(value); offset += capacity) {
      const line = `${prefix}${sliceCharacters(value, offset, offset + capacity)}`
      const separator = current ? '\n' : ''
      if (current && characterLength(current) + characterLength(separator) + characterLength(line) > limit) {
        chunks.push(current)
        current = line
      } else {
        current += `${separator}${line}`
      }
    }
  })

  if (current) chunks.push(current)
  return chunks
}

async function assertTextContentSafe(options) {
  const chunks = splitTextFields(options && options.fields, options && options.maxCharacters)
  if (!chunks.length) return { checked: false, chunkCount: 0 }

  const checkApi = options && options.checkApi
  const openid = textValue(options && options.openid)
  if (typeof checkApi !== 'function' || !openid) {
    throw createContentSecurityError(
      'CONTENT_SECURITY_UNAVAILABLE',
      '内容安全检查暂时不可用，请稍后重试。'
    )
  }

  for (const content of chunks) {
    let response
    try {
      response = await checkApi({
        openid,
        scene: CONTENT_SECURITY_SCENE,
        version: CONTENT_SECURITY_VERSION,
        content
      })
    } catch (error) {
      throw createContentSecurityError(
        'CONTENT_SECURITY_UNAVAILABLE',
        '内容安全检查暂时不可用，请稍后重试。',
        error,
        [content, openid]
      )
    }

    const normalized = normalizeMsgSecCheckResponse(response)
    if (!normalized.hasResponse || normalized.errcode !== 0) {
      throw createContentSecurityError(
        'CONTENT_SECURITY_UNAVAILABLE',
        '内容安全检查暂时不可用，请稍后重试。',
        normalized.hasResponse
          ? { errCode: normalized.errcode, errMsg: normalized.errmsg }
          : null,
        [content, openid]
      )
    }

    const suggestion = textValue(normalized.result && normalized.result.suggest).toLowerCase()
    if (suggestion === 'risky' || suggestion === 'review') {
      throw createContentSecurityError(
        'CONTENT_SECURITY_REJECTED',
        '输入内容可能不符合平台内容安全要求，请修改后重新提交。'
      )
    }
    if (suggestion !== 'pass') {
      throw createContentSecurityError(
        'CONTENT_SECURITY_UNAVAILABLE',
        '内容安全检查暂时不可用，请稍后重试。'
      )
    }
  }

  return { checked: true, chunkCount: chunks.length }
}

module.exports = {
  MAX_TEXT_CHARACTERS,
  CONTENT_SECURITY_VERSION,
  CONTENT_SECURITY_SCENE,
  collectChangedTextFields,
  splitTextFields,
  normalizeMsgSecCheckResponse,
  assertTextContentSafe
}
