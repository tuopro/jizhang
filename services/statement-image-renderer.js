const { PAGE_LAYOUT } = require('./statement-paginator')

const COLORS = Object.freeze({
  text: '#17212B',
  secondary: '#4B5966',
  muted: '#6E7C89',
  border: '#AEB8C2',
  divider: '#D7DDE3',
  headerFill: '#EEF2F5',
  softFill: '#F7F9FB',
  primary: '#123B67',
  success: '#16794B',
  danger: '#B42318',
  white: '#FFFFFF'
})

const SHIPMENT_COLUMNS = [
  { key: 'date', label: '日期', width: 132, align: 'left' },
  { key: 'product', label: '产品 / 规格', width: 430, align: 'left' },
  { key: 'quantity', label: '数量', width: 128, align: 'right' },
  { key: 'unit', label: '单位', width: 80, align: 'center' },
  { key: 'price', label: '单价', width: 170, align: 'right' },
  { key: 'amount', label: '商品金额', width: 190, align: 'right' }
]

const PAYMENT_COLUMNS = [
  { key: 'date', label: '收款日期', width: 172, align: 'left' },
  { key: 'method', label: '方式', width: 150, align: 'left' },
  { key: 'amount', label: '收款金额', width: 214, align: 'right' },
  { key: 'note', label: '备注 / 操作人', width: 594, align: 'left' }
]

function setFont(context, size, weight) {
  context.font = `${weight || '400'} ${size}px sans-serif`
  context.textBaseline = 'alphabetic'
}

function drawLine(context, x1, y1, x2, y2, color, width) {
  context.beginPath()
  context.strokeStyle = color || COLORS.border
  context.lineWidth = width || 1
  context.moveTo(x1, Math.round(y1) + 0.5)
  context.lineTo(x2, Math.round(y2) + 0.5)
  context.stroke()
}

function drawText(context, value, x, y, options) {
  const settings = options || {}
  setFont(context, settings.size || 28, settings.weight || '400')
  context.fillStyle = settings.color || COLORS.text
  context.textAlign = settings.align || 'left'
  context.fillText(String(value == null ? '' : value), x, y)
}

function drawTextLines(context, lines, x, top, options) {
  const settings = options || {}
  const lineHeight = settings.lineHeight || 36
  ;(lines || []).forEach((line, index) => {
    drawText(context, line, x, top + lineHeight * (index + 1) - (lineHeight - (settings.size || 28)) / 2, settings)
  })
}

function formatMoney(cents) {
  const value = Number(cents || 0) / 100
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatQuantity(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value == null ? '' : value)
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(3)))
}

function columnPositions(columns) {
  let x = PAGE_LAYOUT.marginX
  return columns.map(column => {
    const item = Object.assign({}, column, { left: x, right: x + column.width })
    x += column.width
    return item
  })
}

function drawGridHeader(context, y, columns) {
  const positions = columnPositions(columns)
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  context.fillStyle = COLORS.headerFill
  context.fillRect(left, y, right - left, PAGE_LAYOUT.tableHeaderHeight)
  drawLine(context, left, y, right, y, COLORS.border, 2)
  drawLine(context, left, y + PAGE_LAYOUT.tableHeaderHeight, right, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 2)
  positions.forEach((column, index) => {
    if (index) drawLine(context, column.left, y, column.left, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 1)
    const textX = column.align === 'right' ? column.right - 14 : column.align === 'center' ? (column.left + column.right) / 2 : column.left + 14
    drawText(context, column.label, textX, y + 45, {
      size: 27, weight: '600', color: COLORS.text, align: column.align
    })
  })
  drawLine(context, left, y, left, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 1)
  drawLine(context, right, y, right, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 1)
}

function drawDocumentHeader(context, document, page) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  let y = PAGE_LAYOUT.headerTop
  drawText(context, '客户对账单', left, y + 40, { size: 46, weight: '700', color: COLORS.primary })
  drawText(context, document.header.statusText, right, y + 38, {
    size: 28, weight: '600', color: document.header.status === 'closed' ? COLORS.success : COLORS.secondary, align: 'right'
  })
  y += 52
  drawTextLines(context, page.headerLayout.enterpriseLines, left, y, {
    size: 34, weight: '600', lineHeight: 44, color: COLORS.text
  })
  y += page.headerLayout.enterpriseLines.length * 44
  drawTextLines(context, page.headerLayout.customerLines, left, y, {
    size: 31, weight: '600', lineHeight: 40, color: COLORS.text
  })
  y += page.headerLayout.customerLines.length * 40
  drawText(context, `${document.header.periodTitle}　${document.header.startDate || '—'} 至 ${document.header.endDate || '—'}`, left, y + 32, {
    size: 27, color: COLORS.secondary
  })
  drawText(context, document.header.endDateLabel, right, y + 32, { size: 25, color: COLORS.muted, align: 'right' })
  drawLine(context, left, y + 54, right, y + 54, COLORS.primary, 3)
}

function drawShipmentTableHeader(context, y) {
  drawGridHeader(context, y, SHIPMENT_COLUMNS)
}

function drawPaymentTableHeader(context, y) {
  drawGridHeader(context, y, PAYMENT_COLUMNS)
}

function drawSummaryTableHeader(context, y) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  context.fillStyle = COLORS.headerFill
  context.fillRect(left, y, right - left, PAGE_LAYOUT.tableHeaderHeight)
  drawLine(context, left, y, right, y, COLORS.border, 2)
  drawLine(context, left, y + PAGE_LAYOUT.tableHeaderHeight, right, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 2)
  drawLine(context, left, y, left, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 1)
  drawLine(context, right, y, right, y + PAGE_LAYOUT.tableHeaderHeight, COLORS.border, 1)
  drawText(context, '账单总汇总', left + 14, y + 45, { size: 28, weight: '600' })
}

function drawVerticalGrid(context, positions, top, bottom) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  drawLine(context, left, top, left, bottom, COLORS.divider, 1)
  positions.slice(1).forEach(column => drawLine(context, column.left, top, column.left, bottom, COLORS.divider, 1))
  drawLine(context, right, top, right, bottom, COLORS.divider, 1)
}

function drawShipmentRow(context, layout, shipment, rowIndex, segment, y) {
  const columns = columnPositions(SHIPMENT_COLUMNS)
  const line = layout.line
  const bottom = y + layout.height
  drawVerticalGrid(context, columns, y, bottom)
  drawLine(context, PAGE_LAYOUT.marginX, bottom, PAGE_LAYOUT.width - PAGE_LAYOUT.marginX, bottom, COLORS.divider, 1)
  if (rowIndex === 0) {
    const suffix = segment.continuedFromPrevious ? '（续）' : ''
    drawText(context, `${shipment.shipmentDate || '—'}${suffix}`, columns[0].left + 12, y + 34, { size: 25, weight: '600' })
    const shortId = shipment.id ? shipment.id.slice(-8) : ''
    if (shortId) drawText(context, `#${shortId}`, columns[0].left + 12, y + 66, { size: 22, color: COLORS.muted })
  }
  drawTextLines(context, layout.productLines, columns[1].left + 12, y + 10, {
    size: 29, lineHeight: PAGE_LAYOUT.productLineHeight, color: COLORS.text
  })
  drawText(context, formatQuantity(line.originalQuantity), columns[2].right - 12, y + 48, { size: 27, align: 'right' })
  drawText(context, line.originalUnit || '—', (columns[3].left + columns[3].right) / 2, y + 48, { size: 27, align: 'center' })
  drawText(context, formatMoney(line.unitPriceCents), columns[4].right - 12, y + 48, { size: 27, align: 'right' })
  drawText(context, formatMoney(line.lineAmountCents), columns[5].right - 12, y + 48, { size: 27, weight: '600', align: 'right' })
}

function drawShipmentSummary(context, shipment, summary, y) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  const labelX = right - 390
  const valueX = right - 14
  const bottom = y + summary.height
  context.fillStyle = COLORS.softFill
  context.fillRect(left, y, right - left, summary.height)
  drawLine(context, left, y, right, y, COLORS.border, 1)
  drawText(context, '商品小计', labelX, y + 34, { size: 25, color: COLORS.secondary })
  drawText(context, formatMoney(shipment.itemsSubtotalCents), valueX, y + 34, { size: 25, align: 'right' })
  drawText(context, '运费', labelX, y + 68, { size: 25, color: COLORS.secondary })
  drawText(context, formatMoney(shipment.freightCents), valueX, y + 68, { size: 25, align: 'right' })
  drawText(context, '本次合计', labelX, y + 105, { size: 27, weight: '700' })
  drawText(context, formatMoney(shipment.totalAmountCents), valueX, y + 105, { size: 27, weight: '700', align: 'right' })
  if (summary.detailLines.length) {
    drawTextLines(context, summary.detailLines, left + 14, y + 122, { size: 25, lineHeight: 34, color: COLORS.muted })
  }
  drawLine(context, left, bottom, right, bottom, COLORS.border, 1)
}

function drawShipmentSegment(context, block, y) {
  let cursor = y
  block.lineLayouts.forEach((layout, index) => {
    drawShipmentRow(context, layout, block.shipment, index, block, cursor)
    cursor += layout.height
  })
  if (block.continuesNext) {
    const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
    drawText(context, '本次发货未完，续下页', right - 12, cursor + 31, { size: 24, color: COLORS.muted, align: 'right' })
    cursor += 46
  }
  if (block.showSummary) {
    drawShipmentSummary(context, block.shipment, block.summary, cursor)
  }
}

function drawPaymentRow(context, block, y) {
  const columns = columnPositions(PAYMENT_COLUMNS)
  const bottom = y + block.height
  drawVerticalGrid(context, columns, y, bottom)
  drawLine(context, PAGE_LAYOUT.marginX, bottom, PAGE_LAYOUT.width - PAGE_LAYOUT.marginX, bottom, COLORS.divider, 1)
  drawText(context, block.payment.paymentDate || '—', columns[0].left + 12, y + 48, { size: 27 })
  drawText(context, block.payment.method || '其他', columns[1].left + 12, y + 48, { size: 27 })
  drawText(context, formatMoney(block.payment.amountCents), columns[2].right - 12, y + 48, { size: 28, weight: '600', align: 'right' })
  drawTextLines(context, block.noteLines, columns[3].left + 12, y + 8, {
    size: PAGE_LAYOUT.paymentFontSize,
    lineHeight: PAGE_LAYOUT.paymentLineHeight,
    color: COLORS.secondary
  })
}

function drawEmptyRow(context, y, label, height) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  drawLine(context, left, y, left, y + height, COLORS.divider, 1)
  drawLine(context, right, y, right, y + height, COLORS.divider, 1)
  drawLine(context, left, y + height, right, y + height, COLORS.divider, 1)
  drawText(context, label, (left + right) / 2, y + 56, { size: 27, color: COLORS.muted, align: 'center' })
}

function drawPaymentSectionTitle(context, y) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  drawLine(context, left, y + PAGE_LAYOUT.sectionTitleHeight - 1, right, y + PAGE_LAYOUT.sectionTitleHeight - 1, COLORS.primary, 2)
  drawText(context, '收款记录', left, y + 39, { size: 29, weight: '700' })
}

function drawGrandSummary(context, totals, y, height) {
  const left = PAGE_LAYOUT.marginX
  const right = PAGE_LAYOUT.width - PAGE_LAYOUT.marginX
  const rows = [
    ['商品总额', totals.itemsSubtotalCents, COLORS.text],
    ['运费总额', totals.freightCents, COLORS.text],
    ['应收总额', totals.shipmentTotalCents, COLORS.text],
    ['已收金额', totals.receivedCents, COLORS.success],
    ['剩余应收', totals.outstandingCents, COLORS.danger]
  ]
  const rowHeight = height / rows.length
  context.fillStyle = COLORS.softFill
  context.fillRect(left, y, right - left, height)
  rows.forEach((row, index) => {
    const top = y + index * rowHeight
    drawLine(context, left, top, right, top, index === 0 ? COLORS.primary : COLORS.divider, index === 0 ? 2 : 1)
    drawText(context, row[0], left + 18, top + rowHeight * 0.66, {
      size: index === rows.length - 1 ? 31 : 27,
      weight: index === rows.length - 1 ? '700' : '500'
    })
    drawText(context, formatMoney(row[1]), right - 18, top + rowHeight * 0.66, {
      size: index === rows.length - 1 ? 33 : 29,
      weight: index === rows.length - 1 ? '700' : '600',
      color: row[2],
      align: 'right'
    })
  })
  drawLine(context, left, y + height, right, y + height, COLORS.border, 1)
  drawLine(context, left, y, left, y + height, COLORS.border, 1)
  drawLine(context, right, y, right, y + height, COLORS.border, 1)
}

function drawFooter(context, page) {
  const y = PAGE_LAYOUT.height - PAGE_LAYOUT.bottomMargin - 12
  drawText(context, `第 ${page.pageNumber} / ${page.totalPages} 页`, PAGE_LAYOUT.width / 2, y, {
    size: 25, color: COLORS.muted, align: 'center'
  })
}

function renderStatementPage(context, document, page) {
  context.save()
  context.clearRect(0, 0, PAGE_LAYOUT.width, PAGE_LAYOUT.height)
  context.fillStyle = COLORS.white
  context.fillRect(0, 0, PAGE_LAYOUT.width, PAGE_LAYOUT.height)
  drawDocumentHeader(context, document, page)
  let y = page.contentTop
  page.blocks.forEach(block => {
    if (block.type === 'shipment-table-header') drawShipmentTableHeader(context, y)
    if (block.type === 'payment-table-header') drawPaymentTableHeader(context, y)
    if (block.type === 'summary-table-header') drawSummaryTableHeader(context, y)
    if (block.type === 'shipment-segment') drawShipmentSegment(context, block, y)
    if (block.type === 'payment-row') drawPaymentRow(context, block, y)
    if (block.type === 'empty-shipments') drawEmptyRow(context, y, '本账期暂无发货记录', block.height)
    if (block.type === 'payment-section-title') drawPaymentSectionTitle(context, y)
    if (block.type === 'empty-payments') drawEmptyRow(context, y, '本账期暂无收款记录', block.height)
    if (block.type === 'grand-summary') drawGrandSummary(context, block.totals, y, block.height)
    y += block.height
  })
  drawFooter(context, page)
  context.restore()
  return { bottom: y, contentBottom: page.contentBottom }
}

module.exports = {
  COLORS,
  SHIPMENT_COLUMNS,
  PAYMENT_COLUMNS,
  formatMoney,
  formatQuantity,
  renderStatementPage
}
