const {
  getRepository,
  prepareRepository,
  getActiveTenantId,
  isCloudMode
} = require('../../services/repository-instance')
const { handleAccessError } = require('../../services/page-context')
const { parseOrderText } = require('../../services/order-parser')
const { formatProductLabel } = require('../../data/product-specs')
const { calculatePricedItem } = require('../../services/pricing')
const { yuanToCents, centsToYuan, formatCurrency } = require('../../utils/money')

const UNIT_OPTIONS = ['米', '根', '箱']
const COLOR_OPTIONS = ['未设置', '灰色', '白色', '蓝色', '黑色']
const TOOTH_OPTIONS = ['未设置', '粗齿', '细齿', '封口', '全封闭']
const ACCEPTANCE_SAMPLE = '40×40开口灰色 100米\n60×40细齿灰色 50米\n80×60开口灰色 30米'

function buildProductOptions(repository) {
  return repository.listProducts(getActiveTenantId()).map(product => {
    const label = formatProductLabel(product)
    const compactDimension = product.height != null && product.width != null
      ? `${product.height}${product.width}`
      : ''
    return {
      id: product.id,
      label,
      searchText: [label, compactDimension]
        .concat(product.aliases || [], product.recognitionKeywords || [])
        .join(' ')
        .toLowerCase(),
      isStandard: product.isStandard !== false,
      unitLengthMeters: product.unitLengthMeters || null,
      height: product.height != null ? product.height : null,
      width: product.width != null ? product.width : null,
      toothType: product.toothType || null,
      color: product.color || null
    }
  })
}

function splitAliases(value) {
  return Array.from(new Set(String(value || '')
    .split(/[；;\n]/)
    .map(item => item.trim())
    .filter(Boolean)))
}

function todayText() {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function priceFields(price, fallbackUnit) {
  const pricingUnit = price ? price.unit : fallbackUnit
  return {
    pricingUnit,
    pricingUnitIndex: Math.max(0, UNIT_OPTIONS.indexOf(pricingUnit)),
    unitPriceYuan: price ? centsToYuan(price.unitPriceCents) : '',
    savedPriceCents: price ? price.unitPriceCents : null,
    savedPriceUnit: price ? price.unit : '',
    savedPriceText: price ? `${formatCurrency(price.unitPriceCents)}/${price.unit}` : '',
    saveAsDefault: !price,
    priceStateText: price
      ? `客户保存价 ${formatCurrency(price.unitPriceCents)}/${price.unit}`
      : `该客户尚未设置此产品价格，已按本次数量单位预选“${fallbackUnit}”`,
    priceStateClass: price ? 'success-text' : 'warning-text'
  }
}

Page({
  data: {
    clients: [],
    clientNames: [],
    selectedClientIndex: 0,
    selectedClientId: '',
    shipmentDate: todayText(),
    orderText: '',
    hasParsed: false,
    rows: [],
    productOptions: [],
    standardProductOptions: [],
    customProductOptions: [],
    filteredProductOptions: [],
    selectorOpen: false,
    selectorRowIndex: -1,
    selectorTab: 'standard',
    selectorSearch: '',
    showCustomForm: false,
    customForm: null,
    colorOptions: COLOR_OPTIONS,
    toothOptions: TOOTH_OPTIONS,
    unitOptions: UNIT_OPTIONS,
    unmatchedLines: [],
    logisticsText: '无',
    parsedLogistics: { provider: null, raw: '' },
    freightYuan: '0.00',
    freightError: '',
    missingCount: 0,
    attentionCount: 0,
    itemsSubtotalText: '¥0.00',
    freightText: '¥0.00',
    totalText: '¥0.00',
    canPost: false,
    submitting: false,
    editing: false,
    editReason: ''
  },

  onLoad(options) {
    this.loadOptions = options || {}
    if (isCloudMode()) {
      wx.showLoading({ title: '加载账本' })
      prepareRepository().then(() => {
        wx.hideLoading()
        this.initializePage()
      }).catch(error => {
        wx.hideLoading()
        if (handleAccessError(error)) return
        wx.showModal({ title: '无法登录', content: error.message || '请检查云开发环境', showCancel: false })
      })
      return
    }
    this.initializePage()
  },

  initializePage() {
    const repository = getRepository()
    repository.initializeDemoTenant()
    const clients = repository.listClients(getActiveTenantId())
    const productOptions = buildProductOptions(repository)
    this.setData({
      clients,
      clientNames: clients.map(client => client.name),
      selectedClientIndex: Math.max(0, clients.findIndex(client => client.id === this.loadOptions.clientId)),
      selectedClientId: this.loadOptions.clientId || (clients.length ? clients[0].id : ''),
      productOptions,
      standardProductOptions: productOptions.filter(option => option.isStandard),
      customProductOptions: productOptions.filter(option => !option.isStandard)
    }, () => {
      if (this.loadOptions.shipmentId) this.loadShipmentForEdit(this.loadOptions.shipmentId)
    })
  },

  loadShipmentForEdit(shipmentId) {
    const shipment = getRepository().getShipment(getActiveTenantId(), shipmentId)
    if (!shipment) {
      wx.showModal({
        title: '记录不存在', content: '该发货记录不存在，可能已随客户删除。', showCancel: false,
        success: () => wx.switchTab({ url: '/pages/clients/clients' })
      })
      return
    }
    const selectedClientIndex = Math.max(0, this.data.clients.findIndex(client => client.id === shipment.clientId))
    this.setData({
      editing: true,
      selectedClientIndex,
      selectedClientId: shipment.clientId,
      shipmentDate: shipment.shipmentDate,
      orderText: shipment.sourceText || '',
      hasParsed: true,
      parsedLogistics: shipment.logistics || { provider: null, raw: '' },
      logisticsText: shipment.logistics && (shipment.logistics.provider || shipment.logistics.raw) || '无',
      freightYuan: centsToYuan(shipment.freightCents || 0)
    })
    const rows = shipment.lines.map((line, index) => {
      const row = this.buildRow({
        sourceText: line.sourceText || '', productId: line.productId,
        productLabel: line.productSnapshot.label, quantityText: String(line.originalQuantity),
        unit: line.originalUnit, issues: []
      }, index)
      return Object.assign({}, row, {
        pricingUnit: line.pricingUnit,
        pricingUnitIndex: Math.max(0, UNIT_OPTIONS.indexOf(line.pricingUnit)),
        unitPriceYuan: centsToYuan(line.unitPriceCents),
        conversionRateText: line.conversion ? String(line.conversion.multiplier) : '',
        saveAsDefault: false
      })
    })
    this.recalculate(rows)
    wx.setNavigationBarTitle({ title: '修正发货记录' })
  },

  onClientChange(event) {
    const index = Number(event.detail.value)
    const client = this.data.clients[index]
    this.setData({ selectedClientIndex: index, selectedClientId: client ? client.id : '' })
    if (this.data.rows.length) this.reloadPricesForClient()
  },

  onDateChange(event) {
    this.setData({ shipmentDate: event.detail.value })
  },

  onTextInput(event) {
    this.setData({ orderText: event.detail.value })
  },

  onEditReasonInput(event) {
    this.setData({ editReason: event.detail.value })
  },

  onFreightInput(event) {
    this.setData({ freightYuan: event.detail.value }, () => this.recalculate(this.data.rows))
  },

  loadAcceptanceSample() {
    this.setData({ orderText: ACCEPTANCE_SAMPLE }, () => this.parseOrder())
  },

  parseOrder() {
    if (!this.data.selectedClientId) {
      wx.showToast({ title: '请先选择客户', icon: 'none' })
      return
    }
    const repository = getRepository()
    const result = parseOrderText(this.data.orderText, {
      customProducts: repository.listCustomProducts(getActiveTenantId())
    })
    const rows = result.items.map((item, index) => this.buildRow(item, index))
    this.setData({
      hasParsed: true,
      rows,
      unmatchedLines: result.unmatchedLines,
      logisticsText: result.logistics.provider || result.logistics.raw || '无',
      parsedLogistics: result.logistics
    })
    this.recalculate(rows)
  },

  buildRow(item, index) {
    const productIndex = this.data.productOptions.findIndex(option => option.id === item.productId)
    const productOption = productIndex >= 0 ? this.data.productOptions[productIndex] : null
    const effectiveProductId = item.productId && productOption ? item.productId : ''
    const price = effectiveProductId
      ? getRepository().getCustomerPriceForProduct(
        getActiveTenantId(),
        this.data.selectedClientId,
        effectiveProductId
      )
      : null
    return Object.assign({
      rowId: `row_${Date.now()}_${index}`,
      sourceText: item.sourceText,
      productId: effectiveProductId,
      productIndex,
      productLabel: item.productLabel,
      quantityText: item.quantityText || '',
      unit: item.unit || '米',
      unitIndex: Math.max(0, UNIT_OPTIONS.indexOf(item.unit || '米')),
      conversionRateText: '',
      pricingQuantityText: '',
      calculationText: '',
      needsProductConfirmation: !effectiveProductId,
      canCreateCustomProduct: Boolean(item.canCreateCustomProduct),
      customProductDraft: item.customProductDraft || null,
      height: item.height != null ? item.height : (productOption && productOption.height),
      width: item.width != null ? item.width : (productOption && productOption.width),
      toothType: item.toothType || (productOption && productOption.toothType) || null,
      color: item.color || (productOption && productOption.color) || null,
      productLengthMeters: item.productLengthMeters || (productOption && productOption.unitLengthMeters) || null,
      specialLengthText: item.productLengthMeters
        ? `特殊长度 ${item.productLengthMeters}米/根`
        : ((productOption && productOption.unitLengthMeters)
            ? `特殊长度 ${productOption.unitLengthMeters}米/根`
            : ''),
      issues: item.issues.map(issue => issue.message).concat(item.productId && !productOption ? '该产品已停用，请人工选择其他产品' : []),
      lineAmountText: '¥0.00',
      priceChanged: false,
      unitMismatch: false,
      rowValid: false,
      suggestedConversionRate: ''
    }, priceFields(price, item.unit || '米'))
  },

  reloadPricesForClient() {
    const repository = getRepository()
    const rows = this.data.rows.map(row => {
      if (!row.productId) return row
      const price = repository.getCustomerPriceForProduct(
        getActiveTenantId(),
        this.data.selectedClientId,
        row.productId
      )
      return Object.assign({}, row, priceFields(price, row.unit), { conversionRateText: '' })
    })
    this.recalculate(rows)
  },

  recalculate(inputRows) {
    let missingCount = 0
    let attentionCount = 0
    let itemsSubtotalCents = 0
    const rows = inputRows.map(row => {
      const priced = calculatePricedItem({
        productId: row.productId,
        quantityText: row.quantityText,
        orderUnit: row.unit,
        pricingUnit: row.pricingUnit,
        conversionRateText: row.conversionRateText,
        unitPriceYuan: row.unitPriceYuan
      })
      const priceValid = Number.isInteger(priced.unitPriceCents) && priced.unitPriceCents > 0
      const rowValid = Boolean(
        row.productId && priced.quantity && priced.orderUnit && priced.pricingUnit &&
        priced.pricingQuantity && priceValid
      )
      const unitMismatch = Boolean(priced.orderUnit && priced.pricingUnit && priced.orderUnit !== priced.pricingUnit)
      const suggestedConversionRate = unitMismatch && priced.orderUnit === '根' &&
        priced.pricingUnit === '米' && Number(row.productLengthMeters) > 0
        ? String(Number(row.productLengthMeters))
        : ''
      const lineAmountCents = rowValid ? priced.lineAmountCents : 0
      const priceChanged = Number.isInteger(row.savedPriceCents) && priceValid &&
        (row.savedPriceCents !== priced.unitPriceCents || row.savedPriceUnit !== priced.pricingUnit)

      if (!priceValid) missingCount += 1
      if (!rowValid) attentionCount += 1
      itemsSubtotalCents += lineAmountCents || 0

      let calculationText = ''
      if (rowValid && unitMismatch) {
        calculationText = `${priced.quantity}${priced.orderUnit} × ${priced.conversionRate}${priced.pricingUnit}/${priced.orderUnit} = ${priced.pricingQuantity}${priced.pricingUnit}`
      } else if (rowValid) {
        calculationText = `${priced.quantity}${priced.orderUnit} 直接按 ${priced.pricingUnit} 计价`
      }

      return Object.assign({}, row, {
        rowValid,
        unitMismatch,
        suggestedConversionRate,
        priceChanged,
        pricingQuantityText: priced.pricingQuantity ? String(priced.pricingQuantity) : '',
        calculationText,
        lineAmountText: formatCurrency(lineAmountCents || 0)
      })
    })

    const freightTextInput = String(this.data.freightYuan == null ? '' : this.data.freightYuan).trim()
    const freightCents = freightTextInput === '' ? 0 : yuanToCents(freightTextInput)
    const freightValid = Number.isInteger(freightCents) && freightCents >= 0
    const totalCents = itemsSubtotalCents + (freightValid ? freightCents : 0)
    const canPost = Boolean(
      this.data.selectedClientId && rows.length > 0 &&
      rows.every(row => row.rowValid) && freightValid && !this.data.submitting
    )
    this.setData({
      rows,
      missingCount,
      attentionCount,
      itemsSubtotalText: formatCurrency(itemsSubtotalCents),
      freightText: formatCurrency(freightValid ? freightCents : 0),
      freightError: freightValid ? '' : '运费必须是大于等于0的合法金额，最多两位小数',
      totalText: formatCurrency(totalCents),
      canPost
    })
  },

  refreshProductOptions() {
    const productOptions = buildProductOptions(getRepository())
    this.setData({
      productOptions,
      standardProductOptions: productOptions.filter(option => option.isStandard),
      customProductOptions: productOptions.filter(option => !option.isStandard)
    })
    return productOptions
  },

  updateProductFilter(tab, search) {
    const source = tab === 'custom'
      ? this.data.customProductOptions
      : this.data.standardProductOptions
    const keyword = String(search || '').trim().toLowerCase()
    const filtered = source.filter(option =>
      !keyword || option.searchText.includes(keyword)
    ).slice(0, 80)
    this.setData({ selectorTab: tab, selectorSearch: search || '', filteredProductOptions: filtered })
  },

  openProductSelector(event) {
    const rowIndex = Number(event.currentTarget.dataset.index)
    const row = this.data.rows[rowIndex]
    if (!row) return
    const current = this.data.productOptions.find(option => option.id === row.productId)
    const tab = current && !current.isStandard ? 'custom' : 'standard'
    this.setData({
      selectorOpen: true,
      selectorRowIndex: rowIndex,
      selectorTab: tab,
      selectorSearch: '',
      showCustomForm: false,
      customForm: null
    }, () => this.updateProductFilter(tab, ''))
  },

  closeProductSelector() {
    this.setData({
      selectorOpen: false,
      selectorRowIndex: -1,
      selectorSearch: '',
      showCustomForm: false,
      customForm: null
    })
  },

  stopPropagation() {},

  onSelectorTabChange(event) {
    const tab = event.currentTarget.dataset.tab === 'custom' ? 'custom' : 'standard'
    this.updateProductFilter(tab, this.data.selectorSearch)
  },

  onProductSearchInput(event) {
    this.updateProductFilter(this.data.selectorTab, event.detail.value)
  },

  applyProductSelection(rowIndex, option, created) {
    if (!option || !this.data.rows[rowIndex]) return
    const rows = this.data.rows.slice()
    const price = getRepository().getCustomerPriceForProduct(
      getActiveTenantId(),
      this.data.selectedClientId,
      option.id
    )
    rows[rowIndex] = Object.assign({}, rows[rowIndex], {
      productId: option.id,
      productIndex: this.data.productOptions.findIndex(item => item.id === option.id),
      productLabel: option.label,
      needsProductConfirmation: false,
      canCreateCustomProduct: false,
      customProductDraft: null,
      height: option.height,
      width: option.width,
      toothType: option.toothType,
      color: option.color,
      productLengthMeters: option.unitLengthMeters || null,
      specialLengthText: option.unitLengthMeters ? `特殊长度 ${option.unitLengthMeters}米/根` : '',
      issues: rows[rowIndex].issues
        .filter(message => !/未找到|颜色|齿型|人工选择|请选择已有规格|创建并加入/.test(message))
        .concat(created ? '已经人工确认创建为自定义规格' : '已经人工改选产品'),
      conversionRateText: ''
    }, priceFields(price, rows[rowIndex].unit))
    this.recalculate(rows)
  },

  onProductChange(event) {
    const rowIndex = Number(event.currentTarget.dataset.index)
    const productIndex = Number(event.detail.value)
    const option = this.data.productOptions[productIndex]
    this.applyProductSelection(rowIndex, option, false)
  },

  selectProduct(event) {
    const option = this.data.productOptions.find(item => item.id === event.currentTarget.dataset.productId)
    if (!option) return
    this.applyProductSelection(this.data.selectorRowIndex, option, false)
    this.closeProductSelector()
  },

  openCustomProductForm(event) {
    const eventIndex = event && event.currentTarget && event.currentTarget.dataset.index
    const rowIndex = eventIndex !== undefined ? Number(eventIndex) : this.data.selectorRowIndex
    const row = this.data.rows[rowIndex]
    if (!row) return
    const draft = row.customProductDraft || {}
    const name = draft.name || row.productLabel || ''
    const color = draft.color || row.color || ''
    const toothType = draft.toothType || row.toothType || ''
    const unitLengthMeters = draft.unitLengthMeters || row.productLengthMeters || ''
    const aliases = Array.from(new Set([draft.name].concat(draft.aliases || []).filter(Boolean))).join('；')
    this.setData({
      selectorOpen: true,
      selectorRowIndex: rowIndex,
      showCustomForm: true,
      customForm: {
        name,
        height: draft.height != null ? draft.height : row.height,
        width: draft.width != null ? draft.width : row.width,
        baseSpecText: (draft.height || row.height) && (draft.width || row.width)
          ? `${draft.height || row.height}×${draft.width || row.width}`
          : '未识别，可在名称中自由描述',
        color,
        colorIndex: Math.max(0, COLOR_OPTIONS.indexOf(color)),
        toothType,
        toothIndex: Math.max(0, TOOTH_OPTIONS.indexOf(toothType)),
        unitLengthText: unitLengthMeters ? String(unitLengthMeters) : '',
        aliasesText: aliases,
        specialTags: draft.specialTags || [],
        recognitionKeywords: draft.recognitionKeywords || []
      }
    })
  },

  createCustomProduct(event) {
    this.openCustomProductForm(event)
  },

  onCustomFormInput(event) {
    if (!this.data.customForm) return
    const field = event.currentTarget.dataset.field
    const customForm = Object.assign({}, this.data.customForm, { [field]: event.detail.value })
    this.setData({ customForm })
  },

  onCustomColorChange(event) {
    const colorIndex = Number(event.detail.value)
    const color = COLOR_OPTIONS[colorIndex] === '未设置' ? '' : COLOR_OPTIONS[colorIndex]
    this.setData({ customForm: Object.assign({}, this.data.customForm, { colorIndex, color }) })
  },

  onCustomToothChange(event) {
    const toothIndex = Number(event.detail.value)
    const toothType = TOOTH_OPTIONS[toothIndex] === '未设置' ? '' : TOOTH_OPTIONS[toothIndex]
    this.setData({ customForm: Object.assign({}, this.data.customForm, { toothIndex, toothType }) })
  },

  saveCustomProduct() {
    const form = this.data.customForm
    const rowIndex = this.data.selectorRowIndex
    if (!form || !String(form.name || '').trim()) {
      wx.showToast({ title: '请填写产品名称', icon: 'none' })
      return
    }
    try {
      const repository = getRepository()
      const unitLengthMeters = Number(form.unitLengthText)
      const result = repository.createCustomProduct(getActiveTenantId(), {
        confirmed: true,
        name: String(form.name).trim(),
        aliases: splitAliases(form.aliasesText),
        recognitionKeywords: form.recognitionKeywords || [],
        height: form.height,
        width: form.width,
        toothType: form.toothType || null,
        color: form.color || null,
        unitLengthMeters: unitLengthMeters > 0 ? unitLengthMeters : null,
        lengthDescription: unitLengthMeters > 0 ? `${unitLengthMeters}米/根` : '',
        specialTags: form.specialTags || [],
        note: ''
      })
      if (result && typeof result.then === 'function') {
        wx.showLoading({ title: '保存中' })
        result.then(product => {
          wx.hideLoading()
          this.finishCustomProductSave(rowIndex, product)
        }).catch(error => {
          wx.hideLoading()
          if (handleAccessError(error)) return
          wx.showModal({ title: '未能创建产品', content: error.message, showCancel: false })
        })
        return
      }
      this.finishCustomProductSave(rowIndex, result)
    } catch (error) {
      wx.showModal({ title: '未能创建产品', content: error.message, showCancel: false })
    }
  },

  finishCustomProductSave(rowIndex, product) {
    const productOptions = this.refreshProductOptions()
    const option = productOptions.find(item => item.id === product.id)
    this.applyProductSelection(rowIndex, option, true)
    this.closeProductSelector()
  },

  onQuantityInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const rows = this.data.rows.slice()
    rows[index] = Object.assign({}, rows[index], { quantityText: event.detail.value })
    this.recalculate(rows)
  },

  onUnitChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const unitIndex = Number(event.detail.value)
    const rows = this.data.rows.slice()
    const current = rows[index]
    const unit = UNIT_OPTIONS[unitIndex]
    const savedPrice = current.productId
      ? getRepository().getCustomerPriceForProduct(
        getActiveTenantId(),
        this.data.selectedClientId,
        current.productId
      )
      : null
    const next = Object.assign({}, current, { unitIndex, unit, conversionRateText: '' })
    rows[index] = savedPrice
      ? Object.assign(next, priceFields(savedPrice, unit))
      : Object.assign(next, {
        pricingUnit: unit,
        pricingUnitIndex: unitIndex,
        priceStateText: `该客户尚未设置此产品价格，已按本次数量单位预选“${unit}”`
      })
    this.recalculate(rows)
  },

  onPricingUnitChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const pricingUnitIndex = Number(event.detail.value)
    const pricingUnit = UNIT_OPTIONS[pricingUnitIndex]
    const rows = this.data.rows.slice()
    const row = rows[index]
    const savedPrice = row.productId
      ? getRepository().getCustomerPrice(
        getActiveTenantId(),
        this.data.selectedClientId,
        row.productId,
        pricingUnit
      )
      : null
    rows[index] = Object.assign({}, row, {
      pricingUnitIndex,
      pricingUnit,
      conversionRateText: '',
      unitPriceYuan: savedPrice ? centsToYuan(savedPrice.unitPriceCents) : '',
      saveAsDefault: savedPrice ? false : row.savedPriceCents === null,
      priceStateText: savedPrice
        ? `客户保存价 ${formatCurrency(savedPrice.unitPriceCents)}/${savedPrice.unit}`
        : `本次改为按“${pricingUnit}”计价，请人工填写单价`,
      priceStateClass: savedPrice ? 'success-text' : 'warning-text'
    })
    this.recalculate(rows)
  },

  onConversionInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const rows = this.data.rows.slice()
    rows[index] = Object.assign({}, rows[index], { conversionRateText: event.detail.value })
    this.recalculate(rows)
  },

  confirmSuggestedConversion(event) {
    const index = Number(event.currentTarget.dataset.index)
    const rows = this.data.rows.slice()
    const row = rows[index]
    if (!row || !row.suggestedConversionRate) return
    rows[index] = Object.assign({}, row, { conversionRateText: row.suggestedConversionRate })
    this.recalculate(rows)
  },

  onPriceInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const rows = this.data.rows.slice()
    rows[index] = Object.assign({}, rows[index], { unitPriceYuan: event.detail.value })
    this.recalculate(rows)
  },

  onSaveDefaultChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const rows = this.data.rows.slice()
    rows[index] = Object.assign({}, rows[index], { saveAsDefault: event.detail.value })
    this.setData({ rows })
  },

  removeRow(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.recalculate(this.data.rows.filter((row, rowIndex) => rowIndex !== index))
  },

  confirmPost() {
    if (!this.data.canPost || this.data.submitting) return
    if (this.data.editing && String(this.data.editReason || '').trim().length < 2) {
      wx.showToast({ title: '请填写修正原因', icon: 'none' })
      return
    }
    const client = this.data.clients[this.data.selectedClientIndex]
    wx.showModal({
      title: this.data.editing ? '确认修正账目' : '确认正式入账',
      content: `${client.name}\n${this.data.rows.length}项商品\n商品合计 ${this.data.itemsSubtotalText}\n运费 ${this.data.freightText}\n本次合计 ${this.data.totalText}\n\n${this.data.editing ? '原记录和修正原因将保留在审计记录中。' : '确认后将加入该客户本期账款。'}`,
      confirmText: this.data.editing ? '确认修正' : '确认入账',
      confirmColor: '#123B67',
      success: result => {
        if (result.confirm) this.postShipment()
      }
    })
  },

  postShipment() {
    this.setData({ submitting: true, canPost: false })
    try {
      const payload = {
        requestId: `request_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        confirmed: true,
        reason: this.data.editReason,
        clientId: this.data.selectedClientId,
        shipmentDate: this.data.shipmentDate,
        sourceText: this.data.orderText,
        logistics: this.data.parsedLogistics,
        freightYuan: String(this.data.freightYuan || '').trim() || '0',
        items: this.data.rows.map(row => ({
          productId: row.productId,
          sourceText: row.sourceText,
          quantityText: row.quantityText,
          orderUnit: row.unit,
          pricingUnit: row.pricingUnit,
          conversionRateText: row.conversionRateText,
          unitPriceYuan: row.unitPriceYuan,
          saveAsDefault: row.saveAsDefault
        }))
      }
      const result = this.data.editing
        ? getRepository().updateShipment(getActiveTenantId(), this.loadOptions.shipmentId, payload)
        : getRepository().postShipment(getActiveTenantId(), payload)
      if (result && typeof result.then === 'function') {
        result.then(shipment => this.handlePostSuccess(shipment)).catch(error => this.handlePostError(error))
        return
      }
      this.handlePostSuccess(result)
    } catch (error) {
      this.handlePostError(error)
    }
  },

  handlePostSuccess(shipment) {
      wx.showModal({
        title: this.data.editing ? '修正成功' : '入账成功',
        content: `${this.data.editing ? '本笔账目已修正为' : '本次已入账'} ${formatCurrency(shipment.totalAmountCents)}。客户本期应收已自动更新。`,
        showCancel: false,
        success: () => wx.navigateBack()
      })
  },

  handlePostError(error) {
    this.setData({ submitting: false })
    this.recalculate(this.data.rows)
    if (handleAccessError(error)) return
    wx.showModal({ title: '未能入账', content: error.message || '请检查商品、数量和单价后重试', showCancel: false })
  }
})
