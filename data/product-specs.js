// 规格高×宽与 availableTeeth 来自现有 CNDES 报价小程序 data/products.js。
// 只复用产品事实，不复制 basePrice；本项目不存在通用价或市场价。
const SPEC_DIMENSIONS = [
  [20, 15], [20, 20], [20, 25],
  [25, 20], [25, 25], [25, 50],
  [30, 15], [30, 20], [30, 25], [30, 30], [30, 35], [30, 40], [30, 50],
  [35, 25], [35, 30], [35, 35], [35, 40],
  [40, 25], [40, 30], [40, 35], [40, 40], [40, 60],
  [45, 25], [45, 33], [45, 45],
  [50, 20], [50, 25], [50, 30], [50, 35], [50, 40], [50, 45], [50, 50], [50, 55], [50, 60], [50, 80], [50, 100],
  [60, 25], [60, 30], [60, 35], [60, 40], [60, 45], [60, 50], [60, 60], [60, 80], [60, 100],
  [65, 25], [65, 33], [65, 45], [65, 65],
  [80, 25], [80, 30], [80, 35], [80, 40], [80, 45], [80, 50], [80, 55], [80, 60], [80, 80], [80, 100],
  [100, 33], [100, 40], [100, 50], [100, 60], [100, 80], [100, 100], [100, 120]
]

const TOOTH_CODES = {
  '粗齿': 'coarse',
  '细齿': 'fine',
  '封口': 'closed-slot',
  '全封闭': 'solid'
}

const STANDARD_COLORS = ['灰色', '白色', '蓝色']
const COVER_WIDTHS = [15, 20, 25, 30, 33, 35, 40, 45, 50, 55, 60, 65, 80, 100, 120]
const COVER_COLORS = ['白色', '蓝色', '灰色', '黑色']

function availableTeethForHeight(height) {
  if (height === 20) return ['细齿', '全封闭']
  if (height === 25 || height === 30) return ['细齿', '封口', '全封闭']
  return ['粗齿', '细齿', '封口', '全封闭']
}

function availableTeethForDimension(height, width) {
  const exists = SPEC_DIMENSIONS.some(([specHeight, specWidth]) =>
    specHeight === Number(height) && specWidth === Number(width)
  )
  return exists ? availableTeethForHeight(Number(height)) : []
}

function buildProductId(height, width, toothType, color) {
  const toothCode = TOOTH_CODES[toothType]
  const colorCode = color === '灰色' ? 'gray' : encodeURIComponent(color)
  return `p-${height}-${width}-${toothCode}-${colorCode}`
}

function buildCoverProductId(width, color) {
  const colorCode = color === '灰色' ? 'gray' : encodeURIComponent(color)
  return `cover-${Number(width)}-${colorCode}`
}

const products = []
SPEC_DIMENSIONS.forEach(([height, width]) => {
  availableTeethForHeight(height).forEach(toothType => {
    STANDARD_COLORS.forEach(color => {
      products.push({
        id: buildProductId(height, width, toothType, color),
        height,
        width,
        toothType,
        color,
        productType: 'wire-duct',
        isStandard: true,
        active: true
      })
    })
  })
})

COVER_WIDTHS.forEach(width => {
  COVER_COLORS.forEach(color => {
    products.push({
      id: buildCoverProductId(width, color),
      height: null,
      width,
      toothType: null,
      color,
      productType: 'cover',
      isStandard: true,
      active: true
    })
  })
})

function findProduct(height, width, toothType, color) {
  return products.find(product =>
    product.active &&
    product.productType === 'wire-duct' &&
    product.height === Number(height) &&
    product.width === Number(width) &&
    product.toothType === toothType &&
    product.color === color
  ) || null
}

function findProductWithAttributes(height, width, toothType, color, attributes) {
  const expected = attributes || {}
  return products.find(product => {
    if (!product.active || product.productType !== 'wire-duct') return false
    if (product.height !== Number(height) || product.width !== Number(width)) return false
    if (product.toothType !== toothType || product.color !== color) return false
    if (expected.unitLengthMeters != null &&
        Number(product.unitLengthMeters) !== Number(expected.unitLengthMeters)) return false
    const expectedTags = Array.isArray(expected.specialTags) ? expected.specialTags : []
    const productTags = Array.isArray(product.specialTags) ? product.specialTags : []
    return expectedTags.every(tag => productTags.includes(tag))
  }) || null
}

function findCoverProduct(width, color) {
  return products.find(product =>
    product.active &&
    product.productType === 'cover' &&
    product.width === Number(width) &&
    product.color === color
  ) || null
}

function getProductById(productId) {
  return products.find(product => product.id === productId) || null
}

function formatProductLabel(product) {
  if (!product) return '待选择产品'
  if (product.isStandard === false || product.name) return product.name || '未命名自定义产品'
  if (product.productType === 'cover') return `${product.width}mm盖子 / ${product.color}`
  return `${product.height}×${product.width} / ${product.toothType} / ${product.color}`
}

function normalizeCustomProductName(name) {
  let normalized = String(name == null ? '' : name)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[xX*]/g, '×')
    .replace(/长度\s*(?=\d+(?:\.\d+)?\s*(?:米|m))/gi, '')
    .replace(/(\d+(?:\.\d+)?)\s*(?:米|m)\s*(?:长(?:的)?|的|\/\s*根|每根)?/gi, (match, length) => `${Number(length)}米`)

  const compactDimensions = SPEC_DIMENSIONS
    .map(([height, width]) => ({ token: `${height}${width}`, label: `${height}×${width}` }))
    .sort((left, right) => right.token.length - left.token.length)
  compactDimensions.forEach(item => {
    const pattern = new RegExp(`(^|[^\\d])${item.token}(?!\\d)`, 'g')
    normalized = normalized.replace(pattern, (match, prefix) => `${prefix}${item.label}`)
  })

  return normalized
    .replace(/(\d{2,3})\s*×\s*(\d{2,3})/g, '$1×$2')
    .replace(/[\s\-_\u2010-\u2015·•，,、]/g, '')
    .trim()
}

module.exports = {
  SPEC_DIMENSIONS,
  STANDARD_COLORS,
  COVER_WIDTHS,
  COVER_COLORS,
  products,
  availableTeethForHeight,
  availableTeethForDimension,
  buildProductId,
  buildCoverProductId,
  findProduct,
  findProductWithAttributes,
  findCoverProduct,
  getProductById,
  formatProductLabel,
  normalizeCustomProductName
}
