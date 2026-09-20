function normalizeMoneyText(value) {
  return String(value == null ? '' : value).trim().replace(/[￥¥,，\s]/g, '')
}

function yuanToCents(value) {
  const normalized = normalizeMoneyText(value)
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [integer, decimals = ''] = normalized.split('.')
  return Number(integer) * 100 + Number((decimals + '00').slice(0, 2))
}

function centsToYuan(cents) {
  if (!Number.isInteger(cents)) return '0.00'
  return (cents / 100).toFixed(2)
}

function quantityToNumber(value) {
  const normalized = String(value == null ? '' : value).trim()
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null
  const quantity = Number(normalized)
  return quantity > 0 ? quantity : null
}

function multiplyQuantityByCents(quantityValue, unitPriceCents) {
  const quantityText = String(quantityValue == null ? '' : quantityValue).trim()
  if (!/^\d+(?:\.\d{1,3})?$/.test(quantityText)) return null
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) return null
  const [integer, decimals = ''] = quantityText.split('.')
  const scale = Math.pow(10, decimals.length)
  const numerator = Number(integer) * scale + Number(decimals || 0)
  return Math.round((numerator * unitPriceCents) / scale)
}

function formatCurrency(cents) {
  return `¥${centsToYuan(cents)}`
}

module.exports = {
  yuanToCents,
  centsToYuan,
  quantityToNumber,
  multiplyQuantityByCents,
  formatCurrency
}
