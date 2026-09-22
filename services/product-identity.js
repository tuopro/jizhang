const { SPEC_DIMENSIONS } = require('../data/product-specs')

const COLOR_ALIASES = [
  { value: '灰色', aliases: ['银灰色', '浅灰色', '灰色', '银灰', '灰', 'gray', 'grey'] },
  { value: '白色', aliases: ['乳白色', '白色', '乳白', '白'] },
  { value: '蓝色', aliases: ['蓝色', '蓝'] },
  { value: '黑色', aliases: ['黑色', '黑'] }
]

const SPECIAL_PRODUCT_TAGS = ['定尺', '定制', '非标', '短料', '加长', '裁切', '装潢', '特殊', '底槽']

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

function specialTagsFromProduct(product, features) {
  const fallback = features || extractSpecialProductFeatures(product.name || '')
  // Legacy products may have an empty tag array but an explicit 底槽 name.
  return Array.from(new Set((Array.isArray(product.specialTags) ? product.specialTags : fallback.specialTags)
    .concat(fallback.specialTags.includes('底槽') ? fallback.specialTags : [])))
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
    specialTags: specialTagsFromProduct(product, fallbackFeatures)
  }
}

// 底槽 is a mandatory identity boundary, including exact aliases/keywords.
// Preserve existing non-bottom special-product matching behavior.
function compatibleBottomGrooveIdentity(expected, current) {
  const expectedTags = expected.specialTags || []
  const currentTags = current.specialTags || []
  if (expectedTags.includes('底槽') !== currentTags.includes('底槽')) return false
  if (!expectedTags.includes('底槽')) return true
  const tags = values => Array.from(new Set(values)).sort().join('|')
  if (tags(expectedTags) !== tags(currentTags)) return false
  if (Math.abs(Number(expected.unitLengthMeters || 0) - Number(current.unitLengthMeters || 0)) > 0.000001) return false
  return ['height', 'width', 'color', 'toothType'].every(field =>
    !expected[field] || !current[field] || expected[field] === current[field])
}

function sameBottomGrooveIdentity(expected, current) {
  return (expected.specialTags || []).includes('底槽') &&
    compatibleBottomGrooveIdentity(expected, current) &&
    ['height', 'width', 'color', 'toothType'].every(field => expected[field] && expected[field] === current[field])
}

module.exports = {
  findDimensionMatches, extractTooth, extractLastColor, extractProductLength,
  extractSpecialProductFeatures, extractAnyDimension, identityFromProduct, specialTagsFromProduct,
  compatibleBottomGrooveIdentity, sameBottomGrooveIdentity
}
