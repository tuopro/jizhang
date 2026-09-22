const {
  DEFAULT_PAGE_SIZE,
  legacyPeriodIdForShipment,
  normalizeShipment,
  normalizePayment,
  buildStatementExportDocument,
  statementExportMeta,
  normalizePageRequest
} = require('./statement-export')

const MAX_EXPORT_RECORDS = 50000

function clean(document) {
  if (!document) return document
  const value = JSON.parse(JSON.stringify(document))
  delete value._id
  delete value._openid
  return value
}

function text(value) {
  return String(value == null ? '' : value).trim()
}

async function readDocument(database, collectionName, id) {
  const response = await database.collection(collectionName).doc(id).get().catch(() => null)
  return response && response.data ? clean(response.data) : null
}

async function readAllByField(database, collectionName, field, value, options) {
  const settings = options || {}
  const batchSize = settings.batchSize || DEFAULT_PAGE_SIZE
  const matches = []
  let offset = 0
  while (true) {
    const response = await database.collection(collectionName)
      .where({ [field]: value })
      .skip(offset)
      .limit(batchSize)
      .get()
    const batch = (response.data || []).map(clean)
    batch.forEach(item => {
      if (!settings.filter || settings.filter(item)) matches.push(item)
    })
    offset += batch.length
    if (matches.length > MAX_EXPORT_RECORDS || offset > MAX_EXPORT_RECORDS) {
      throw new Error('账单记录过多，已超过单次导出安全上限')
    }
    if (batch.length < batchSize) break
  }
  return matches
}

async function readRawPage(database, collectionName, field, value, offset, limit) {
  const response = await database.collection(collectionName)
    .where({ [field]: value })
    .skip(offset)
    .limit(limit)
    .get()
  return (response.data || []).map(clean)
}

function belongsToTenant(item, tenantId) {
  return item && item.tenantId === tenantId
}

function assertTarget(document, tenantId, clientId, label) {
  if (!document || document.tenantId !== tenantId || (clientId && document.clientId !== clientId)) {
    throw new Error(`${label}不存在或无权访问`)
  }
  return document
}

function legacyPeriodFromShipments(tenantId, clientId, periodId, shipments, storedPeriods) {
  const periodShipments = shipments.filter(item =>
    item.status !== 'void' && legacyPeriodIdForShipment(item) === periodId)
  if (!periodShipments.length) throw new Error('账期不存在或无权访问')
  const periods = (storedPeriods || []).filter(item => item.status !== 'void').map(item => ({
    id: item.id,
    clientId,
    startAt: item.startAt || item.startedAt || item.createdAt || ''
  }))
  const knownIds = new Set(periods.map(item => item.id))
  shipments.filter(item => item.status !== 'void').forEach(shipment => {
    const id = legacyPeriodIdForShipment(shipment)
    if (knownIds.has(id)) return
    knownIds.add(id)
    const date = text(shipment.shipmentDate || shipment.createdAt).slice(0, 10)
    periods.push({ id, clientId, startAt: date ? `${date}T00:00:00.000Z` : '' })
  })
  periods.sort((left, right) =>
    text(left.startAt).localeCompare(text(right.startAt)) || text(left.id).localeCompare(text(right.id)))
  const index = periods.findIndex(item => item.id === periodId)
  const dates = periodShipments.map(item => text(item.shipmentDate || item.createdAt).slice(0, 10)).filter(Boolean).sort()
  return {
    id: periodId,
    tenantId,
    clientId,
    sequenceNo: index >= 0 ? index + 1 : periods.length,
    status: 'open',
    startAt: dates[0] ? `${dates[0]}T00:00:00.000Z` : '',
    legacyCompatibility: true
  }
}

async function resolveExportScope(database, tenantId, payload) {
  const clientId = text(payload && payload.clientId)
  const periodId = text(payload && payload.periodId)
  if (!clientId) throw new Error('缺少客户编号')
  if (!periodId) throw new Error('缺少账期编号')
  const [enterprise, client, storedPeriod] = await Promise.all([
    readDocument(database, 'enterprises', tenantId),
    readDocument(database, 'clients', clientId),
    readDocument(database, 'billing_periods', periodId)
  ])
  if (!enterprise || enterprise.id !== tenantId) throw new Error('企业不存在或无权访问')
  assertTarget(client, tenantId, '', '客户')
  if (client.id !== clientId || client.active === false) throw new Error('客户不存在或已删除')
  if (storedPeriod) {
    assertTarget(storedPeriod, tenantId, clientId, '账期')
    return { enterprise, client, period: storedPeriod, legacyShipments: null }
  }
  if (!periodId.startsWith(`legacy_${clientId}_`)) throw new Error('账期不存在或无权访问')
  const [clientShipments, storedPeriods] = await Promise.all([
    readAllByField(database, 'shipments', 'clientId', clientId, {
      filter: item => belongsToTenant(item, tenantId)
    }),
    readAllByField(database, 'billing_periods', 'clientId', clientId, {
      filter: item => belongsToTenant(item, tenantId)
    })
  ])
  const period = legacyPeriodFromShipments(tenantId, clientId, periodId, clientShipments, storedPeriods)
  return { enterprise, client, period, legacyShipments: clientShipments }
}

async function readStatementExportSource(database, tenantId, payload, generatedAt) {
  const scope = await resolveExportScope(database, tenantId, payload)
  const clientId = scope.client.id
  const periodId = scope.period.id
  const shipments = scope.legacyShipments
    ? scope.legacyShipments.filter(item => item.status !== 'void' && legacyPeriodIdForShipment(item) === periodId)
    : await readAllByField(database, 'shipments', 'periodId', periodId, {
      filter: item => belongsToTenant(item, tenantId) && item.clientId === clientId && item.status !== 'void'
    })
  const payments = await readAllByField(database, 'payments', 'periodId', periodId, {
    filter: item => belongsToTenant(item, tenantId) && (!item.clientId || item.clientId === clientId) && item.status !== 'void'
  })
  return {
    enterprise: scope.enterprise,
    client: scope.client,
    period: scope.period,
    shipments,
    payments,
    generatedAt: generatedAt || new Date().toISOString()
  }
}

async function getStatementExportMeta(database, tenantId, payload, generatedAt) {
  const source = await readStatementExportSource(database, tenantId, payload, generatedAt)
  return statementExportMeta(buildStatementExportDocument(source))
}

async function getStatementExportPage(database, tenantId, payload) {
  const request = normalizePageRequest(payload)
  const scope = await resolveExportScope(database, tenantId, payload)
  const clientId = scope.client.id
  const periodId = scope.period.id
  let batch
  if (request.resource === 'shipments') {
    if (scope.legacyShipments) {
      batch = scope.legacyShipments
        .filter(item => item.status !== 'void' && legacyPeriodIdForShipment(item) === periodId)
        .slice(request.offset, request.offset + request.limit)
      return {
        resource: request.resource,
        items: batch.map(normalizeShipment),
        nextOffset: request.offset + batch.length,
        hasMore: request.offset + batch.length < scope.legacyShipments
          .filter(item => item.status !== 'void' && legacyPeriodIdForShipment(item) === periodId).length
      }
    }
    batch = await readRawPage(database, 'shipments', 'periodId', periodId, request.offset, request.limit)
    const items = batch.filter(item =>
      belongsToTenant(item, tenantId) && item.clientId === clientId && item.status !== 'void')
    return {
      resource: request.resource,
      items: items.map(normalizeShipment),
      nextOffset: request.offset + batch.length,
      hasMore: batch.length === request.limit
    }
  }
  batch = await readRawPage(database, 'payments', 'periodId', periodId, request.offset, request.limit)
  const items = batch.filter(item =>
    belongsToTenant(item, tenantId) && (!item.clientId || item.clientId === clientId) && item.status !== 'void')
  return {
    resource: request.resource,
    items: items.map(normalizePayment),
    nextOffset: request.offset + batch.length,
    hasMore: batch.length === request.limit
  }
}

module.exports = {
  MAX_EXPORT_RECORDS,
  readAllByField,
  resolveExportScope,
  readStatementExportSource,
  getStatementExportMeta,
  getStatementExportPage
}
