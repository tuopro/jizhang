const {
  SPEC_DIMENSIONS,
  COVER_WIDTHS,
  availableTeethForDimension,
  findProduct,
  findProductWithAttributes,
  findCoverProduct,
  formatProductLabel,
  normalizeCustomProductName
} = require('../data/product-specs')

const COLOR_ALIASES = [
  { value: '灰色', aliases: ['银灰色', '浅灰色', '灰色', '银灰', '灰', 'gray', 'grey'] },
  { value: '白色', aliases: ['乳白色', '白色', '乳白', '白'] },
  { value: '蓝色', aliases: ['蓝色', '蓝'] },
  { value: '黑色', aliases: ['黑色', '黑'] }
]

const LOGISTICS_ALIASES = [
  { value: '长荣物流', aliases: ['长荣物流', '长荣'] },
  { value: '德邦物流', aliases: ['德邦物流', '德邦'] },
  { value: '安能物流', aliases: ['安能物流', '安能'] },
  { value: '顺丰', aliases: ['顺丰速运', '顺丰'] },
  { value: '中通', aliases: ['中通快运', '中通快递', '中通'] }
]

const SPECIAL_PRODUCT_TAGS = ['定尺', '定制', '非标', '短料', '加长', '裁切', '装潢', '特殊']

function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/　/g, ' ')
    .trim()
}

function normalizeLine(line) {
  return line.replace(/[，；;]/g, ' ').replace(/\s+/g, ' ').trim()
}

function findDimensionMatches(line) {
  const matches = []
  const explicitPattern = /(\d{2,3})\s*[×xX*]\s*(\d{2,3})/g
  let match

  while ((match = explicitPattern.exec(line)) !== null) {
    matches.push({
      start: match.index,
      end: explicitPattern.lastIndex,
      height: Number(match[1]),
      width: Number(match[2]),
      raw: match[0],
      form: 'explicit'
    })
  }

  const tokens = SPEC_DIMENSIONS
    .map(([height, width]) => `${height}${width}`)
    .sort((left, right) => right.length - left.length)
  const compactPattern = new RegExp(tokens.join('|'), 'g')

  while ((match = compactPattern.exec(line)) !== null) {
    const overlapsExplicit = matches.some(item => match.index >= item.start && match.index < item.end)
    if (overlapsExplicit) continue

    const dimensions = SPEC_DIMENSIONS.find(([height, width]) => `${height}${width}` === match[0])
    if (!dimensions) continue
    matches.push({
      start: match.index,
      end: compactPattern.lastIndex,
      height: dimensions[0],
      width: dimensions[1],
      raw: match[0],
      form: 'compact'
    })
  }

  return matches.sort((left, right) => left.start - right.start)
}

function findCoverMatches(line) {
  const matches = []
  const patterns = [
    {
      regex: /(\d{1,3})\s*(?:mm|毫米)?\s*(?:宽)?\s*(盖板|盖子|盖)/gi,
      widthIndex: 1,
      aliasIndex: 2,
      form: 'width-first'
    },
    {
      regex: /(盖板|盖子|盖)\s*(\d{1,3})\s*(?:mm|毫米)?\s*(?:宽)?/gi,
      widthIndex: 2,
      aliasIndex: 1,
      form: 'cover-first'
    }
  ]

  patterns.forEach(definition => {
    let match
    while ((match = definition.regex.exec(line)) !== null) {
      const start = match.index
      const end = definition.regex.lastIndex
      const overlaps = matches.some(item => start < item.end && end > item.start)
      if (overlaps) continue
      matches.push({
        start,
        end,
        width: Number(match[definition.widthIndex]),
        alias: match[definition.aliasIndex],
        raw: match[0],
        form: definition.form
      })
    }
  })

  return matches.sort((left, right) => left.start - right.start)
}

function extractTooth(text) {
  if (/全封闭|全封|封闭/.test(text)) return '全封闭'
  if (/封口/.test(text)) return '封口'
  if (/细齿/.test(text) || /细(?=\s*(?:灰|白|蓝|银|共?\d|$))/.test(text)) return '细齿'
  if (/粗齿|开口/.test(text) || /(?:粗|开)(?=\s*(?:灰|白|蓝|银|共?\d|$))/.test(text)) return '粗齿'
  return null
}

function extractLastColor(text) {
  const lowerText = text.toLowerCase()
  let chosen = null

  COLOR_ALIASES.forEach(group => {
    group.aliases.forEach(alias => {
      const index = lowerText.lastIndexOf(alias.toLowerCase())
      if (index !== -1 && (!chosen || index > chosen.index)) {
        chosen = { value: group.value, index }
      }
    })
  })

  return chosen ? chosen.value : null
}

function isProductLengthMatch(text, matchEnd) {
  return /^\s*(?:长|的|\/\s*根|每根)/.test(text.slice(matchEnd))
}

function findExplicitQuantities(text) {
  const matches = []
  const pattern = /(?:共|数量\s*[:：]?|合计\s*)?\s*(\d+(?:\.\d+)?)\s*(米|m|M|根|箱)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (isProductLengthMatch(text, pattern.lastIndex)) continue
    matches.push({
      quantityText: match[1],
      quantity: Number(match[1]),
      unit: match[2].toLowerCase() === 'm' ? '米' : match[2],
      unitSource: 'explicit',
      start: match.index,
      end: pattern.lastIndex
    })
  }
  return matches
}

function extractQuantity(textAfterSpec) {
  const explicitMatches = findExplicitQuantities(textAfterSpec)
  if (explicitMatches.length) return explicitMatches[explicitMatches.length - 1]

  const withoutWords = textAfterSpec
    .replace(/\d+(?:\.\d+)?\s*米\s*(?:长(?:的)?|的|\/\s*根|每根)/g, ' ')
    .replace(/全封闭|全封|封闭|封口|细齿|粗齿|开口|细|粗|开/g, ' ')
    .replace(/银灰色|浅灰色|乳白色|灰色|白色|蓝色|黑色|银灰|乳白|灰|白|蓝|黑/g, ' ')
    .replace(/[，,。:：]/g, ' ')
  const bare = withoutWords.match(/(?:共|数量\s*)?\s*(\d+(?:\.\d+)?)/)
  if (bare) {
    return {
      quantityText: bare[1],
      quantity: Number(bare[1]),
      unit: '米',
      unitSource: 'enterprise-default'
    }
  }

  return { quantityText: '', quantity: null, unit: '米', unitSource: 'missing' }
}

function extractCustomQuantity(line) {
  const explicitMatches = findExplicitQuantities(line)
  if (explicitMatches.length) return explicitMatches[explicitMatches.length - 1]

  const bare = line.match(/(?:共|数量\s*[:：]?|\s)(\d{1,6}(?:\.\d{1,3})?)\s*$/)
  if (!bare) return null
  return {
    quantityText: bare[1],
    quantity: Number(bare[1]),
    unit: '米',
    unitSource: 'enterprise-default',
    start: bare.index,
    end: line.length
  }
}

function cleanCustomName(text) {
  return text
    .replace(/(?:共|数量\s*[:：]?|合计)\s*$/, '')
    .replace(/[\s，,。:：;；]+$/, '')
    .replace(/((?:长度\s*)?\d+(?:\.\d+)?\s*(?:米|m)\s*长?)\s*的$/i, '$1')
    .trim()
}

function extractProductDescription(segment) {
  const quantityResult = extractCustomQuantity(segment)
  return cleanCustomName(quantityResult ? segment.slice(0, quantityResult.start) : segment)
}

function textAfterLastQuantity(text) {
  const matches = findExplicitQuantities(text)
  return matches.length ? text.slice(matches[matches.length - 1].end) : text
}

function extractProductLength(text) {
  const matches = Array.from(String(text || '').matchAll(
    /(?:长度\s*)?(\d+(?:\.\d+)?)\s*(?:米|m(?!m))\s*(?:长(?:度)?(?:的)?|的|\/\s*根|每根)?/gi
  ))
  if (!matches.length) return null
  const value = Number(matches[matches.length - 1][1])
  return Number.isFinite(value) && value > 0 ? value : null
}

function extractSpecialProductFeatures(text) {
  const source = String(text || '')
  const unitLengthMeters = extractProductLength(source)
  const specialTags = SPECIAL_PRODUCT_TAGS.filter(tag => source.includes(tag))
  return {
    unitLengthMeters,
    productLength: unitLengthMeters ? `${unitLengthMeters}米` : null,
    specialTags,
    hasSpecialAttributes: Boolean(unitLengthMeters || specialTags.length)
  }
}

function extractAnyDimension(text) {
  const explicit = String(text || '').match(/(\d{2,3})\s*[×xX*]\s*(\d{2,3})/)
  if (explicit) return { height: Number(explicit[1]), width: Number(explicit[2]) }
  const known = findDimensionMatches(String(text || ''))[0]
  return known ? { height: known.height, width: known.width } : null
}

function identityFromProduct(product) {
  const fallbackDimension = extractAnyDimension(product.name || '')
  const fallbackFeatures = extractSpecialProductFeatures(product.name || '')
  return {
    height: product.height != null ? Number(product.height) : (fallbackDimension && fallbackDimension.height),
    width: product.width != null ? Number(product.width) : (fallbackDimension && fallbackDimension.width),
    toothType: product.toothType || extractTooth(product.name || ''),
    color: product.color || extractLastColor(product.name || ''),
    unitLengthMeters: product.unitLengthMeters != null
      ? Number(product.unitLengthMeters)
      : fallbackFeatures.unitLengthMeters,
    specialTags: Array.isArray(product.specialTags) ? product.specialTags : fallbackFeatures.specialTags
  }
}

function findCustomProduct(name, customProducts, identity) {
  const normalizedName = normalizeCustomProductName(name)
  const activeProducts = (customProducts || []).filter(product => product.active !== false)
  const exact = activeProducts.find(product => {
    const names = [product.name || product.normalizedName]
      .concat(product.aliases || [], product.recognitionKeywords || [])
    return names.some(candidate => normalizeCustomProductName(candidate) === normalizedName)
  })
  if (exact) return exact

  const expected = identity || {}
  const hasStructuredIdentity = Boolean(
    expected.height && expected.width &&
    (expected.unitLengthMeters || (expected.specialTags && expected.specialTags.length))
  )
  if (!hasStructuredIdentity) return null

  const structuredMatches = activeProducts.filter(product => {
    const current = identityFromProduct(product)
    if (current.height !== Number(expected.height) || current.width !== Number(expected.width)) return false
    if (expected.color && current.color !== expected.color) return false
    if (expected.toothType && current.toothType && current.toothType !== expected.toothType) return false
    if (expected.unitLengthMeters) {
      return current.unitLengthMeters &&
        Math.abs(current.unitLengthMeters - Number(expected.unitLengthMeters)) < 0.000001
    }
    return (expected.specialTags || []).some(tag => (current.specialTags || []).includes(tag))
  })
  return structuredMatches.length === 1 ? structuredMatches[0] : null
}

function buildSuggestedCustomName(identity) {
  const parts = []
  if (identity.color) parts.push(identity.color)
  if (identity.height && identity.width) parts.push(`${identity.height}×${identity.width}`)
  if (identity.toothType) parts.push(identity.toothType)
  const base = parts.join('')
  return identity.unitLengthMeters
    ? `${base || '自定义产品'}-${identity.unitLengthMeters}米长`
    : base
}

function buildCustomCandidate(segment, customProducts, forceCandidate, context) {
  const quantityResult = extractCustomQuantity(segment)
  if (!quantityResult && !forceCandidate) return null

  const rawName = cleanCustomName(quantityResult ? segment.slice(0, quantityResult.start) : segment)
  if (!rawName || normalizeCustomProductName(rawName).length < 2) return null
  const parsedDimension = extractAnyDimension(rawName)
  const features = extractSpecialProductFeatures(rawName)
  const identity = {
    height: context && context.height != null ? Number(context.height) : (parsedDimension && parsedDimension.height),
    width: context && context.width != null ? Number(context.width) : (parsedDimension && parsedDimension.width),
    toothType: context && context.toothType ? context.toothType : extractTooth(rawName),
    color: context && context.color ? context.color : extractLastColor(rawName),
    unitLengthMeters: context && context.unitLengthMeters
      ? Number(context.unitLengthMeters)
      : features.unitLengthMeters,
    specialTags: context && Array.isArray(context.specialTags)
      ? context.specialTags
      : features.specialTags
  }
  const name = context && context.suggestedName ? context.suggestedName : rawName

  const issues = []
  if (!quantityResult || !quantityResult.quantity || quantityResult.quantity <= 0) {
    issues.push({ code: 'QUANTITY_MISSING', message: '没有识别到有效数量', blocking: true })
  } else if (quantityResult.unitSource === 'enterprise-default') {
    issues.push({
      code: 'UNIT_DEFAULTED_TO_METER',
      message: '原文未写单位，已按企业默认单位“米”整理，请入账前确认',
      blocking: false
    })
  }

  if (identity.unitLengthMeters) {
    issues.push({
      code: 'SPECIAL_LENGTH_DETECTED',
      message: `检测到特殊长度：${identity.unitLengthMeters}米/根`,
      blocking: false
    })
  }
  if (identity.specialTags.length) {
    issues.push({
      code: 'SPECIAL_PRODUCT_FEATURE_DETECTED',
      message: `检测到特殊产品描述：${identity.specialTags.join('、')}`,
      blocking: false
    })
  }

  const existing = findCustomProduct(rawName, customProducts, identity)
  if (existing) {
    issues.push({ code: 'CUSTOM_PRODUCT_MATCHED', message: '已优先匹配企业产品库中的自定义规格', blocking: false })
  } else {
    issues.push({
      code: 'CUSTOM_PRODUCT_CREATION_REQUIRED',
      message: identity.unitLengthMeters || identity.specialTags.length
        ? '检测到特殊产品信息，未找到已有自定义规格。请选择已有规格或创建自定义规格。'
        : '未找到已有产品，请确认后创建并加入产品库',
      blocking: true
    })
  }

  return {
    sourceText: segment.trim(),
    height: identity.height || null,
    width: identity.width || null,
    toothType: identity.toothType || null,
    color: identity.color || null,
    productLength: identity.unitLengthMeters ? `${identity.unitLengthMeters}米` : null,
    productLengthMeters: identity.unitLengthMeters || null,
    specialTags: identity.specialTags,
    hasSpecialAttributes: Boolean(identity.unitLengthMeters || identity.specialTags.length),
    quantityText: quantityResult ? quantityResult.quantityText : '',
    quantity: quantityResult ? quantityResult.quantity : null,
    unit: quantityResult ? quantityResult.unit : '米',
    unitSource: quantityResult ? quantityResult.unitSource : 'missing',
    productId: existing ? existing.id : null,
    productLabel: existing ? formatProductLabel(existing) : name,
    status: existing && !issues.some(issue => issue.blocking) ? 'matched' : 'needs_custom_product',
    canCreateCustomProduct: !existing,
    customProductDraft: existing ? null : {
      name,
      normalizedName: normalizeCustomProductName(name),
      aliases: rawName === name ? [] : [rawName],
      recognitionKeywords: [],
      height: identity.height || null,
      width: identity.width || null,
      toothType: identity.toothType || null,
      color: identity.color || null,
      unitLengthMeters: identity.unitLengthMeters || null,
      lengthDescription: identity.unitLengthMeters ? `${identity.unitLengthMeters}米/根` : '',
      specialTags: identity.specialTags,
      note: ''
    },
    issues
  }
}

function parseCoverCandidate(line, cover, previousEnd, nextStart, customProducts) {
  const before = line.slice(previousEnd, cover.start)
  const after = line.slice(cover.end, nextStart)
  const segment = line.slice(previousEnd, nextStart).trim()
  const productDescription = [
    textAfterLastQuantity(before),
    cover.raw,
    extractProductDescription(after)
  ].join(' ')
  const specialFeatures = extractSpecialProductFeatures(productDescription)
  if (specialFeatures.hasSpecialAttributes) {
    const color = extractLastColor(after) || extractLastColor(before)
    return buildCustomCandidate(segment, customProducts, true, {
      color,
      unitLengthMeters: specialFeatures.unitLengthMeters,
      specialTags: specialFeatures.specialTags,
      suggestedName: `${color || ''}${cover.width}mm盖子${specialFeatures.unitLengthMeters ? `-${specialFeatures.unitLengthMeters}米长` : ''}`
    })
  }
  if (!COVER_WIDTHS.includes(cover.width)) {
    return buildCustomCandidate(segment, customProducts, true)
  }

  const issues = []
  const color = extractLastColor(after) || extractLastColor(before)
  const quantityResult = extractQuantity(after)

  if (!quantityResult.quantity || quantityResult.quantity <= 0) {
    issues.push({ code: 'QUANTITY_MISSING', message: '没有识别到有效数量', blocking: true })
  } else if (quantityResult.unitSource === 'enterprise-default') {
    issues.push({ code: 'UNIT_DEFAULTED_TO_METER', message: '原文未写单位，已默认按米识别，请入账前确认', blocking: false })
  }

  if (!color) {
    issues.push({ code: 'COLOR_MISSING', message: '已识别为盖子，但原文未写颜色，请人工选择', blocking: true })
  }

  const product = color ? findCoverProduct(cover.width, color) : null
  const blocking = issues.some(issue => issue.blocking)
  return {
    sourceText: segment,
    productType: 'cover',
    height: null,
    width: cover.width,
    toothType: null,
    color,
    quantityText: quantityResult.quantityText,
    quantity: quantityResult.quantity,
    unit: quantityResult.unit,
    unitSource: quantityResult.unitSource,
    productId: product ? product.id : null,
    productLabel: product
      ? formatProductLabel(product)
      : `${cover.width}mm盖子 / ${color || '待确认颜色'}`,
    status: blocking ? 'needs_confirmation' : 'matched',
    canCreateCustomProduct: false,
    customProductDraft: null,
    issues
  }
}

function parseProductCandidate(line, dimension, previousEnd, nextStart, customProducts) {
  const before = line.slice(previousEnd, dimension.start)
  const after = line.slice(dimension.end, nextStart)
  const segment = line.slice(previousEnd, nextStart).trim()
  const availableTeeth = availableTeethForDimension(dimension.height, dimension.width)

  if (availableTeeth.length === 0) {
    return buildCustomCandidate(segment, customProducts, true)
  }

  const issues = []
  const originalToothType = extractTooth(after) || extractTooth(before)
  let toothType = originalToothType
  const color = extractLastColor(before) || extractLastColor(after)
  const quantityResult = extractQuantity(after)
  const productDescription = [
    textAfterLastQuantity(before),
    dimension.raw,
    extractProductDescription(after)
  ].join(' ')
  const specialFeatures = extractSpecialProductFeatures(productDescription)
  let specialStandardProduct = null
  const exactCustomProduct = findCustomProduct(cleanCustomName(productDescription), customProducts)

  if (exactCustomProduct) {
    return buildCustomCandidate(segment, customProducts, true)
  }

  if (specialFeatures.hasSpecialAttributes) {
    specialStandardProduct = toothType && color
      ? findProductWithAttributes(dimension.height, dimension.width, toothType, color, specialFeatures)
      : null
    if (!specialStandardProduct) {
      const identity = {
        height: dimension.height,
        width: dimension.width,
        toothType,
        color,
        unitLengthMeters: specialFeatures.unitLengthMeters,
        specialTags: specialFeatures.specialTags
      }
      return buildCustomCandidate(segment, customProducts, true, Object.assign({}, identity, {
        suggestedName: buildSuggestedCustomName(identity)
      }))
    }
  }

  if (!toothType) {
    issues.push({ code: 'TOOTH_TYPE_MISSING', message: '无法确定齿型，请人工选择', blocking: true })
  } else if (!availableTeeth.includes(toothType)) {
    const corrected = availableTeeth.length === 1
      ? availableTeeth[0]
      : (toothType === '粗齿' && availableTeeth.includes('细齿') ? '细齿' : null)
    if (corrected) {
      toothType = corrected
      issues.push({
        code: 'TOOTH_TYPE_AUTO_CORRECTED',
        message: `该规格不维护“${originalToothType}”开放齿型，已按产品库自动匹配为“${corrected}”`,
        blocking: false
      })
    } else {
      issues.push({
        code: 'TOOTH_TYPE_UNAVAILABLE',
        message: `该规格不支持“${toothType}”，请从 ${availableTeeth.join('、')} 中选择`,
        blocking: true
      })
      toothType = null
    }
  }

  if (!quantityResult.quantity || quantityResult.quantity <= 0) {
    issues.push({ code: 'QUANTITY_MISSING', message: '没有识别到有效数量', blocking: true })
  } else if (quantityResult.unitSource === 'enterprise-default') {
    issues.push({ code: 'UNIT_DEFAULTED_TO_METER', message: '原文未写单位，已默认按米识别，请入账前确认', blocking: false })
  }

  if (!color) {
    issues.push({ code: 'COLOR_MISSING', message: '原文未写颜色，请人工选择，系统不会猜测', blocking: true })
  }

  let product = specialStandardProduct
  if (!product && toothType && color) {
    product = specialFeatures.hasSpecialAttributes
      ? null
      : findProduct(dimension.height, dimension.width, toothType, color)
    if (!product && !issues.some(issue => issue.blocking)) {
      return buildCustomCandidate(segment, customProducts, true)
    }
  }

  const blocking = issues.some(issue => issue.blocking)
  return {
    sourceText: segment,
    height: dimension.height,
    width: dimension.width,
    toothType,
    originalToothType,
    color,
    quantityText: quantityResult.quantityText,
    quantity: quantityResult.quantity,
    unit: quantityResult.unit,
    unitSource: quantityResult.unitSource,
    productLength: specialFeatures.productLength,
    productLengthMeters: specialFeatures.unitLengthMeters,
    specialTags: specialFeatures.specialTags,
    hasSpecialAttributes: specialFeatures.hasSpecialAttributes,
    productId: product ? product.id : null,
    productLabel: product
      ? formatProductLabel(product)
      : `${dimension.height}×${dimension.width} / ${toothType || '待确认齿型'} / ${color || '待确认颜色'}`,
    status: blocking ? 'needs_confirmation' : 'matched',
    canCreateCustomProduct: false,
    customProductDraft: null,
    issues
  }
}

function isLogisticsLine(line) {
  return /物流|快递|快运|货运|到付|付运费|发[^\s，,。]{2,16}/.test(line)
}

function parseLogistics(lines) {
  const logisticsLines = lines.filter(isLogisticsLine)
  const raw = logisticsLines.join('；')
  if (!raw) return { provider: null, raw: '' }

  const lowerRaw = raw.toLowerCase()
  const providerGroup = LOGISTICS_ALIASES.find(group =>
    group.aliases.some(alias => lowerRaw.includes(alias.toLowerCase()))
  )
  return { provider: providerGroup ? providerGroup.value : null, raw }
}

function mergeDuplicateItems(items) {
  const output = []
  const byKey = Object.create(null)

  items.forEach(item => {
    const canMerge = item.productId && item.status === 'matched' && item.quantity && item.unit
    const key = canMerge ? `${item.productId}|${item.unit}` : null
    const existing = key ? byKey[key] : null

    if (!existing) {
      const clone = Object.assign({}, item, { issues: item.issues.slice(), sourceTexts: [item.sourceText] })
      output.push(clone)
      if (key) byKey[key] = clone
      return
    }

    existing.quantity = Number((existing.quantity + item.quantity).toFixed(3))
    existing.quantityText = String(existing.quantity)
    existing.sourceTexts.push(item.sourceText)
    if (!existing.issues.some(issue => issue.code === 'DUPLICATE_MERGED')) {
      existing.issues.push({ code: 'DUPLICATE_MERGED', message: '检测到重复商品，数量已合并，请确认', blocking: false })
    }
  })

  return output
}

function parseOrderText(inputText, options) {
  const normalized = normalizeText(inputText)
  const customProducts = options && Array.isArray(options.customProducts) ? options.customProducts : []
  if (!normalized) {
    return { items: [], logistics: { provider: null, raw: '' }, unmatchedLines: [], normalizedText: '' }
  }

  const lines = normalized.split('\n').map(normalizeLine).filter(Boolean)
  const items = []
  const unmatchedLines = []

  lines.forEach(line => {
    const candidates = findDimensionMatches(line)
      .map(item => Object.assign({ candidateType: 'wire-duct' }, item))
      .concat(findCoverMatches(line).map(item => Object.assign({ candidateType: 'cover' }, item)))
      .sort((left, right) => left.start - right.start)

    if (candidates.length === 0) {
      const customCandidate = isLogisticsLine(line) ? null : buildCustomCandidate(line, customProducts, false)
      if (customCandidate) items.push(customCandidate)
      else if (!isLogisticsLine(line)) unmatchedLines.push(line)
      return
    }

    candidates.forEach((definition, index) => {
      const previousEnd = index === 0 ? 0 : candidates[index - 1].end
      const nextStart = index === candidates.length - 1 ? line.length : candidates[index + 1].start
      const candidate = definition.candidateType === 'cover'
        ? parseCoverCandidate(line, definition, previousEnd, nextStart, customProducts)
        : parseProductCandidate(line, definition, previousEnd, nextStart, customProducts)
      if (candidate) items.push(candidate)
    })
  })

  return {
    items: mergeDuplicateItems(items),
    logistics: parseLogistics(lines),
    unmatchedLines,
    normalizedText: normalized
  }
}

module.exports = {
  normalizeText,
  findDimensionMatches,
  findCoverMatches,
  parseOrderText
}
