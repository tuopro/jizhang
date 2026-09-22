const { products, getProductById, formatProductLabel, normalizeCustomProductName } = require('../data/product-specs')
const { createDemoSeed, DEMO_TENANT_ID } = require('../data/demo-seed')
const { calculatePricedItem } = require('./pricing')
const { yuanToCents } = require('../utils/money')

const VALID_UNITS = ['米', '根', '箱']
const VALID_PAYMENT_METHODS = ['微信', '支付宝', '银行转账', '现金', '其他']
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))

function emptyRoot() {
  return { schemaVersion: 1, tenants: {} }
}

function currentPeriodId(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function isClosedPeriod(period) {
  return Boolean(period && (period.status === 'settled' || period.status === 'closed'))
}

function canCloseBillingPeriod(identity, period) {
  const memberId = identity && (identity.id || identity.memberId)
  return Boolean(identity && period && (
    identity.role === 'admin' ||
    (memberId && memberId === period.ownerMemberId)
  ))
}

function canEditShipment(identity, client, period) {
  const memberId = identity && (identity.id || identity.memberId)
  return Boolean(identity && identity.status === 'active' && client && period &&
    period.status === 'open' && (
      identity.role === 'admin' ||
      (identity.role === 'member' && memberId && memberId === client.ownerMemberId)
    ))
}

// Only persisted, unambiguously open periods can grant price permissions.
// Never use allPeriods(), which synthesizes legacy periods for display.
function currentPriceOpenPeriod(tenant, clientId) {
  const periods = tenant.billingPeriods.filter(period => period.clientId === clientId &&
    period.tenantId === tenant.enterprise.id && period.status === 'open')
  return periods.length === 1 ? periods[0] : null
}

function canManageCustomerPrices(identity, client, openPeriod) {
  const memberId = identity && (identity.id || identity.memberId)
  return Boolean(identity && identity.status === 'active' && client &&
    identity.tenantId === client.tenantId && (
      identity.role === 'admin' || (identity.role === 'member' && memberId && (
        memberId === client.ownerMemberId ||
        (openPeriod && openPeriod.status === 'open' && openPeriod.clientId === client.id &&
          openPeriod.tenantId === client.tenantId && memberId === openPeriod.ownerMemberId)
      ))
    ))
}

function legacyPeriodIdForShipment(shipment) {
  if (shipment.periodId) return shipment.periodId
  const dateText = String(shipment.shipmentDate || shipment.createdAt || '').slice(0, 10)
  const periodKey = /^\d{4}-\d{2}/.test(dateText) ? dateText.slice(0, 7) : 'unknown'
  return `legacy_${shipment.clientId}_${periodKey}`
}

function normalizeDate(value, fallback) {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback
}

function localDateText(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function normalizeShipmentAmounts(shipment) {
  const storedTotal = Number.isInteger(shipment.totalAmountCents) && shipment.totalAmountCents >= 0
    ? shipment.totalAmountCents
    : null
  const hasItemsSubtotal = Number.isInteger(shipment.itemsSubtotalCents) && shipment.itemsSubtotalCents >= 0
  const hasFreight = Number.isInteger(shipment.freightCents) && shipment.freightCents >= 0
  const lineSubtotal = Array.isArray(shipment.lines)
    ? shipment.lines.reduce((sum, line) => sum + (Number.isInteger(line.lineAmountCents) ? line.lineAmountCents : 0), 0)
    : 0

  let itemsSubtotalCents
  let freightCents
  if (!hasItemsSubtotal && !hasFreight) {
    itemsSubtotalCents = storedTotal == null ? lineSubtotal : storedTotal
    freightCents = 0
  } else {
    itemsSubtotalCents = hasItemsSubtotal ? shipment.itemsSubtotalCents : lineSubtotal
    freightCents = hasFreight
      ? shipment.freightCents
      : Math.max(0, (storedTotal == null ? itemsSubtotalCents : storedTotal) - itemsSubtotalCents)
  }

  Object.assign(shipment, {
    itemsSubtotalCents,
    freightCents,
    totalAmountCents: itemsSubtotalCents + freightCents
  })
  return shipment
}

function resolveFreightCents(payload, fallbackCents) {
  const hasCents = payload.freightCents !== undefined && payload.freightCents !== null && payload.freightCents !== ''
  const freightYuanText = String(payload.freightYuan == null ? '' : payload.freightYuan).trim()
  const hasYuan = freightYuanText !== ''
  if (!hasCents && !hasYuan) return Number.isSafeInteger(fallbackCents) && fallbackCents >= 0 ? fallbackCents : 0

  const centsValue = hasCents ? Number(payload.freightCents) : null
  const yuanValue = hasYuan ? yuanToCents(freightYuanText) : null
  if ((hasCents && (!Number.isSafeInteger(centsValue) || centsValue < 0)) ||
      (hasYuan && (!Number.isSafeInteger(yuanValue) || yuanValue < 0))) {
    throw new Error('运费必须是大于等于0的合法金额，最多两位小数')
  }
  if (hasCents && hasYuan && centsValue !== yuanValue) throw new Error('运费金额不一致')
  return hasCents ? centsValue : yuanValue
}

function createLedgerRepository(storage, options) {
  const config = options || {}
  const now = config.now || (() => new Date())
  const makeId = config.makeId || (prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  const fallbackActor = Object.assign({
    id: 'member_local_admin', displayName: '管理员', role: 'admin', status: 'active'
  }, clone(config.actor || {}))

  function readRoot() {
    const stored = storage.read()
    return stored && stored.schemaVersion === 1 && stored.tenants ? stored : emptyRoot()
  }

  function ensureTenantShape(tenant, preserveShipments) {
    if (!tenant.enterprise) tenant.enterprise = { id: '', name: '未命名企业', defaultUnit: '米' }
    ;['clients', 'customProducts', 'customerPrices', 'shipments', 'payments', 'billingPeriods', 'auditLogs', 'memberships']
      .forEach(field => { if (!Array.isArray(tenant[field])) tenant[field] = [] })
    if (!preserveShipments) tenant.shipments.forEach(normalizeShipmentAmounts)
    return tenant
  }

  function requireTenant(root, tenantId, preserveShipments) {
    if (!tenantId || !root.tenants[tenantId]) throw new Error('企业数据空间不存在')
    return ensureTenantShape(root.tenants[tenantId], preserveShipments)
  }

  function currentActor(tenant) {
    const actorId = fallbackActor.id || fallbackActor.memberId
    const stored = tenant.memberships.find(item => item.id === actorId)
    const actor = stored || fallbackActor
    const actorTenantId = actor && actor.tenantId
    if (actorTenantId && actorTenantId !== tenant.enterprise.id) throw new Error('企业数据空间不存在')
    if (!actor || actor.status === 'disabled') throw new Error('当前成员已停用')
    return {
      id: actor.id || actor.memberId || 'member_local_admin',
      displayName: String(actor.displayName || '管理员').trim() || '管理员',
      role: actor.role || 'admin',
      status: actor.status || 'active'
    }
  }

  function requireAdmin(tenant) {
    const actor = currentActor(tenant)
    if (actor.role !== 'admin') throw new Error('当前账号没有管理员权限')
    return actor
  }

  function findActiveMember(tenant, memberId) {
    return tenant.memberships.find(item => item.id === memberId && item.status === 'active') || null
  }

  function memberName(member) {
    return String(member && member.displayName || '').trim() || '未设置'
  }

  function writeAudit(tenant, action, entityType, entityId, details) {
    const actor = currentActor(tenant)
    tenant.auditLogs.push(Object.assign({
      id: makeId('audit'), action, entityType, entityId, createdAt: now().toISOString(),
      performedByMemberId: actor.id,
      performedByNameSnapshot: actor.displayName
    }, clone(details || {})))
  }

  function initializeTenant(tenantId, seedData) {
    if (!tenantId) throw new Error('tenantId 不能为空')
    const root = readRoot()
    if (!root.tenants[tenantId]) {
      root.tenants[tenantId] = ensureTenantShape(clone(seedData || {
        enterprise: { id: tenantId, name: '未命名企业', defaultUnit: '米' }
      }))
      storage.write(root)
    } else {
      const before = JSON.stringify(root.tenants[tenantId])
      ensureTenantShape(root.tenants[tenantId])
      if (JSON.stringify(root.tenants[tenantId]) !== before) storage.write(root)
    }
    return clone(root.tenants[tenantId])
  }

  function initializeDemoTenant() {
    const seed = createDemoSeed()
    initializeTenant(DEMO_TENANT_ID, seed)
    const root = readRoot()
    const tenant = requireTenant(root, DEMO_TENANT_ID)
    let changed = false
    seed.customerPrices.forEach(seedPrice => {
      const exists = tenant.customerPrices.some(price =>
        price.clientId === seedPrice.clientId && price.productId === seedPrice.productId && price.active !== false)
      if (!exists) { tenant.customerPrices.push(clone(seedPrice)); changed = true }
    })
    seed.memberships.forEach(seedMember => {
      if (!tenant.memberships.some(member => member.id === seedMember.id)) {
        tenant.memberships.push(clone(seedMember)); changed = true
      }
    })
    if (changed) storage.write(root)
    return clone(tenant)
  }

  function getEnterprise(tenantId) {
    return clone(requireTenant(readRoot(), tenantId).enterprise)
  }

  function listMembers(tenantId, options) {
    const tenant = requireTenant(readRoot(), tenantId)
    const includeDisabled = !options || options.includeDisabled !== false
    return clone(tenant.memberships
      .filter(item => includeDisabled || item.status === 'active')
      .map(item => ({
        id: item.id,
        tenantId,
        displayName: memberName(item),
        role: item.role === 'admin' ? 'admin' : 'member',
        status: item.status === 'disabled' ? 'disabled' : 'active',
        joinedAt: item.joinedAt || item.createdAt || '',
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || '',
        clientCount: tenant.clients.filter(client => client.active !== false && client.ownerMemberId === item.id).length,
        openPeriodCount: allPeriods(tenant).filter(period => period.status === 'open' && period.ownerMemberId === item.id).length
      }))
      .sort((a, b) => (a.status === b.status ? a.displayName.localeCompare(b.displayName, 'zh-CN') : a.status === 'active' ? -1 : 1)))
  }

  function updateMemberDisplayName(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('修改成员姓名前必须确认')
    const displayName = String(input.displayName || '').trim()
    if (displayName.length < 2 || displayName.length > 20) throw new Error('企业显示姓名需为2到20个字符')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    requireAdmin(tenant)
    const member = tenant.memberships.find(item => item.id === input.memberId)
    if (!member) throw new Error('成员不存在')
    const before = { displayName: memberName(member) }
    member.displayName = displayName
    member.updatedAt = now().toISOString()
    writeAudit(tenant, 'UPDATE_MEMBER_DISPLAY_NAME', 'membership', member.id, {
      before, after: { displayName }
    })
    storage.write(root)
    return clone({ id: member.id, displayName, role: member.role, status: member.status })
  }

  function setMemberStatus(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('变更成员状态前必须确认')
    const nextStatus = input.status === 'active' ? 'active' : input.status === 'disabled' ? 'disabled' : ''
    if (!nextStatus) throw new Error('成员状态无效')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const actor = requireAdmin(tenant)
    const member = tenant.memberships.find(item => item.id === input.memberId)
    if (!member) throw new Error('成员不存在')
    if (member.id === actor.id && nextStatus === 'disabled') throw new Error('不能停用当前登录的管理员')
    if (member.status === nextStatus) return clone(member)
    if (nextStatus === 'disabled' && member.role === 'admin') {
      const activeAdminCount = tenant.memberships.filter(item => item.role === 'admin' && item.status === 'active').length
      if (activeAdminCount <= 1) throw new Error('企业必须至少保留一个有效管理员')
    }
    const ownedClients = tenant.clients.filter(item => item.active !== false && item.ownerMemberId === member.id)
    const ownedPeriods = allPeriods(tenant).filter(item => item.status === 'open' && item.ownerMemberId === member.id)
    if (nextStatus === 'disabled' && (ownedClients.length || ownedPeriods.length)) {
      const replacement = findActiveMember(tenant, input.replacementMemberId)
      if (!replacement || replacement.id === member.id) {
        throw new Error(`该成员当前仍负责${ownedClients.length}个客户和${ownedPeriods.length}个未结账期，请先选择接替成员`)
      }
      ownedClients.forEach(client => {
        const before = clone(client)
        client.ownerMemberId = replacement.id
        client.ownerNameSnapshot = memberName(replacement)
        client.updatedAt = now().toISOString()
        writeAudit(tenant, 'TRANSFER_CLIENT_OWNER', 'client', client.id, {
          before, after: clone(client), fromMemberId: member.id, toMemberId: replacement.id
        })
      })
      ownedPeriods.forEach(period => {
        const materialized = materializePeriod(tenant, period)
        const before = clone(materialized)
        materialized.ownerMemberId = replacement.id
        materialized.ownerNameSnapshot = memberName(replacement)
        materialized.updatedAt = now().toISOString()
        writeAudit(tenant, 'TRANSFER_PERIOD_OWNER', 'billing_period', materialized.id, {
          before, after: clone(materialized), fromMemberId: member.id, toMemberId: replacement.id
        })
      })
    }
    const before = clone(member)
    member.status = nextStatus
    member.updatedAt = now().toISOString()
    writeAudit(tenant, nextStatus === 'disabled' ? 'DISABLE_MEMBER' : 'RESTORE_MEMBER', 'membership', member.id, {
      before, after: clone(member)
    })
    storage.write(root)
    return clone({ id: member.id, displayName: memberName(member), role: member.role, status: member.status })
  }

  function assignUnownedClients(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('批量指定负责人前必须确认')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    requireAdmin(tenant)
    const member = findActiveMember(tenant, input.memberId)
    if (!member) throw new Error('接收负责人不存在或已停用')
    const targets = tenant.clients.filter(client => client.active !== false && !client.ownerMemberId)
    targets.forEach(client => {
      const before = clone(client)
      client.ownerMemberId = member.id
      client.ownerNameSnapshot = memberName(member)
      client.updatedAt = now().toISOString()
      writeAudit(tenant, 'ASSIGN_LEGACY_CLIENT_OWNER', 'client', client.id, { before, after: clone(client) })
      if (input.includeOpenPeriods === true) {
        allPeriods(tenant).filter(period => period.clientId === client.id && period.status === 'open' && !period.ownerMemberId)
          .forEach(period => {
            const materialized = materializePeriod(tenant, period)
            materialized.ownerMemberId = member.id
            materialized.ownerNameSnapshot = memberName(member)
            materialized.updatedAt = now().toISOString()
            writeAudit(tenant, 'ASSIGN_LEGACY_PERIOD_OWNER', 'billing_period', materialized.id, { after: clone(materialized) })
          })
      }
    })
    storage.write(root)
    return { assignedCount: targets.length }
  }

  function updateEnterprise(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('保存企业信息前必须确认')
    const name = String(input.name || '').trim()
    if (name.length < 2) throw new Error('请填写企业名称')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const before = clone(tenant.enterprise)
    tenant.enterprise = Object.assign({}, tenant.enterprise, {
      id: tenantId, name,
      contact: String(input.contact || '').trim(), phone: String(input.phone || '').trim(),
      address: String(input.address || '').trim(),
      defaultUnit: VALID_UNITS.includes(input.defaultUnit) ? input.defaultUnit : '米',
      updatedAt: now().toISOString()
    })
    writeAudit(tenant, 'UPDATE_ENTERPRISE', 'enterprise', tenantId, { before, after: tenant.enterprise })
    storage.write(root)
    return clone(tenant.enterprise)
  }

  function clientView(tenant, client) {
    if (!client) return null
    const owner = tenant.memberships.find(item => item.id === client.ownerMemberId)
    return Object.assign({}, client, {
      ownerDisplayName: owner ? memberName(owner) : (client.ownerNameSnapshot || '未设置')
    })
  }

  function listClients(tenantId, options) {
    const tenant = requireTenant(readRoot(), tenantId)
    const includeInactive = options && options.includeInactive
    return clone(tenant.clients.filter(item => includeInactive || item.active !== false).map(item => clientView(tenant, item))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN')))
  }

  function getClient(tenantId, clientId) {
    const tenant = requireTenant(readRoot(), tenantId)
    return clone(clientView(tenant, tenant.clients.find(item => item.id === clientId) || null))
  }

  function buildClientDeletePreview(tenant, client, actor) {
    const periods = allPeriods(tenant).filter(item => item.clientId === client.id)
    const periodIds = new Set(periods.map(item => item.id))
    const shipments = tenant.shipments.filter(item => item.clientId === client.id)
    const payments = tenant.payments.filter(item => item.clientId === client.id || periodIds.has(item.periodId))
    const customerPrices = tenant.customerPrices.filter(item => item.clientId === client.id)
    const openPeriods = periods.filter(item => item.status === 'open')
    const outstandingAmountCents = openPeriods.reduce((sum, period) =>
      sum + periodTotals(tenant, period.id).outstandingCents, 0)
    const preview = {
      clientId: client.id,
      clientName: client.name,
      hasBusinessData: Boolean(shipments.length || payments.length || periods.length || customerPrices.length),
      shipmentCount: shipments.length,
      paymentCount: payments.length,
      billingPeriodCount: periods.length,
      customerPriceCount: customerPrices.length,
      otherClientDataCount: 0,
      openPeriodCount: openPeriods.length,
      historicalPeriodCount: periods.filter(isClosedPeriod).length,
      outstandingAmountCents
    }
    preview.canDelete = actor.role === 'admin' || !preview.hasBusinessData
    preview.requiresStrongConfirmation = actor.role === 'admin' && preview.hasBusinessData
    return preview
  }

  function getClientDeletePreview(tenantId, clientId) {
    const tenant = requireTenant(readRoot(), tenantId)
    const actor = currentActor(tenant)
    const client = tenant.clients.find(item => item.id === clientId)
    if (!client) throw new Error('客户不存在或已被删除')
    return clone(buildClientDeletePreview(tenant, client, actor))
  }

  function deleteClient(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('删除客户前必须确认')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const actor = currentActor(tenant)
    const client = tenant.clients.find(item => item.id === input.clientId)
    if (!client) throw new Error('客户不存在或已被删除')
    const preview = buildClientDeletePreview(tenant, client, actor)
    if (actor.role !== 'admin' && preview.hasBusinessData) {
      throw new Error('该客户已有账务记录，普通成员不能删除，请联系管理员处理')
    }
    if (preview.hasBusinessData && String(input.confirmationName || '') !== client.name) {
      throw new Error('该客户已有账务记录，请重新预览并准确输入客户名称确认删除')
    }

    const periodIds = new Set(allPeriods(tenant).filter(item => item.clientId === client.id).map(item => item.id))
    tenant.clients = tenant.clients.filter(item => item.id !== client.id)
    tenant.shipments = tenant.shipments.filter(item => item.clientId !== client.id)
    tenant.payments = tenant.payments.filter(item => item.clientId !== client.id && !periodIds.has(item.periodId))
    tenant.billingPeriods = tenant.billingPeriods.filter(item => item.clientId !== client.id)
    tenant.customerPrices = tenant.customerPrices.filter(item => item.clientId !== client.id)

    const deletedAt = now().toISOString()
    const action = preview.hasBusinessData ? 'DELETE_CLIENT_WITH_LEDGER' : 'DELETE_EMPTY_CLIENT'
    writeAudit(tenant, action, 'client', client.id, Object.assign({}, preview, {
      tenantId,
      deletedClientId: client.id,
      clientNameSnapshot: client.name,
      deletedByMemberId: actor.id,
      deletedByNameSnapshot: actor.displayName,
      deletedAt
    }))
    storage.write(root)
    return clone(Object.assign({}, preview, { action, deletedAt }))
  }

  function saveClient(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('保存客户前必须确认')
    const name = String(input.name || '').trim()
    if (name.length < 2) throw new Error('客户名称至少需要2个字符')
    const settlementDayText = String(input.settlementDay == null ? '' : input.settlementDay).trim()
    const settlementDay = settlementDayText === '' ? null : Number(settlementDayText)
    if (settlementDay !== null && (!Number.isInteger(settlementDay) || settlementDay < 1 || settlementDay > 31)) {
      throw new Error('参考提醒日必须是1到31之间的整数')
    }
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const actor = currentActor(tenant)
    if (tenant.clients.some(item => item.active !== false && item.id !== input.id && String(item.name).trim() === name)) {
      throw new Error('已存在同名客户')
    }
    const timestamp = now().toISOString()
    let client = input.id ? tenant.clients.find(item => item.id === input.id) : null
    if (input.id && !client) throw new Error('客户不存在')
    const fields = {
      name, contact: String(input.contact || '').trim(), phone: String(input.phone || '').trim(),
      settlementType: '按次结清', settlementDay, note: String(input.note || '').trim(), updatedAt: timestamp
    }
    if (client) {
      const before = clone(client)
      Object.assign(client, fields)
      writeAudit(tenant, 'UPDATE_CLIENT', 'client', client.id, { before, after: clone(client) })
    } else {
      client = Object.assign({
        id: makeId('client'), tenantId, active: true, createdAt: timestamp,
        ownerMemberId: actor.id,
        ownerNameSnapshot: actor.displayName,
        createdByMemberId: actor.id,
        createdByNameSnapshot: actor.displayName
      }, fields)
      tenant.clients.push(client)
      writeAudit(tenant, 'CREATE_CLIENT', 'client', client.id, { after: clone(client) })
    }
    storage.write(root)
    return clone(client)
  }

  function updateClientOwner(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('转移客户负责人前必须确认')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    requireAdmin(tenant)
    const client = tenant.clients.find(item => item.id === input.clientId && item.active !== false)
    const nextOwner = findActiveMember(tenant, input.ownerMemberId)
    if (!client) throw new Error('客户不存在或已停用')
    if (!nextOwner) throw new Error('新负责人不存在或已停用')
    const before = clone(client)
    client.ownerMemberId = nextOwner.id
    client.ownerNameSnapshot = memberName(nextOwner)
    client.updatedAt = now().toISOString()
    writeAudit(tenant, 'TRANSFER_CLIENT_OWNER', 'client', client.id, {
      before, after: clone(client), fromMemberId: before.ownerMemberId || '', toMemberId: nextOwner.id
    })
    let updatedPeriod = null
    if (input.updateOpenPeriod === true) {
      const openPeriod = allPeriods(tenant).find(item => item.clientId === client.id && item.status === 'open')
      if (openPeriod) {
        const period = materializePeriod(tenant, openPeriod)
        const periodBefore = clone(period)
        period.ownerMemberId = nextOwner.id
        period.ownerNameSnapshot = memberName(nextOwner)
        period.updatedAt = now().toISOString()
        writeAudit(tenant, 'TRANSFER_PERIOD_OWNER', 'billing_period', period.id, {
          before: periodBefore, after: clone(period), fromMemberId: periodBefore.ownerMemberId || '', toMemberId: nextOwner.id
        })
        updatedPeriod = clone(period)
      }
    }
    storage.write(root)
    return { client: clone(client), period: updatedPeriod }
  }

  function updateBillingPeriodOwner(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('修改账期负责人前必须确认')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    requireAdmin(tenant)
    const resolved = allPeriods(tenant).find(item => item.id === input.periodId)
    const nextOwner = findActiveMember(tenant, input.ownerMemberId)
    if (!resolved || resolved.status !== 'open') throw new Error('只能修改当前未结账期负责人')
    if (!nextOwner) throw new Error('新负责人不存在或已停用')
    const period = materializePeriod(tenant, resolved)
    const before = clone(period)
    period.ownerMemberId = nextOwner.id
    period.ownerNameSnapshot = memberName(nextOwner)
    period.updatedAt = now().toISOString()
    writeAudit(tenant, 'TRANSFER_PERIOD_OWNER', 'billing_period', period.id, {
      before, after: clone(period), fromMemberId: before.ownerMemberId || '', toMemberId: nextOwner.id
    })
    storage.write(root)
    return clone(periodView(tenant, period))
  }

  function findProductForTenant(tenant, productId) {
    const standard = getProductById(productId)
    if (standard) {
      const override = tenant.customProducts.find(item => item.isStandardOverride && item.standardProductId === productId)
      return Object.assign({}, standard, { active: override ? override.active !== false : standard.active !== false })
    }
    return tenant.customProducts.find(item => !item.isStandardOverride && item.id === productId) || null
  }

  function priceActor(tenant) {
    if (!config.actor) return Object.assign({ tenantId: tenant.enterprise.id }, currentActor(tenant))
    const actor = tenant.memberships.find(item => item.id === (config.actor.id || config.actor.memberId))
    if (!actor || actor.status !== 'active' || actor.tenantId !== tenant.enterprise.id) {
      throw new Error('当前成员不存在或已停用')
    }
    return actor
  }

  function requireCustomerPriceAccess(tenant, clientId) {
    const storedClient = tenant.clients.find(item => item.id === clientId &&
      (item.tenantId === tenant.enterprise.id || (!config.actor && !item.tenantId)))
    const client = storedClient && Object.assign({ tenantId: tenant.enterprise.id }, storedClient)
    const actor = priceActor(tenant)
    if (!canManageCustomerPrices(actor, client, currentPriceOpenPeriod(tenant, clientId))) {
      const error = new Error('无权管理该客户价格，请联系客户负责人或管理员')
      error.code = 'CUSTOMER_PRICE_FORBIDDEN'
      throw error
    }
    return client
  }

  function getCustomerPriceAccess(tenantId, clientId) {
    const tenant = requireTenant(readRoot(), tenantId)
    return canManageCustomerPrices(priceActor(tenant),
      tenant.clients.filter(item => item.id === clientId && (item.tenantId === tenantId || (!config.actor && !item.tenantId)))
        .map(item => Object.assign({ tenantId }, item))[0],
      currentPriceOpenPeriod(tenant, clientId))
  }

  function getCustomerPrice(tenantId, clientId, productId, unit) {
    const tenant = requireTenant(readRoot(), tenantId)
    requireCustomerPriceAccess(tenant, clientId)
    const price = tenant.customerPrices.find(item => (item.tenantId === tenantId || (!config.actor && !item.tenantId)) &&
      item.clientId === clientId && item.productId === productId && item.unit === unit && item.active !== false)
    return clone(price || null)
  }

  function getCustomerPriceForProduct(tenantId, clientId, productId) {
    const tenant = requireTenant(readRoot(), tenantId)
    requireCustomerPriceAccess(tenant, clientId)
    const price = tenant.customerPrices.find(item => (item.tenantId === tenantId || (!config.actor && !item.tenantId)) &&
      item.clientId === clientId && item.productId === productId && item.active !== false)
    return clone(price || null)
  }

  function listCustomerPrices(tenantId, clientId) {
    const tenant = requireTenant(readRoot(), tenantId)
    requireCustomerPriceAccess(tenant, clientId)
    return clone(tenant.customerPrices.filter(item => (item.tenantId === tenantId || (!config.actor && !item.tenantId)) && item.clientId === clientId && item.active !== false)
      .map(item => {
        const product = findProductForTenant(tenant, item.productId)
        return Object.assign({}, item, { productLabel: product ? formatProductLabel(product) : '已停用产品' })
      }).sort((a, b) => a.productLabel.localeCompare(b.productLabel, 'zh-CN')))
  }

  function saveCustomerPrice(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('保存客户价格前必须确认')
    if (!VALID_UNITS.includes(input.unit)) throw new Error('计价单位无效')
    const unitPriceCents = input.unitPriceCents != null ? Number(input.unitPriceCents) : yuanToCents(input.unitPriceYuan)
    if (!Number.isInteger(unitPriceCents) || unitPriceCents <= 0) throw new Error('请输入有效单价')
    const root = readRoot()
    // Price edits must not even normalize legacy shipment records on write-back.
    const tenant = requireTenant(root, tenantId, true)
    // Existing prices are resolved before authorization; payload clientId cannot
    // redirect an ID-based edit to a different customer's permission scope.
    if (input.id && input.priceId && input.id !== input.priceId) throw new Error('价格记录编号不一致')
    const priceId = input.id || input.priceId
    let price = priceId
      ? tenant.customerPrices.find(item => item.id === priceId)
      : tenant.customerPrices.find(item => item.clientId === input.clientId && item.productId === input.productId && item.active !== false)
    if (priceId && (!price || price.active === false)) throw new Error('客户价格不存在或已停用')
    if (price && price.tenantId !== tenantId && (config.actor || price.tenantId)) throw new Error('客户价格不属于当前企业')
    const client = requireCustomerPriceAccess(tenant, price ? price.clientId : input.clientId)
    if (price && ((input.clientId && input.clientId !== price.clientId) || input.productId !== price.productId)) {
      throw new Error('价格记录与客户或产品不一致')
    }
    const product = findProductForTenant(tenant, input.productId)
    if (client.active === false) throw new Error('客户不存在或已停用')
    if (!product || product.active === false) throw new Error('产品不存在或已停用')
    const timestamp = now().toISOString()
    if (price) {
      const before = clone(price)
      Object.assign(price, { unit: input.unit, unitPriceCents, updatedAt: timestamp })
      writeAudit(tenant, 'UPDATE_CUSTOMER_PRICE', 'customer_price', price.id, { before, after: clone(price), clientId: client.id })
    } else {
      price = { id: makeId('price'), tenantId, clientId: client.id, productId: product.id, unit: input.unit, unitPriceCents, active: true, createdAt: timestamp, updatedAt: timestamp }
      tenant.customerPrices.push(price)
      writeAudit(tenant, 'CREATE_CUSTOMER_PRICE', 'customer_price', price.id, { after: clone(price), clientId: client.id })
    }
    storage.write(root)
    return clone(Object.assign({}, price, { productLabel: formatProductLabel(product) }))
  }

  function listCustomProducts(tenantId, options) {
    const includeInactive = options && options.includeInactive
    return clone(requireTenant(readRoot(), tenantId).customProducts.filter(item =>
      !item.isStandardOverride && (includeInactive || item.active !== false)))
  }

  function listProducts(tenantId, options) {
    const includeInactive = options && options.includeInactive
    const tenant = requireTenant(readRoot(), tenantId)
    const standard = products.map(item => {
      const override = tenant.customProducts.find(candidate => candidate.isStandardOverride && candidate.standardProductId === item.id)
      return Object.assign({}, item, { active: override ? override.active !== false : item.active !== false })
    }).filter(item => includeInactive || item.active !== false)
    return clone(standard.concat(listCustomProducts(tenantId, options)))
  }

  function createCustomProduct(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('创建自定义产品前必须经过人工确认')
    const name = String(input.name || '').trim()
    const normalizedName = normalizeCustomProductName(name)
    if (normalizedName.length < 2) throw new Error('自定义产品名称无效')
    const aliases = Array.from(new Set((input.aliases || []).map(value => String(value || '').trim())
      .filter(value => value && normalizeCustomProductName(value) !== normalizedName)))
    const recognitionKeywords = Array.from(new Set((input.recognitionKeywords || []).map(value => String(value || '').trim()).filter(Boolean)))
    const candidates = [name].concat(aliases).map(normalizeCustomProductName)
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const existing = tenant.customProducts.find(product => !product.isStandardOverride && product.active !== false &&
      [product.name || product.normalizedName].concat(product.aliases || [], product.recognitionKeywords || [])
        .some(value => candidates.includes(normalizeCustomProductName(value))))
    if (existing) {
      let changed = false
      const merge = (field, values) => {
        const next = Array.from(new Set((existing[field] || []).concat(values || [])))
        if (JSON.stringify(next) !== JSON.stringify(existing[field] || [])) { existing[field] = next; changed = true }
      }
      merge('aliases', aliases); merge('recognitionKeywords', recognitionKeywords); merge('specialTags', input.specialTags)
      ;['height', 'width', 'toothType', 'color', 'unitLengthMeters', 'lengthDescription'].forEach(field => {
        if ((existing[field] == null || existing[field] === '') && input[field] != null && input[field] !== '') { existing[field] = input[field]; changed = true }
      })
      if (existing.normalizedName !== normalizeCustomProductName(existing.name || name)) { existing.normalizedName = normalizeCustomProductName(existing.name || name); changed = true }
      if (changed) { existing.updatedAt = now().toISOString(); storage.write(root) }
      return clone(existing)
    }
    const timestamp = now().toISOString()
    const product = {
      id: makeId('custom_product'), tenantId, name, normalizedName, aliases, recognitionKeywords,
      height: input.height != null && input.height !== '' ? Number(input.height) : null,
      width: input.width != null && input.width !== '' ? Number(input.width) : null,
      toothType: input.toothType || null, color: input.color || null,
      unitLengthMeters: Number(input.unitLengthMeters) > 0 ? Number(input.unitLengthMeters) : null,
      lengthDescription: input.lengthDescription || '', specialTags: clone(input.specialTags || []),
      note: input.note || '', isStandard: false, productType: 'custom', active: true,
      createdAt: timestamp, updatedAt: timestamp
    }
    tenant.customProducts.push(product)
    writeAudit(tenant, 'CREATE_CUSTOM_PRODUCT', 'product', product.id, { after: clone(product) })
    storage.write(root)
    return clone(product)
  }

  function updateCustomProduct(tenantId, input) {
    if (!input || input.confirmed !== true) throw new Error('修改产品前必须确认')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const product = tenant.customProducts.find(item => !item.isStandardOverride && item.id === input.id)
    if (!product) throw new Error('自定义产品不存在')
    const name = String(input.name || '').trim()
    if (normalizeCustomProductName(name).length < 2) throw new Error('自定义产品名称无效')
    const before = clone(product)
    Object.assign(product, {
      name, normalizedName: normalizeCustomProductName(name),
      aliases: Array.from(new Set((input.aliases || []).map(item => String(item).trim()).filter(Boolean))),
      note: String(input.note || '').trim(), active: input.active !== false, updatedAt: now().toISOString()
    })
    writeAudit(tenant, 'UPDATE_CUSTOM_PRODUCT', 'product', product.id, { before, after: clone(product) })
    storage.write(root)
    return clone(product)
  }

  function setCustomProductActive(tenantId, productId, active) {
    const product = listCustomProducts(tenantId, { includeInactive: true }).find(item => item.id === productId)
    if (!product) throw new Error('自定义产品不存在')
    return updateCustomProduct(tenantId, Object.assign({}, product, { confirmed: true, active }))
  }

  function setProductActive(tenantId, productId, active) {
    const standard = getProductById(productId)
    if (!standard) return setCustomProductActive(tenantId, productId, active)
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    let override = tenant.customProducts.find(item => item.isStandardOverride && item.standardProductId === productId)
    const before = clone(override || { productId, active: standard.active !== false })
    if (!override) {
      override = {
        id: `standard_override_${productId}`,
        tenantId,
        standardProductId: productId,
        isStandardOverride: true,
        active: Boolean(active),
        createdAt: now().toISOString()
      }
      tenant.customProducts.push(override)
    } else {
      override.active = Boolean(active)
    }
    override.updatedAt = now().toISOString()
    writeAudit(tenant, 'SET_PRODUCT_ACTIVE', 'product', productId, {
      before,
      after: { productId, active: override.active }
    })
    storage.write(root)
    return clone(Object.assign({}, standard, { active: override.active }))
  }

  function allPeriods(tenant) {
    const result = tenant.billingPeriods.map(item => item)
    tenant.shipments.forEach(shipment => {
      const periodId = legacyPeriodIdForShipment(shipment)
      if (result.some(period => period.id === periodId && period.clientId === shipment.clientId)) return
      const dateText = String(shipment.shipmentDate || shipment.createdAt || now().toISOString()).slice(0, 10)
      result.push({
        id: periodId,
        tenantId: tenant.enterprise.id,
        clientId: shipment.clientId,
        periodKey: dateText.slice(0, 7),
        status: 'open',
        startedAt: `${dateText}T00:00:00.000Z`,
        startAt: `${dateText}T00:00:00.000Z`,
        createdAt: shipment.createdAt || `${dateText}T00:00:00.000Z`,
        legacyCompatibility: true
      })
    })
    return result
  }

  function materializePeriod(tenant, period) {
    const stored = tenant.billingPeriods.find(item => item.id === period.id && item.clientId === period.clientId)
    if (stored) return stored
    const copy = clone(period)
    delete copy.legacyCompatibility
    tenant.billingPeriods.push(copy)
    return copy
  }

  function periodShipments(tenant, periodId) {
    return tenant.shipments.filter(item => legacyPeriodIdForShipment(item) === periodId && item.status !== 'void')
  }

  function periodPayments(tenant, periodId) {
    return tenant.payments.filter(item => item.periodId === periodId && item.status !== 'void')
  }

  function periodSequenceNo(tenant, period) {
    if (Number.isInteger(period.sequenceNo) && period.sequenceNo > 0) return period.sequenceNo
    const periods = allPeriods(tenant).filter(item => item.clientId === period.clientId)
      .sort((a, b) => {
        const aStart = String(a.startAt || a.startedAt || a.createdAt || '')
        const bStart = String(b.startAt || b.startedAt || b.createdAt || '')
        return aStart.localeCompare(bStart) || String(a.id).localeCompare(String(b.id))
      })
    const index = periods.findIndex(item => item.id === period.id)
    return index >= 0 ? index + 1 : periods.length + 1
  }

  function periodDateInfo(tenant, period) {
    const shipments = periodShipments(tenant, period.id)
    const shipmentDates = shipments.map(item => item.shipmentDate).filter(Boolean).sort()
    const paymentDates = periodPayments(tenant, period.id).map(item => item.paymentDate).filter(Boolean).sort()
    const startDate = shipmentDates[0] || String(period.startAt || period.startedAt || period.createdAt || '').slice(0, 10)
    const closedTimestamp = period.closedAt || period.settledAt || ''
    const closedDate = String(closedTimestamp).slice(0, 10)
    const activityDates = shipmentDates.concat(paymentDates).sort()
    return {
      startDate,
      closedDate,
      lastActivityDate: activityDates[activityDates.length - 1] || startDate
    }
  }

  function ensureOpenPeriod(tenant, clientId, dateText) {
    const clientPeriods = allPeriods(tenant).filter(item => item.clientId === clientId)
    const latestClosedDate = clientPeriods.filter(isClosedPeriod)
      .map(item => periodDateInfo(tenant, item).closedDate).filter(Boolean).sort().pop()
    if (latestClosedDate && dateText < latestClosedDate) {
      throw new Error(`发货日期不能早于上一期结清日期 ${latestClosedDate}`)
    }
    const existing = clientPeriods.filter(item => item.status === 'open')
      .sort((a, b) => String(b.startAt || b.startedAt).localeCompare(String(a.startAt || a.startedAt)))[0]
    if (existing) return materializePeriod(tenant, existing)
    const periodKey = dateText.slice(0, 7)
    const sequenceNo = clientPeriods.reduce((max, item) => Math.max(max, periodSequenceNo(tenant, item)), 0) + 1
    const timestamp = now().toISOString()
    const client = tenant.clients.find(item => item.id === clientId)
    const period = {
      id: makeId('billing_period'), tenantId: tenant.enterprise.id, clientId,
      periodKey, sequence: sequenceNo, sequenceNo, status: 'open',
      ownerMemberId: client && client.ownerMemberId || '',
      ownerNameSnapshot: client && client.ownerNameSnapshot || '未设置',
      startedAt: `${dateText}T00:00:00.000Z`, startAt: `${dateText}T00:00:00.000Z`,
      goodsSubtotalCents: 0, itemsSubtotalCents: 0, freightCents: 0,
      totalAmountCents: 0, shipmentTotalCents: 0,
      receivedAmountCents: 0, receivedCents: 0,
      outstandingAmountCents: 0, outstandingCents: 0, shipmentCount: 0,
      createdAt: timestamp, updatedAt: timestamp
    }
    tenant.billingPeriods.push(period)
    return period
  }

  function periodTotals(tenant, periodId) {
    const shipments = periodShipments(tenant, periodId)
    const itemsSubtotalCents = shipments.reduce((sum, item) => sum + normalizeShipmentAmounts(item).itemsSubtotalCents, 0)
    const freightCents = shipments.reduce((sum, item) => sum + normalizeShipmentAmounts(item).freightCents, 0)
    const shipmentTotalCents = itemsSubtotalCents + freightCents
    const receivedCents = periodPayments(tenant, periodId).reduce((sum, item) => sum + item.amountCents, 0)
    const outstandingCents = Math.max(0, shipmentTotalCents - receivedCents)
    return {
      goodsSubtotalCents: itemsSubtotalCents,
      itemsSubtotalCents,
      freightCents,
      totalAmountCents: shipmentTotalCents,
      shipmentTotalCents,
      receivedAmountCents: receivedCents,
      receivedCents,
      outstandingAmountCents: outstandingCents,
      outstandingCents,
      shipmentCount: shipments.length
    }
  }

  function periodView(tenant, period) {
    const dates = periodDateInfo(tenant, period)
    const startAt = period.startAt || period.startedAt || (dates.startDate ? `${dates.startDate}T00:00:00.000Z` : '')
    const closedAt = period.closedAt || period.settledAt || ''
    const owner = tenant.memberships.find(item => item.id === period.ownerMemberId)
    return Object.assign({}, period, periodTotals(tenant, period.id), {
      sequenceNo: periodSequenceNo(tenant, period),
      startAt,
      startedAt: period.startedAt || startAt,
      closedAt,
      settledAt: period.settledAt || closedAt,
      startDate: dates.startDate,
      closedDate: dates.closedDate,
      isClosed: isClosedPeriod(period),
      ownerDisplayName: isClosedPeriod(period)
        ? (period.ownerNameSnapshot || '未设置')
        : (owner ? memberName(owner) : (period.ownerNameSnapshot || '未设置'))
    })
  }

  function syncPeriodSummary(tenant, period) {
    const summary = periodTotals(tenant, period.id)
    const dates = periodDateInfo(tenant, period)
    const startAt = dates.startDate ? `${dates.startDate}T00:00:00.000Z` : (period.startAt || period.startedAt)
    Object.assign(period, summary, {
      sequenceNo: period.sequenceNo || periodSequenceNo(tenant, period),
      startAt,
      startedAt: startAt,
      updatedAt: now().toISOString()
    })
    return summary
  }

  function buildShipmentLines(tenant, items) {
    if (!Array.isArray(items) || !items.length) throw new Error('至少需要一个商品')
    return items.map((input, index) => {
      const product = findProductForTenant(tenant, input.productId)
      if (!product || product.active === false) throw new Error(`第${index + 1}项产品不存在或已停用`)
      const priced = calculatePricedItem(input)
      if (!priced.quantity) throw new Error(`第${index + 1}项数量无效`)
      if (!VALID_UNITS.includes(priced.orderUnit)) throw new Error(`第${index + 1}项数量单位无效`)
      if (!VALID_UNITS.includes(priced.pricingUnit)) throw new Error(`第${index + 1}项计价单位无效`)
      if (priced.orderUnit !== priced.pricingUnit && !priced.conversionRate) throw new Error(`第${index + 1}项数量单位与计价单位不一致，必须人工填写换算关系`)
      if (!Number.isInteger(priced.unitPriceCents) || priced.unitPriceCents <= 0 || !priced.lineAmountCents) throw new Error(`第${index + 1}项缺少有效单价`)
      return {
        id: makeId('line'), productId: product.id,
        productSnapshot: {
          label: formatProductLabel(product), height: product.height, width: product.width,
          toothType: product.toothType, color: product.color,
          productType: product.productType || (product.isStandard === false ? 'custom' : 'wire-duct'),
          name: product.name || null, lengthDescription: product.lengthDescription || '',
          unitLengthMeters: product.unitLengthMeters || null, aliases: clone(product.aliases || []),
          recognitionKeywords: clone(product.recognitionKeywords || []), specialTags: clone(product.specialTags || []),
          isStandard: product.isStandard !== false
        },
        sourceText: input.sourceText || '', quantity: priced.quantity, unit: priced.orderUnit,
        originalQuantity: priced.quantity, originalUnit: priced.orderUnit,
        pricingQuantity: priced.pricingQuantity, pricingUnit: priced.pricingUnit,
        conversion: priced.orderUnit === priced.pricingUnit ? null : { fromUnit: priced.orderUnit, toUnit: priced.pricingUnit, multiplier: priced.conversionRate },
        unitPriceCents: priced.unitPriceCents, lineAmountCents: priced.lineAmountCents
      }
    })
  }

  function applySavedPrices(tenant, clientId, inputs, lines, timestamp) {
    if (inputs.some(input => input.saveAsDefault)) requireCustomerPriceAccess(tenant, clientId)
    inputs.forEach((input, index) => {
      if (!input.saveAsDefault) return
      const line = lines[index]
      const price = tenant.customerPrices.find(item => item.clientId === clientId && item.productId === line.productId && item.active !== false)
      if (price && price.tenantId !== tenant.enterprise.id && (config.actor || price.tenantId)) {
        throw new Error('客户价格不属于当前企业')
      }
      if (price) Object.assign(price, { unit: line.pricingUnit, unitPriceCents: line.unitPriceCents, updatedAt: timestamp })
      else tenant.customerPrices.push({ id: makeId('price'), tenantId: tenant.enterprise.id, clientId, productId: line.productId, unit: line.pricingUnit, unitPriceCents: line.unitPriceCents, active: true, createdAt: timestamp, updatedAt: timestamp })
    })
  }

  function postShipment(tenantId, payload) {
    if (!payload || payload.confirmed !== true) throw new Error('正式入账前必须经过人工确认')
    if (!payload.requestId) throw new Error('缺少防重复入账编号')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const actor = currentActor(tenant)
    const existing = tenant.shipments.find(item => item.requestId === payload.requestId)
    if (existing) return clone(existing)
    const client = tenant.clients.find(item => item.id === payload.clientId && item.active !== false)
    if (!client) throw new Error('客户不存在或已停用')
    const createdAt = now()
    const dateText = normalizeDate(payload.shipmentDate, localDateText(createdAt))
    const requestedPeriod = payload.periodId
      ? allPeriods(tenant).find(item => item.id === payload.periodId && item.clientId === client.id && item.status === 'open')
      : null
    const period = payload.periodId
      ? (requestedPeriod ? materializePeriod(tenant, requestedPeriod) : null)
      : ensureOpenPeriod(tenant, client.id, dateText)
    if (!period) throw new Error('账期不存在或已结清')
    const lines = buildShipmentLines(tenant, payload.items)
    const itemsSubtotalCents = lines.reduce((sum, line) => sum + line.lineAmountCents, 0)
    const freightCents = resolveFreightCents(payload)
    const totalAmountCents = itemsSubtotalCents + freightCents
    const timestamp = createdAt.toISOString()
    const shipment = {
      id: makeId('shipment'), requestId: payload.requestId, tenantId, clientId: client.id,
      clientNameSnapshot: client.name, periodId: period.id, periodKey: period.periodKey,
      createdByMemberId: actor.id, createdByNameSnapshot: actor.displayName,
      shipmentDate: dateText, status: 'posted', sourceText: payload.sourceText || '',
      logistics: clone(payload.logistics || { provider: null, raw: '' }), note: payload.note || '',
      lines, itemsSubtotalCents, freightCents, totalAmountCents, createdAt: timestamp, updatedAt: timestamp
    }
    applySavedPrices(tenant, client.id, payload.items, lines, timestamp)
    tenant.shipments.push(shipment)
    syncPeriodSummary(tenant, period)
    writeAudit(tenant, 'CREATE_SHIPMENT', 'shipment', shipment.id, { clientId: client.id, periodId: period.id, amountCents: totalAmountCents, after: clone(shipment) })
    storage.write(root)
    return clone(shipment)
  }

  function shipmentEditContext(tenant, tenantId, shipmentId) {
    const shipment = tenant.shipments.find(item => item.id === shipmentId && item.status !== 'void')
    if (!shipment || shipment.tenantId !== tenantId) throw new Error('发货记录不存在或不属于当前企业')
    const client = tenant.clients.find(item => item.id === shipment.clientId)
    // Resolve legacy IDs only against stored periods. Never authorize a synthetic
    // open period when a referenced period is missing or belongs to another client.
    const period = tenant.billingPeriods.find(item => item.id === legacyPeriodIdForShipment(shipment))
    if (!client || client.tenantId !== tenantId || !period || period.tenantId !== tenantId ||
        period.clientId !== shipment.clientId) {
      throw new Error('发货记录关联的客户或账期不存在，或归属不一致，暂不能修正')
    }
    return { shipment, client, period }
  }

  function getShipmentEditContext(tenantId, shipmentId) {
    const tenant = requireTenant(readRoot(), tenantId)
    const context = shipmentEditContext(tenant, tenantId, shipmentId)
    return clone({ client: context.client, period: periodView(tenant, context.period) })
  }

  function updateShipment(tenantId, shipmentId, payload) {
    if (!payload || payload.confirmed !== true) throw new Error('修正账目前必须经过人工确认')
    const reason = String(payload.reason || '').trim()
    if (reason.length < 2) throw new Error('请填写修正原因')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    // Explicit actors must still exist and be active in the current transaction
    // snapshot. Only the standalone local demo may use the default actor.
    let actor
    if (config.actor) {
      const member = tenant.memberships.find(item => item.id === (config.actor.id || config.actor.memberId))
      if (!member || member.status !== 'active' || member.tenantId !== tenantId) {
        throw new Error('当前成员不存在或已停用')
      }
      actor = member
    } else {
      actor = currentActor(tenant)
    }
    const { shipment, client, period } = shipmentEditContext(tenant, tenantId, shipmentId)
    if (isClosedPeriod(period)) throw new Error('已结清账单不可直接修改')
    if (period.status !== 'open') throw new Error('账期状态异常，暂不能修正')
    if (!canEditShipment(actor, client, period)) throw new Error('仅管理员或客户当前负责人可以修正发货账目')
    if (actor.role !== 'admin' && (payload.items || []).some(item => item.saveAsDefault)) {
      throw new Error('修改客户默认价格仅限管理员，请仅修改本笔成交价格')
    }
    const before = clone(shipment)
    const lines = buildShipmentLines(tenant, payload.items)
    const itemsSubtotalCents = lines.reduce((sum, line) => sum + line.lineAmountCents, 0)
    const freightCents = resolveFreightCents(payload, shipment.freightCents)
    const nextTotalAmountCents = itemsSubtotalCents + freightCents
    const otherShipmentCents = tenant.shipments
      .filter(item => legacyPeriodIdForShipment(item) === legacyPeriodIdForShipment(shipment) && item.id !== shipment.id && item.status !== 'void')
      .reduce((sum, item) => sum + item.totalAmountCents, 0)
    const receivedCents = tenant.payments
      .filter(item => item.periodId === legacyPeriodIdForShipment(shipment) && item.status !== 'void')
      .reduce((sum, item) => sum + item.amountCents, 0)
    if (otherShipmentCents + nextTotalAmountCents < receivedCents) {
      throw new Error('修正后的本期货款不能低于已收款金额')
    }
    const timestamp = now().toISOString()
    Object.assign(shipment, {
      shipmentDate: normalizeDate(payload.shipmentDate, shipment.shipmentDate),
      sourceText: payload.sourceText != null ? payload.sourceText : shipment.sourceText,
      logistics: clone(payload.logistics || shipment.logistics), note: payload.note != null ? String(payload.note) : shipment.note,
      lines, itemsSubtotalCents, freightCents, totalAmountCents: nextTotalAmountCents, updatedAt: timestamp
    })
    if (period) syncPeriodSummary(tenant, period)
    applySavedPrices(tenant, shipment.clientId, payload.items, lines, timestamp)
    writeAudit(tenant, 'UPDATE_SHIPMENT', 'shipment', shipment.id, { clientId: shipment.clientId, periodId: period ? period.id : shipment.periodId, reason, before, after: clone(shipment) })
    storage.write(root)
    return clone(shipment)
  }

  function getShipment(tenantId, shipmentId) {
    return clone(requireTenant(readRoot(), tenantId).shipments.find(item => item.id === shipmentId) || null)
  }

  function listShipments(tenantId, clientId, periodId) {
    return clone(requireTenant(readRoot(), tenantId).shipments
      .filter(item => item.status !== 'void' && (!clientId || item.clientId === clientId) && (!periodId || legacyPeriodIdForShipment(item) === periodId))
      .sort((a, b) => `${b.shipmentDate}${b.createdAt}`.localeCompare(`${a.shipmentDate}${a.createdAt}`)))
  }

  function recordPayment(tenantId, payload) {
    if (!payload || payload.confirmed !== true) throw new Error('记录收款前必须经过人工确认')
    if (!payload.requestId) throw new Error('缺少防重复收款编号')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const actor = currentActor(tenant)
    const existing = tenant.payments.find(item => item.requestId === payload.requestId)
    if (existing) {
      const existingPeriod = allPeriods(tenant).find(item => item.id === existing.periodId)
      const existingTotals = existingPeriod ? periodTotals(tenant, existingPeriod.id) : { outstandingCents: null }
      return clone(Object.assign({}, existing, {
        periodStatus: existingPeriod ? existingPeriod.status : '',
        remainingCents: existingTotals.outstandingCents,
        needsSettlementConfirmation: Boolean(existingPeriod && existingPeriod.status === 'open' && existingTotals.outstandingCents === 0)
      }))
    }
    const client = tenant.clients.find(item => item.id === payload.clientId && item.active !== false)
    if (!client) throw new Error('客户不存在或已停用')
    const resolvedPeriod = payload.periodId
      ? allPeriods(tenant).find(item => item.id === payload.periodId && item.clientId === client.id)
      : allPeriods(tenant).find(item => item.clientId === client.id && item.status === 'open')
    const period = resolvedPeriod ? materializePeriod(tenant, resolvedPeriod) : null
    if (!period || period.status !== 'open') throw new Error('没有可收款的未结账期')
    const amountCents = payload.amountCents != null ? Number(payload.amountCents) : yuanToCents(payload.amountYuan)
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('请输入有效收款金额')
    const beforeTotals = periodTotals(tenant, period.id)
    if (!beforeTotals.shipmentTotalCents) throw new Error('当前账期没有货款')
    if (amountCents > beforeTotals.outstandingCents) throw new Error('收款金额不能超过剩余应收')
    const timestamp = now().toISOString()
    const payment = {
      id: makeId('payment'), requestId: payload.requestId, tenantId, clientId: client.id,
      clientNameSnapshot: client.name, periodId: period.id, amountCents,
      createdByMemberId: actor.id, createdByNameSnapshot: actor.displayName,
      paymentDate: normalizeDate(payload.paymentDate, localDateText(now())),
      method: VALID_PAYMENT_METHODS.includes(payload.method) ? payload.method : '其他',
      note: String(payload.note || '').trim(), status: 'posted', createdAt: timestamp
    }
    tenant.payments.push(payment)
    const afterTotals = periodTotals(tenant, period.id)
    syncPeriodSummary(tenant, period)
    writeAudit(tenant, 'CREATE_PAYMENT', 'payment', payment.id, { clientId: client.id, periodId: period.id, amountCents, after: clone(payment), periodStatus: period.status })
    storage.write(root)
    return clone(Object.assign({}, payment, {
      periodStatus: period.status,
      remainingCents: afterTotals.outstandingCents,
      needsSettlementConfirmation: afterTotals.outstandingCents === 0
    }))
  }

  function closeBillingPeriod(tenantId, payload) {
    if (!payload || payload.confirmed !== true) throw new Error('结清本期前必须经过人工确认')
    if (!payload.periodId) throw new Error('缺少账期编号')
    const root = readRoot()
    const tenant = requireTenant(root, tenantId)
    const actor = currentActor(tenant)
    const resolvedPeriod = allPeriods(tenant).find(item =>
      item.id === payload.periodId && (!payload.clientId || item.clientId === payload.clientId))
    if (!resolvedPeriod) throw new Error('账期不存在')
    if (!canCloseBillingPeriod(actor, resolvedPeriod)) {
      const owner = tenant.memberships.find(item => item.id === resolvedPeriod.ownerMemberId)
      const ownerName = owner ? memberName(owner) : (resolvedPeriod.ownerNameSnapshot || '当前账期负责人')
      throw new Error(`该账期由${ownerName}负责，仅账期负责人或管理员可以结清`)
    }
    const duplicateAudit = payload.requestId && tenant.auditLogs.find(item =>
      item.action === 'CLOSE_BILLING_PERIOD' && item.requestId === payload.requestId)
    if (duplicateAudit) {
      const duplicate = allPeriods(tenant).find(item => item.id === duplicateAudit.entityId)
      return duplicate ? clone(periodView(tenant, duplicate)) : null
    }
    if (isClosedPeriod(resolvedPeriod)) throw new Error('本期已经结清')
    const period = materializePeriod(tenant, resolvedPeriod)
    const totals = periodTotals(tenant, period.id)
    if (!totals.shipmentCount || !totals.shipmentTotalCents) throw new Error('当前账期没有可结清的货款')
    if (totals.outstandingCents !== 0) throw new Error('剩余应收不为0，不能结清本期')
    const timestamp = now().toISOString()
    const dates = periodDateInfo(tenant, period)
    const closedDate = normalizeDate(payload.closedDate, localDateText(now()))
    if (dates.startDate && closedDate < dates.startDate) throw new Error('结清日期不能早于账期开始日期')
    if (dates.lastActivityDate && closedDate < dates.lastActivityDate) throw new Error('结清日期不能早于本期最后一笔业务日期')
    const before = clone(period)
    const closedAt = `${closedDate}T00:00:00.000Z`
    Object.assign(period, totals, {
      sequenceNo: period.sequenceNo || periodSequenceNo(tenant, period),
      status: 'settled',
      closedAt,
      settledAt: closedAt,
      updatedAt: timestamp
    })
    writeAudit(tenant, 'CLOSE_BILLING_PERIOD', 'billing_period', period.id, {
      requestId: payload.requestId || '',
      clientId: period.clientId,
      before,
      after: clone(period)
    })
    storage.write(root)
    return clone(periodView(tenant, period))
  }

  function listPayments(tenantId, clientId, periodId) {
    return clone(requireTenant(readRoot(), tenantId).payments
      .filter(item => item.status !== 'void' && (!clientId || item.clientId === clientId) && (!periodId || item.periodId === periodId))
      .sort((a, b) => `${b.paymentDate}${b.createdAt}`.localeCompare(`${a.paymentDate}${a.createdAt}`)))
  }

  function listBillingPeriods(tenantId, clientId, status) {
    const tenant = requireTenant(readRoot(), tenantId)
    return clone(allPeriods(tenant)
      .filter(item => (!clientId || item.clientId === clientId) && (!status || (status === 'open' ? item.status === 'open' : isClosedPeriod(item))))
      .map(item => periodView(tenant, item))
      .sort((a, b) => String(b.startAt).localeCompare(String(a.startAt))))
  }

  function getPeriodDetail(tenantId, periodId) {
    const tenant = requireTenant(readRoot(), tenantId)
    const period = allPeriods(tenant).find(item => item.id === periodId)
    if (!period) return null
    return clone({
      period: periodView(tenant, period),
      client: tenant.clients.find(item => item.id === period.clientId),
      shipments: periodShipments(tenant, period.id).sort((a, b) => b.shipmentDate.localeCompare(a.shipmentDate)),
      payments: periodPayments(tenant, period.id).sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
    })
  }

  function getClientLedger(tenantId, clientId) {
    const client = getClient(tenantId, clientId)
    if (!client) return null
    const period = listBillingPeriods(tenantId, clientId, 'open')[0] || null
    if (!period) return { client, period: null, shipments: [], payments: [], shipmentCount: 0, itemsSubtotalCents: 0, freightCents: 0, shipmentTotalCents: 0, receivedCents: 0, outstandingCents: 0 }
    const shipments = listShipments(tenantId, clientId, period.id)
    const payments = listPayments(tenantId, clientId, period.id)
    return { client, period, shipments, payments, shipmentCount: shipments.length, itemsSubtotalCents: period.itemsSubtotalCents, freightCents: period.freightCents, shipmentTotalCents: period.shipmentTotalCents, receivedCents: period.receivedCents, outstandingCents: period.outstandingCents }
  }

  function getDashboard(tenantId) {
    const ledgers = listClients(tenantId).map(client => getClientLedger(tenantId, client.id))
    return {
      totalOutstandingCents: ledgers.reduce((sum, item) => sum + item.outstandingCents, 0),
      unsettledClientCount: ledgers.filter(item => item.period).length,
      clients: ledgers, recentShipments: listShipments(tenantId).slice(0, 5), recentPayments: listPayments(tenantId).slice(0, 5)
    }
  }

  function getStatement(tenantId, clientId, periodId) {
    const ledger = periodId ? getPeriodDetail(tenantId, periodId) : getClientLedger(tenantId, clientId)
    if (!ledger) return null
    const period = ledger.period
    const shipments = ledger.shipments || []
    const activityDates = shipments.map(item => item.shipmentDate)
      .concat((ledger.payments || []).map(item => item.paymentDate)).filter(Boolean).sort()
    const startDate = period ? period.startDate : ''
    const openEndDate = [localDateText(now())].concat(activityDates).sort().pop()
    const endDate = period && period.isClosed ? period.closedDate : openEndDate
    return clone({
      client: ledger.client, period,
      periodLabel: startDate ? `${startDate} ～ ${endDate || startDate}` : '当前暂无发货',
      shipments, payments: ledger.payments || [],
      totals: period
        ? { itemsSubtotalCents: period.itemsSubtotalCents, freightCents: period.freightCents, shipmentTotalCents: period.shipmentTotalCents, receivedCents: period.receivedCents, outstandingCents: period.outstandingCents }
        : { itemsSubtotalCents: 0, freightCents: 0, shipmentTotalCents: 0, receivedCents: 0, outstandingCents: 0 }
    })
  }

  function getAuditLogs(tenantId, entityId) {
    return clone(requireTenant(readRoot(), tenantId).auditLogs.filter(item => !entityId || item.entityId === entityId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))))
  }

  return {
    initializeTenant, initializeDemoTenant, getEnterprise, updateEnterprise,
    listMembers, updateMemberDisplayName, setMemberStatus, assignUnownedClients,
    listClients, getClient, getClientDeletePreview, deleteClient, saveClient, updateClientOwner, updateBillingPeriodOwner,
    getCustomerPriceAccess, getCustomerPrice, getCustomerPriceForProduct, listCustomerPrices, saveCustomerPrice,
    listCustomProducts, listProducts, createCustomProduct, updateCustomProduct, setCustomProductActive, setProductActive,
    postShipment, updateShipment, getShipment, getShipmentEditContext, listShipments,
    recordPayment, closeBillingPeriod, listPayments, listBillingPeriods, getPeriodDetail,
    getClientLedger, getDashboard, getStatement, getAuditLogs
  }
}

module.exports = { VALID_UNITS, VALID_PAYMENT_METHODS, currentPeriodId, canCloseBillingPeriod, canEditShipment, canManageCustomerPrices, currentPriceOpenPeriod, createLedgerRepository }
