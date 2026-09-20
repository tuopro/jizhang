const test = require('node:test')
const assert = require('node:assert/strict')

const {
  SPEC_DIMENSIONS,
  STANDARD_COLORS,
  COVER_WIDTHS,
  COVER_COLORS,
  products,
  findProduct,
  findCoverProduct,
  normalizeCustomProductName
} = require('../data/product-specs')

test('产品库保留报价小程序当前66个高×宽规格且不带通用价格', () => {
  assert.equal(SPEC_DIMENSIONS.length, 66)
  assert.equal(new Set(SPEC_DIMENSIONS.map(([h, w]) => `${h}x${w}`)).size, 66)
  assert.ok(products.length > 66)
  assert.ok(products.every(product => !Object.hasOwn(product, 'basePrice')))
  assert.deepEqual(STANDARD_COLORS, ['灰色', '白色', '蓝色'])
  assert.ok(findProduct(40, 40, '粗齿', '白色'))
  assert.ok(findProduct(40, 40, '粗齿', '蓝色'))
})

test('盖子规格库包含15个宽度和白蓝灰黑四色', () => {
  assert.deepEqual(COVER_WIDTHS, [15, 20, 25, 30, 33, 35, 40, 45, 50, 55, 60, 65, 80, 100, 120])
  assert.deepEqual(COVER_COLORS, ['白色', '蓝色', '灰色', '黑色'])
  const covers = products.filter(product => product.productType === 'cover')
  assert.equal(covers.length, COVER_WIDTHS.length * COVER_COLORS.length)
  COVER_WIDTHS.forEach(width => {
    COVER_COLORS.forEach(color => assert.ok(findCoverProduct(width, color)))
  })
  assert.ok(covers.every(product => !product.toothType && !Object.hasOwn(product, 'basePrice')))
})

test('可选齿型严格按原产品规格边界', () => {
  assert.equal(findProduct(20, 20, '粗齿', '灰色'), null)
  assert.ok(findProduct(20, 20, '细齿', '灰色'))
  assert.ok(findProduct(25, 25, '封口', '灰色'))
  assert.ok(findProduct(40, 40, '粗齿', '灰色'))
  assert.ok(findProduct(40, 40, '全封闭', '灰色'))
})

test('自定义产品长度的常见写法归一但保留长度数值', () => {
  const names = [
    '白色装潢1525，1.3米长',
    '白色装潢1525 1.3米的',
    '白色装潢1525 长度1.30米',
    '白色装潢1525 1.3米/根',
    '白色装潢1525 1.3m'
  ]
  const normalized = names.map(normalizeCustomProductName)
  assert.equal(new Set(normalized).size, 1)
  assert.ok(normalized[0].includes('1.3米'))
  assert.notEqual(normalizeCustomProductName('白色装潢1525 1.5米'), normalized[0])
})

test('自定义产品名称中的紧凑标准尺寸与乘号尺寸归一', () => {
  assert.equal(
    normalizeCustomProductName('白色4040-1.2米长'),
    normalizeCustomProductName('白色40×40 1.2米/根')
  )
  assert.notEqual(
    normalizeCustomProductName('白色4040-1.2米长'),
    normalizeCustomProductName('白色4060-1.2米长')
  )
})
