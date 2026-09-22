const EXPORT_SCHEMA_VERSION = 1
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 100

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function text(value) {
  return String(value == null ? '' : value).trim()
}

function dateText(value) {
  return text(value).slice(0, 10)
}

function isClosedPeriod(period) {
  return Boolean(period && (period.status === 'settled' || period.status === 'closed'))
}

function legacyPeriodIdForShipment(shipment) {
  if (shipment && shipment.periodId) return shipment.periodId
  const shipmentDate = dateText(shipment && (shipment.shipmentDate || shipment.createdAt))
  const periodKey = /^\d{4}-\d{2}/.test(shipmentDate) ? shipmentDate.slice(0, 7) : 'unknown'
  return `legacy_${text(shipment && shipment.clientId)}_${periodKey}`
}

function safeCents(value, label) {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`${label}不是有效的整数分金额`)
  }
  return amount
}

function optionalCents(source, names) {
  for (const name of names) {
    if (source && source[name] !== undefined && source[name] !== null && source[name] !== '') {
      const value = Number(source[name])
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    }
  }
  return null
}

function numeric(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeConversion(conversion) {
  if (!conversion || typeof conversion !== 'object') return null
  return {
    fromUnit: text(conversion.fromUnit),
    toUnit: text(conversion.toUnit),
    multiplier: numeric(conversion.multiplier, 0)
  }
}

function normalizeProductSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {}
  return {
    label: text(source.label || source.name || '未命名产品'),
    name: text(source.name || source.label || '未命名产品'),
    height: source.height == null ? '' : text(source.height),
    width: source.width == null ? '' : text(source.width),
    color: text(source.color),
    toothType: text(source.toothType),
    productType: text(source.productType),
    lengthDescription: text(source.lengthDescription),
    unitLengthMeters: source.unitLengthMeters == null ? null : numeric(source.unitLengthMeters, null),
    specialTags: Array.isArray(source.specialTags) ? source.specialTags.map(text).filter(Boolean) : []
  }
}

function normalizeLine(line, index) {
  const source = line || {}
  const originalQuantity = source.originalQuantity != null ? source.originalQuantity : source.quantity
  const originalUnit = source.originalUnit || source.unit
  const pricingQuantity = source.pricingQuantity != null ? source.pricingQuantity : originalQuantity
  const pricingUnit = source.pricingUnit || originalUnit
  return {
    id: text(source.id || `line_${index + 1}`),
    productId: text(source.productId),
    productSnapshot: normalizeProductSnapshot(source.productSnapshot),
    originalQuantity: numeric(originalQuantity, 0),
    originalUnit: text(originalUnit),
    pricingQuantity: numeric(pricingQuantity, 0),
    pricingUnit: text(pricingUnit),
    conversion: normalizeConversion(source.conversion),
    unitPriceCents: safeCents(source.unitPriceCents, `第${index + 1}行单价`),
    lineAmountCents: safeCents(source.lineAmountCents, `第${index + 1}行金额`)
  }
}

function normalizeShipment(shipment) {
  const source = shipment || {}
  const lines = (Array.isArray(source.lines) ? source.lines : []).map(normalizeLine)
  const lineSubtotal = lines.reduce((sum, line) => sum + line.lineAmountCents, 0)
  const storedTotal = optionalCents(source, ['totalAmountCents', 'shipmentTotalCents'])
  const storedSubtotal = optionalCents(source, ['itemsSubtotalCents', 'goodsSubtotalCents'])
  const storedFreight = optionalCents(source, ['freightCents'])
  const itemsSubtotalCents = storedSubtotal == null
    ? (storedFreight == null && storedTotal != null ? storedTotal : lineSubtotal)
    : storedSubtotal
  const freightCents = storedFreight == null
    ? Math.max(0, (storedTotal == null ? itemsSubtotalCents : storedTotal) - itemsSubtotalCents)
    : storedFreight
  const totalAmountCents = itemsSubtotalCents + freightCents
  if (lineSubtotal !== itemsSubtotalCents) {
    throw new Error(`发货 ${text(source.id) || '未知'} 的商品快照金额与商品小计不一致`)
  }
  if (storedTotal != null && storedTotal !== totalAmountCents) {
    throw new Error(`发货 ${text(source.id) || '未知'} 的商品小计、运费与本次合计不一致`)
  }
  return {
    id: text(source.id),
    clientId: text(source.clientId),
    periodId: legacyPeriodIdForShipment(source),
    clientNameSnapshot: text(source.clientNameSnapshot),
    shipmentDate: dateText(source.shipmentDate || source.createdAt),
    createdAt: text(source.createdAt),
    createdByNameSnapshot: text(source.createdByNameSnapshot || '未记录'),
    logistics: {
      provider: text(source.logistics && source.logistics.provider),
      raw: text(source.logistics && source.logistics.raw)
    },
    note: text(source.note),
    lines,
    itemsSubtotalCents,
    freightCents,
    totalAmountCents
  }
}

function normalizePayment(payment) {
  const source = payment || {}
  return {
    id: text(source.id),
    clientId: text(source.clientId),
    periodId: text(source.periodId),
    clientNameSnapshot: text(source.clientNameSnapshot),
    paymentDate: dateText(source.paymentDate || source.createdAt),
    amountCents: safeCents(source.amountCents, `收款 ${text(source.id) || '未知'} 金额`),
    method: text(source.method || '其他'),
    note: text(source.note),
    createdAt: text(source.createdAt),
    createdByNameSnapshot: text(source.createdByNameSnapshot || '未记录')
  }
}

function chronological(left, right, dateField) {
  return `${left[dateField] || ''}|${left.createdAt || ''}|${left.id || ''}`
    .localeCompare(`${right[dateField] || ''}|${right.createdAt || ''}|${right.id || ''}`)
}

function periodSequence(period) {
  const value = Number(period && (period.sequenceNo || period.sequence))
  return Number.isInteger(value) && value > 0 ? value : 1
}

function storedPeriodTotals(period) {
  return {
    itemsSubtotalCents: optionalCents(period, ['itemsSubtotalCents', 'goodsSubtotalCents']),
    freightCents: optionalCents(period, ['freightCents']),
    shipmentTotalCents: optionalCents(period, ['shipmentTotalCents', 'totalAmountCents']),
    receivedCents: optionalCents(period, ['receivedCents', 'receivedAmountCents']),
    outstandingCents: optionalCents(period, ['outstandingCents', 'outstandingAmountCents'])
  }
}

function validateStoredTotals(period, calculated) {
  const stored = storedPeriodTotals(period)
  if (period && period.legacyCompatibility === true) return
  Object.keys(stored).forEach(key => {
    if (stored[key] != null && stored[key] !== calculated[key]) {
      throw new Error(`账期汇总 ${key} 与明细快照不一致`)
    }
  })
}

function calculateTotals(shipments, payments) {
  const itemsSubtotalCents = shipments.reduce((sum, item) => sum + item.itemsSubtotalCents, 0)
  const freightCents = shipments.reduce((sum, item) => sum + item.freightCents, 0)
  const shipmentTotalCents = itemsSubtotalCents + freightCents
  const receivedCents = payments.reduce((sum, item) => sum + item.amountCents, 0)
  return {
    itemsSubtotalCents,
    freightCents,
    shipmentTotalCents,
    receivedCents,
    outstandingCents: Math.max(0, shipmentTotalCents - receivedCents)
  }
}

function hashText(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function contentVersion(document) {
  const stable = {
    scope: document.scope,
    header: document.header,
    totals: document.totals,
    shipments: document.shipments,
    payments: document.payments
  }
  return `v${EXPORT_SCHEMA_VERSION}_${hashText(JSON.stringify(stable))}`
}

function buildStatementExportDocument(input) {
  const source = input || {}
  const enterprise = source.enterprise || {}
  const client = source.client || {}
  const period = source.period || {}
  const shipments = (Array.isArray(source.shipments) ? source.shipments : [])
    .filter(item => item && item.status !== 'void')
    .map(normalizeShipment)
    .sort((a, b) => chronological(a, b, 'shipmentDate'))
  const payments = (Array.isArray(source.payments) ? source.payments : [])
    .filter(item => item && item.status !== 'void')
    .map(normalizePayment)
    .sort((a, b) => chronological(a, b, 'paymentDate'))
  const clientId = text(client.id || period.clientId)
  const periodId = text(period.id)
  if (!clientId) throw new Error('客户不存在')
  if (!periodId) throw new Error('账期不存在')
  shipments.forEach(item => {
    if (item.clientId !== clientId || item.periodId !== periodId) throw new Error('发货记录不属于当前客户账期')
  })
  payments.forEach(item => {
    if (item.clientId && item.clientId !== clientId) throw new Error('收款记录不属于当前客户')
    if (item.periodId !== periodId) throw new Error('收款记录不属于当前账期')
  })
  const totals = calculateTotals(shipments, payments)
  validateStoredTotals(period, totals)
  const closed = isClosedPeriod(period)
  const activityDates = shipments.map(item => item.shipmentDate)
    .concat(payments.map(item => item.paymentDate)).filter(Boolean).sort()
  const startDate = dateText(period.startDate || period.startAt || period.startedAt || period.createdAt) || activityDates[0] || ''
  const closedDate = dateText(period.closedDate || period.closedAt || period.settledAt)
  const generatedDate = dateText(source.generatedAt || new Date().toISOString())
  const endDate = closed
    ? (closedDate || activityDates[activityDates.length - 1] || startDate)
    : [generatedDate].concat(activityDates).filter(Boolean).sort().pop() || startDate
  const historicalClientName = shipments.map(item => item.clientNameSnapshot).find(Boolean) ||
    payments.map(item => item.clientNameSnapshot).find(Boolean)
  const customerName = closed ? (historicalClientName || text(client.name)) : text(client.name || historicalClientName)
  const document = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    scope: { clientId, periodId },
    header: {
      enterpriseName: text(enterprise.name || '未命名企业'),
      customerName: customerName || '未命名客户',
      sequenceNo: periodSequence(period),
      periodTitle: `第 ${periodSequence(period)} 期`,
      status: closed ? 'closed' : 'open',
      statusText: closed ? '已结清' : '进行中',
      startDate,
      endDate,
      endDateLabel: closed ? '结清日期' : '截至日期',
      ownerNameSnapshot: text(period.ownerNameSnapshot || period.ownerDisplayName || '未设置'),
      generatedAt: text(source.generatedAt || new Date().toISOString())
    },
    totals,
    counts: {
      shipments: shipments.length,
      shipmentLines: shipments.reduce((sum, item) => sum + item.lines.length, 0),
      payments: payments.length
    },
    shipments,
    payments
  }
  document.sourceVersion = contentVersion(document)
  return document
}

function statementExportMeta(document) {
  const source = clone(document)
  delete source.shipments
  delete source.payments
  return source
}

function assembleStatementExportDocument(meta, shipments, payments) {
  const document = buildStatementExportDocument({
    enterprise: { name: meta && meta.header && meta.header.enterpriseName },
    client: { id: meta && meta.scope && meta.scope.clientId, name: meta && meta.header && meta.header.customerName },
    period: {
      id: meta && meta.scope && meta.scope.periodId,
      clientId: meta && meta.scope && meta.scope.clientId,
      sequenceNo: meta && meta.header && meta.header.sequenceNo,
      status: meta && meta.header && meta.header.status,
      startDate: meta && meta.header && meta.header.startDate,
      closedDate: meta && meta.header && meta.header.status === 'closed' ? meta.header.endDate : '',
      ownerNameSnapshot: meta && meta.header && meta.header.ownerNameSnapshot,
      itemsSubtotalCents: meta && meta.totals && meta.totals.itemsSubtotalCents,
      freightCents: meta && meta.totals && meta.totals.freightCents,
      shipmentTotalCents: meta && meta.totals && meta.totals.shipmentTotalCents,
      receivedCents: meta && meta.totals && meta.totals.receivedCents,
      outstandingCents: meta && meta.totals && meta.totals.outstandingCents
    },
    shipments,
    payments,
    generatedAt: meta && meta.header && meta.header.generatedAt
  })
  if (!meta || document.sourceVersion !== meta.sourceVersion) {
    throw new Error('账单在生成过程中已更新，请重新生成')
  }
  if (document.counts.shipments !== meta.counts.shipments ||
      document.counts.shipmentLines !== meta.counts.shipmentLines ||
      document.counts.payments !== meta.counts.payments) {
    throw new Error('账单明细未完整读取，请重新生成')
  }
  return document
}

function normalizePageRequest(payload) {
  const source = payload || {}
  const resource = source.resource === 'payments' ? 'payments' : source.resource === 'shipments' ? 'shipments' : ''
  if (!resource) throw new Error('不支持的导出分页类型')
  const offset = Number(source.offset || 0)
  const limit = Number(source.limit || DEFAULT_PAGE_SIZE)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('导出分页位置无效')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new Error(`每次最多读取 ${MAX_PAGE_SIZE} 条`)
  return { resource, offset, limit }
}

module.exports = {
  EXPORT_SCHEMA_VERSION,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  legacyPeriodIdForShipment,
  normalizeShipment,
  normalizePayment,
  buildStatementExportDocument,
  statementExportMeta,
  assembleStatementExportDocument,
  normalizePageRequest,
  contentVersion
}
