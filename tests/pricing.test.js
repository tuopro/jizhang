const test = require('node:test')
const assert = require('node:assert/strict')

const {
  yuanToCents,
  centsToYuan,
  multiplyQuantityByCents
} = require('../utils/money')
const {
  calculatePricedItem,
  validatePricedItems,
  calculateTotalCents
} = require('../services/pricing')

test('金额用分保存并正确处理两位小数', () => {
  assert.equal(yuanToCents('12.50'), 1250)
  assert.equal(yuanToCents('¥18.6'), 1860)
  assert.equal(yuanToCents('12.345'), null)
  assert.equal(centsToYuan(302000), '3020.00')
})

test('数量乘客户单价得到行金额和合计', () => {
  assert.equal(multiplyQuantityByCents('100', 1250), 125000)
  assert.equal(multiplyQuantityByCents('1.5', 1250), 1875)

  const items = [
    calculatePricedItem({ productId: 'a', quantityText: '100', unit: '米', unitPriceYuan: '12.50' }),
    calculatePricedItem({ productId: 'b', quantityText: '50', unit: '米', unitPriceYuan: '18.60' })
  ]
  assert.equal(calculateTotalCents(items), 218000)
})

test('任意商品缺产品、数量或价格都拒绝正式入账', () => {
  const errors = validatePricedItems([
    { productId: 'a', quantityText: '100', unit: '米', unitPriceYuan: '12.50' },
    { productId: 'b', quantityText: '30', unit: '米', unitPriceYuan: '' },
    { productId: '', quantityText: '10', unit: '米', unitPriceYuan: '5.00' }
  ])
  assert.ok(errors.some(message => message.includes('第2项缺少有效单价')))
  assert.ok(errors.some(message => message.includes('第3项尚未确认产品')))
})

test('按根和按箱价格直接计算，不换算成米', () => {
  const rootItem = calculatePricedItem({
    productId: 'custom-root',
    quantityText: '50',
    orderUnit: '根',
    pricingUnit: '根',
    unitPriceYuan: '12.50'
  })
  const boxItem = calculatePricedItem({
    productId: 'custom-box',
    quantityText: '3',
    orderUnit: '箱',
    pricingUnit: '箱',
    unitPriceYuan: '380.00'
  })
  assert.equal(rootItem.pricingQuantity, 50)
  assert.equal(rootItem.lineAmountCents, 62500)
  assert.equal(boxItem.pricingQuantity, 3)
  assert.equal(boxItem.lineAmountCents, 114000)
})

test('订单单位与客户计价单位不一致时必须人工换算', () => {
  const unresolved = {
    productId: 'a',
    quantityText: '50',
    orderUnit: '根',
    pricingUnit: '米',
    unitPriceYuan: '6.80'
  }
  assert.equal(calculatePricedItem(unresolved).lineAmountCents, null)
  assert.ok(validatePricedItems([unresolved]).some(message => message.includes('必须人工填写换算关系')))

  const resolved = calculatePricedItem(Object.assign({}, unresolved, { conversionRateText: '2' }))
  assert.equal(resolved.pricingQuantity, 100)
  assert.equal(resolved.lineAmountCents, 68000)
  assert.deepEqual(validatePricedItems([Object.assign({}, unresolved, { conversionRateText: '2' })]), [])
})
