const {
  DEFAULT_PAGE_SIZE,
  buildStatementExportDocument,
  assembleStatementExportDocument
} = require('./statement-export')

function asPromise(value) {
  return value && typeof value.then === 'function' ? value : Promise.resolve(value)
}

async function loadResourcePages(repository, tenantId, clientId, periodId, resource, onProgress) {
  const items = []
  let offset = 0
  let hasMore = true
  while (hasMore) {
    const page = await asPromise(repository.getStatementExportPage(tenantId, {
      clientId,
      periodId,
      resource,
      offset,
      limit: DEFAULT_PAGE_SIZE
    }))
    if (!page || page.resource !== resource || !Array.isArray(page.items)) {
      throw new Error('云端返回了无效的账单分页数据')
    }
    items.push(...page.items)
    const nextOffset = Number(page.nextOffset)
    if (!Number.isSafeInteger(nextOffset) || nextOffset < offset || (page.hasMore && nextOffset === offset)) {
      throw new Error('云端账单分页位置无效')
    }
    offset = nextOffset
    hasMore = Boolean(page.hasMore)
    if (onProgress) onProgress({ resource, loaded: items.length })
  }
  return items
}

async function loadStatementExportDocument(repository, tenantId, clientId, periodId, onProgress) {
  if (!repository || !clientId || !periodId) throw new Error('缺少账单导出范围')
  if (typeof repository.getStatementExportMeta !== 'function' || typeof repository.getStatementExportPage !== 'function') {
    const statement = repository.getStatement(tenantId, clientId, periodId)
    const enterprise = repository.getEnterprise(tenantId)
    if (!statement || !statement.period) throw new Error('账单不存在或已删除')
    return buildStatementExportDocument({
      enterprise,
      client: statement.client,
      period: statement.period,
      shipments: statement.shipments,
      payments: statement.payments,
      generatedAt: new Date().toISOString()
    })
  }
  if (onProgress) onProgress({ resource: 'meta', loaded: 0 })
  const meta = await asPromise(repository.getStatementExportMeta(tenantId, clientId, periodId))
  const shipments = await loadResourcePages(repository, tenantId, clientId, periodId, 'shipments', onProgress)
  const payments = await loadResourcePages(repository, tenantId, clientId, periodId, 'payments', onProgress)
  return assembleStatementExportDocument(meta, shipments, payments)
}

module.exports = { loadResourcePages, loadStatementExportDocument }
