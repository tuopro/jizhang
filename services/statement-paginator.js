const PAGE_LAYOUT = Object.freeze({
  width: 1242,
  height: 1756,
  marginX: 56,
  headerTop: 48,
  footerHeight: 56,
  bottomMargin: 28,
  tableHeaderHeight: 70,
  sectionTitleHeight: 58,
  shipmentRowMinHeight: 82,
  shipmentRowPaddingY: 20,
  productFontSize: 29,
  productLineHeight: 38,
  productColumnWidth: 420,
  shipmentSummaryBaseHeight: 126,
  paymentRowMinHeight: 82,
  paymentRowPaddingY: 18,
  paymentFontSize: 28,
  paymentLineHeight: 36,
  paymentNoteWidth: 360,
  grandSummaryHeight: 304,
  emptyRowHeight: 92
})

const MAX_IMAGE_ROWS = 800
const MAX_IMAGE_PAGES = 80

function text(value) {
  return String(value == null ? '' : value)
}

function defaultMeasureText(value, fontSize) {
  return Array.from(text(value)).reduce((width, character) =>
    width + (/^[\u0000-\u00ff]$/.test(character) ? fontSize * 0.56 : fontSize), 0)
}

function wrapText(value, maxWidth, measureText, fontSize, fontWeight) {
  const content = text(value) || '—'
  const measure = measureText || defaultMeasureText
  const paragraphs = content.split(/\r?\n/)
  const lines = []
  paragraphs.forEach(paragraph => {
    const characters = Array.from(paragraph || ' ')
    let current = ''
    characters.forEach(character => {
      const candidate = current + character
      if (current && measure(candidate, fontSize, fontWeight) > maxWidth) {
        lines.push(current)
        current = character
      } else {
        current = candidate
      }
    })
    lines.push(current || ' ')
  })
  return lines
}

function measureHeader(document, measureText) {
  const enterpriseLines = wrapText(document.header.enterpriseName, PAGE_LAYOUT.width - PAGE_LAYOUT.marginX * 2, measureText, 34, '600')
  const customerLines = wrapText(`客户：${document.header.customerName}`, 700, measureText, 31, '600')
  if (enterpriseLines.length > 2 || customerLines.length > 2) {
    const error = new Error('企业或客户名称过长，无法安全生成账单图片，请使用 Excel 导出')
    error.code = 'IMAGE_HEADER_TOO_LONG'
    throw error
  }
  const height = 52 + enterpriseLines.length * 44 + customerLines.length * 40 + 82
  return { enterpriseLines, customerLines, height }
}

function productText(line) {
  const snapshot = line.productSnapshot || {}
  return snapshot.label || snapshot.name || '未命名产品'
}

function measureShipmentLine(line, measureText) {
  const productLines = wrapText(
    productText(line),
    PAGE_LAYOUT.productColumnWidth - 24,
    measureText,
    PAGE_LAYOUT.productFontSize,
    '400'
  )
  const height = Math.max(
    PAGE_LAYOUT.shipmentRowMinHeight,
    productLines.length * PAGE_LAYOUT.productLineHeight + PAGE_LAYOUT.shipmentRowPaddingY * 2
  )
  return { line, productLines, height }
}

function shipmentExtraText(shipment) {
  const parts = []
  const logistics = shipment.logistics || {}
  if (logistics.provider || logistics.raw) parts.push(`物流：${logistics.raw || logistics.provider}`)
  if (shipment.note) parts.push(`备注：${shipment.note}`)
  return parts.join('　')
}

function measureShipmentSummary(shipment, measureText) {
  const detail = shipmentExtraText(shipment)
  const detailLines = detail
    ? wrapText(detail, PAGE_LAYOUT.width - PAGE_LAYOUT.marginX * 2 - 28, measureText, 25, '400')
    : []
  return {
    detailLines,
    height: PAGE_LAYOUT.shipmentSummaryBaseHeight + detailLines.length * 34
  }
}

function measurePayment(payment, measureText) {
  const noteText = [payment.note, payment.createdByNameSnapshot ? `操作人：${payment.createdByNameSnapshot}` : '']
    .filter(Boolean).join('　') || '—'
  const noteLines = wrapText(
    noteText,
    PAGE_LAYOUT.paymentNoteWidth,
    measureText,
    PAGE_LAYOUT.paymentFontSize,
    '400'
  )
  const height = Math.max(
    PAGE_LAYOUT.paymentRowMinHeight,
    noteLines.length * PAGE_LAYOUT.paymentLineHeight + PAGE_LAYOUT.paymentRowPaddingY * 2
  )
  return { payment, noteLines, height }
}

function createPage(tableType, headerLayout) {
  const contentTop = PAGE_LAYOUT.headerTop + headerLayout.height
  const contentBottom = PAGE_LAYOUT.height - PAGE_LAYOUT.bottomMargin - PAGE_LAYOUT.footerHeight
  const firstBlock = tableType === 'payments'
    ? { type: 'payment-table-header', height: PAGE_LAYOUT.tableHeaderHeight }
    : tableType === 'summary'
      ? { type: 'summary-table-header', height: PAGE_LAYOUT.tableHeaderHeight }
      : { type: 'shipment-table-header', height: PAGE_LAYOUT.tableHeaderHeight }
  return {
    tableType,
    contentTop,
    contentBottom,
    cursorY: contentTop + firstBlock.height,
    blocks: [firstBlock]
  }
}

function remaining(page) {
  return page.contentBottom - page.cursorY
}

function addBlock(page, block) {
  page.blocks.push(block)
  page.cursorY += block.height
}

function formatSegment(shipment, lineLayouts, options) {
  const settings = options || {}
  const summary = settings.showSummary ? settings.summary : null
  return {
    type: 'shipment-segment',
    shipment,
    lineLayouts,
    continuedFromPrevious: Boolean(settings.continuedFromPrevious),
    continuesNext: Boolean(settings.continuesNext),
    showSummary: Boolean(settings.showSummary),
    summary,
    height: lineLayouts.reduce((sum, item) => sum + item.height, 0) +
      (summary ? summary.height : 0) + (settings.continuesNext ? 46 : 0)
  }
}

function paginateShipment(pages, shipment, headerLayout, measureText) {
  const lineLayouts = (shipment.lines || []).map(line => measureShipmentLine(line, measureText))
  const summary = measureShipmentSummary(shipment, measureText)
  const tableCapacity = createPage('shipments', headerLayout)
  const maximumBodyHeight = remaining(tableCapacity)
  lineLayouts.forEach(layout => {
    if (layout.height > maximumBodyHeight) {
      const error = new Error(`产品名称“${productText(layout.line).slice(0, 24)}”过长，无法安全生成图片，请使用 Excel 导出`)
      error.code = 'IMAGE_ROW_TOO_TALL'
      throw error
    }
  })
  const totalHeight = lineLayouts.reduce((sum, item) => sum + item.height, 0) + summary.height
  let page = pages[pages.length - 1]
  if (!page || page.tableType !== 'shipments') {
    page = createPage('shipments', headerLayout)
    pages.push(page)
  }
  if (totalHeight <= remaining(page)) {
    addBlock(page, formatSegment(shipment, lineLayouts, { showSummary: true, summary }))
    return
  }
  if (totalHeight <= maximumBodyHeight && page.blocks.length > 1) {
    page = createPage('shipments', headerLayout)
    pages.push(page)
    addBlock(page, formatSegment(shipment, lineLayouts, { showSummary: true, summary }))
    return
  }

  let offset = 0
  let continued = false
  while (offset < lineLayouts.length) {
    page = pages[pages.length - 1]
    if (!page || page.tableType !== 'shipments' || remaining(page) < PAGE_LAYOUT.shipmentRowMinHeight) {
      page = createPage('shipments', headerLayout)
      pages.push(page)
    }
    const available = remaining(page)
    let used = 0
    let count = 0
    while (offset + count < lineLayouts.length) {
      const next = lineLayouts[offset + count]
      const isLastLine = offset + count === lineLayouts.length - 1
      const required = next.height + (isLastLine ? summary.height : 46)
      if (used + required > available) break
      used += next.height
      count += 1
      if (isLastLine) break
    }
    if (!count) {
      if (page.blocks.length > 1) {
        pages.push(createPage('shipments', headerLayout))
        continue
      }
      const next = lineLayouts[offset]
      if (next.height + (offset === lineLayouts.length - 1 ? summary.height : 46) > available && offset === lineLayouts.length - 1) {
        const error = new Error('单笔发货末行与小计无法安全排入一页，请使用 Excel 导出')
        error.code = 'IMAGE_SHIPMENT_TOO_TALL'
        throw error
      }
      count = 1
    }
    const isFinal = offset + count >= lineLayouts.length
    const block = formatSegment(shipment, lineLayouts.slice(offset, offset + count), {
      continuedFromPrevious: continued,
      continuesNext: !isFinal,
      showSummary: isFinal,
      summary
    })
    if (block.height > remaining(page)) {
      pages.push(createPage('shipments', headerLayout))
      continue
    }
    addBlock(page, block)
    offset += count
    continued = true
    if (!isFinal) pages.push(createPage('shipments', headerLayout))
  }
}

function appendNoPaymentAndSummary(pages, headerLayout, document) {
  let page = pages[pages.length - 1]
  const required = PAGE_LAYOUT.sectionTitleHeight + PAGE_LAYOUT.emptyRowHeight + PAGE_LAYOUT.grandSummaryHeight
  if (!page || remaining(page) < required) {
    page = createPage('summary', headerLayout)
    pages.push(page)
    addBlock(page, { type: 'empty-payments', height: PAGE_LAYOUT.emptyRowHeight })
  } else {
    addBlock(page, { type: 'payment-section-title', height: PAGE_LAYOUT.sectionTitleHeight })
    addBlock(page, { type: 'empty-payments', height: PAGE_LAYOUT.emptyRowHeight })
  }
  addBlock(page, { type: 'grand-summary', totals: document.totals, height: PAGE_LAYOUT.grandSummaryHeight })
}

function paginatePayments(pages, document, headerLayout, measureText) {
  const payments = document.payments || []
  if (!payments.length) {
    appendNoPaymentAndSummary(pages, headerLayout, document)
    return
  }
  let page = createPage('payments', headerLayout)
  pages.push(page)
  payments.map(payment => measurePayment(payment, measureText)).forEach(layout => {
    const maximum = createPage('payments', headerLayout)
    if (layout.height > remaining(maximum)) {
      const error = new Error('收款备注过长，无法安全生成图片，请使用 Excel 导出')
      error.code = 'IMAGE_PAYMENT_TOO_TALL'
      throw error
    }
    if (layout.height > remaining(page)) {
      page = createPage('payments', headerLayout)
      pages.push(page)
    }
    addBlock(page, { type: 'payment-row', payment: layout.payment, noteLines: layout.noteLines, height: layout.height })
  })
  if (remaining(page) < PAGE_LAYOUT.grandSummaryHeight) {
    page = createPage('summary', headerLayout)
    pages.push(page)
  }
  addBlock(page, { type: 'grand-summary', totals: document.totals, height: PAGE_LAYOUT.grandSummaryHeight })
}

function paginateStatement(document, options) {
  if (!document || !document.header || !document.totals) throw new Error('缺少账单导出数据')
  const settings = options || {}
  const measureText = settings.measureText || defaultMeasureText
  const rowCount = (document.counts && document.counts.shipmentLines || 0) +
    (document.counts && document.counts.payments || 0)
  if (rowCount > (settings.maxRows || MAX_IMAGE_ROWS)) {
    const error = new Error('账单明细过多，不适合生成微信图片，请导出 Excel')
    error.code = 'IMAGE_EXPORT_TOO_LARGE'
    throw error
  }
  const headerLayout = measureHeader(document, measureText)
  const pages = []
  if ((document.shipments || []).length) {
    document.shipments.forEach(shipment => paginateShipment(pages, shipment, headerLayout, measureText))
  } else {
    const page = createPage('shipments', headerLayout)
    pages.push(page)
    addBlock(page, { type: 'empty-shipments', height: PAGE_LAYOUT.emptyRowHeight })
  }
  paginatePayments(pages, document, headerLayout, measureText)
  if (pages.length > (settings.maxPages || MAX_IMAGE_PAGES)) {
    const error = new Error('账单分页过多，不适合生成微信图片，请导出 Excel')
    error.code = 'IMAGE_EXPORT_TOO_LARGE'
    throw error
  }
  pages.forEach((page, index) => {
    page.pageNumber = index + 1
    page.totalPages = pages.length
    page.headerLayout = headerLayout
    delete page.cursorY
  })
  return pages
}

module.exports = {
  PAGE_LAYOUT,
  MAX_IMAGE_ROWS,
  MAX_IMAGE_PAGES,
  defaultMeasureText,
  wrapText,
  measureShipmentLine,
  measurePayment,
  paginateStatement
}
