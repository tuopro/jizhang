const {
  yuanToCents,
  quantityToNumber,
  multiplyQuantityByCents
} = require('../utils/money')

function findCustomerPrice(customerPrices, tenantId, clientId, productId, unit) {
  return customerPrices.find(price =>
    price.tenantId === tenantId &&
    price.clientId === clientId &&
    price.productId === productId &&
    price.unit === unit &&
    price.active !== false
  ) || null
}

function findCustomerPriceForProduct(customerPrices, tenantId, clientId, productId) {
  return customerPrices.find(price =>
    price.tenantId === tenantId &&
    price.clientId === clientId &&
    price.productId === productId &&
    price.active !== false
  ) || null
}

function resolvePricingQuantity(item) {
  const orderQuantity = quantityToNumber(item.quantityText != null ? item.quantityText : item.quantity)
  const orderUnit = item.orderUnit || item.unit
  const pricingUnit = item.pricingUnit || item.unit
  if (!orderQuantity || !orderUnit || !pricingUnit) {
    return { orderQuantity, orderUnit, pricingUnit, conversionRate: null, pricingQuantity: null }
  }
  if (orderUnit === pricingUnit) {
    return { orderQuantity, orderUnit, pricingUnit, conversionRate: null, pricingQuantity: orderQuantity }
  }

  const conversionRate = quantityToNumber(
    item.conversionRateText != null ? item.conversionRateText : item.conversionRate
  )
  return {
    orderQuantity,
    orderUnit,
    pricingUnit,
    conversionRate,
    pricingQuantity: conversionRate
      ? Number((orderQuantity * conversionRate).toFixed(3))
      : null
  }
}

function calculatePricedItem(item) {
  const resolved = resolvePricingQuantity(item)
  const unitPriceCents = Number.isInteger(item.unitPriceCents)
    ? item.unitPriceCents
    : yuanToCents(item.unitPriceYuan)

  if (!resolved.pricingQuantity || !Number.isInteger(unitPriceCents) || unitPriceCents <= 0) {
    return Object.assign({}, item, {
      quantity: resolved.orderQuantity,
      orderUnit: resolved.orderUnit,
      pricingUnit: resolved.pricingUnit,
      conversionRate: resolved.conversionRate,
      pricingQuantity: resolved.pricingQuantity,
      unitPriceCents,
      lineAmountCents: null
    })
  }

  return Object.assign({}, item, {
    quantity: resolved.orderQuantity,
    orderUnit: resolved.orderUnit,
    pricingUnit: resolved.pricingUnit,
    conversionRate: resolved.conversionRate,
    pricingQuantity: resolved.pricingQuantity,
    unitPriceCents,
    lineAmountCents: multiplyQuantityByCents(String(resolved.pricingQuantity), unitPriceCents)
  })
}

function validatePricedItems(items) {
  const errors = []
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('至少需要一个商品')
    return errors
  }

  items.forEach((item, index) => {
    const row = index + 1
    if (!item.productId) errors.push(`第${row}项尚未确认产品`)
    if (!quantityToNumber(item.quantityText != null ? item.quantityText : item.quantity)) {
      errors.push(`第${row}项数量无效`)
    }
    const resolved = resolvePricingQuantity(item)
    if (!resolved.orderUnit) errors.push(`第${row}项缺少数量单位`)
    if (!resolved.pricingUnit) errors.push(`第${row}项缺少计价单位`)
    if (resolved.orderUnit && resolved.pricingUnit &&
        resolved.orderUnit !== resolved.pricingUnit && !resolved.conversionRate) {
      errors.push(`第${row}项数量单位与计价单位不一致，必须人工填写换算关系`)
    }
    const cents = Number.isInteger(item.unitPriceCents)
      ? item.unitPriceCents
      : yuanToCents(item.unitPriceYuan)
    if (!Number.isInteger(cents) || cents <= 0) errors.push(`第${row}项缺少有效单价`)
  })

  return errors
}

function calculateTotalCents(items) {
  return items.reduce((total, item) => {
    const priced = calculatePricedItem(item)
    return total + (priced.lineAmountCents || 0)
  }, 0)
}

module.exports = {
  findCustomerPrice,
  findCustomerPriceForProduct,
  resolvePricingQuantity,
  calculatePricedItem,
  validatePricedItems,
  calculateTotalCents
}
