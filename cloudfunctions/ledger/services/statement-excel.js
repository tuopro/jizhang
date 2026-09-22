const ExcelJS = require('exceljs')

const MONEY_FORMAT = '¥#,##0.00;[Red]-¥#,##0.00'
const DATE_FORMAT = 'yyyy-mm-dd'
const HEADER_FILL = 'FFEAF1F7'
const PRIMARY_COLOR = 'FF173F67'
const BODY_TEXT_COLOR = 'FF1F2937'
const BORDER_COLOR = 'FFD1D5DB'
const WHITE_COLOR = 'FFFFFFFF'
const OUTSTANDING_COLOR = 'FF8A3F3B'

function asMoney(cents) {
  return Number(cents || 0) / 100
}

function asDate(value) {
  const text = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return new Date(`${text}T12:00:00.000Z`)
}

function productName(line) {
  const snapshot = line && line.productSnapshot || {}
  return snapshot.name || snapshot.label || ''
}

function productSpecification(line) {
  const snapshot = line && line.productSnapshot || {}
  const values = []
  if (snapshot.height && snapshot.width) values.push(`${snapshot.height}×${snapshot.width}mm`)
  else if (snapshot.productType === 'cover' && snapshot.width) values.push(`${snapshot.width}mm盖子`)
  if (snapshot.lengthDescription) values.push(snapshot.lengthDescription)
  if (Array.isArray(snapshot.specialTags)) values.push(...snapshot.specialTags.filter(Boolean))
  return Array.from(new Set(values)).join(' / ')
}

function conversionText(conversion) {
  if (!conversion) return ''
  return `${conversion.fromUnit || ''} → ${conversion.toUnit || ''} × ${conversion.multiplier || ''}`
}

function color(argb) {
  return { argb }
}

function solidFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: color(argb) }
}

function thinBorder() {
  return {
    top: { style: 'thin', color: color(BORDER_COLOR) },
    left: { style: 'thin', color: color(BORDER_COLOR) },
    bottom: { style: 'thin', color: color(BORDER_COLOR) },
    right: { style: 'thin', color: color(BORDER_COLOR) }
  }
}

function styleHeaderRow(row) {
  row.height = 26
  row.eachCell(cell => {
    cell.font = { bold: true, color: color(WHITE_COLOR), size: 11 }
    cell.fill = solidFill(PRIMARY_COLOR)
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = thinBorder()
  })
}

function styleDataRow(row) {
  row.eachCell({ includeEmpty: true }, cell => {
    cell.font = { color: color(BODY_TEXT_COLOR), size: 10 }
    cell.fill = solidFill(WHITE_COLOR)
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
    cell.border = thinBorder()
  })
}

function alignCells(row, keys, horizontal) {
  keys.forEach(key => {
    const cell = row.getCell(key)
    cell.alignment = Object.assign({}, cell.alignment, { horizontal, wrapText: true })
  })
}

function configureSheet(sheet, options) {
  const settings = options || {}
  sheet.pageSetup = {
    orientation: settings.orientation || 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  }
  sheet.properties.defaultRowHeight = 21
}

function addSummarySheet(workbook, document) {
  const sheet = workbook.addWorksheet('账单汇总', {
    properties: { defaultColWidth: 18 }
  })
  configureSheet(sheet, { orientation: 'portrait' })
  sheet.columns = [{ width: 22 }, { width: 32 }, { width: 22 }, { width: 32 }]
  sheet.mergeCells('A1:D1')
  const title = sheet.getCell('A1')
  title.value = '客户对账单'
  title.font = { bold: true, size: 20, color: color(PRIMARY_COLOR) }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(1).height = 38
  sheet.mergeCells('A2:D2')
  const subtitle = sheet.getCell('A2')
  subtitle.value = `${document.header.enterpriseName} · ${document.header.customerName}`
  subtitle.font = { bold: true, size: 13, color: color(BODY_TEXT_COLOR) }
  subtitle.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(2).height = 28

  const rows = [
    ['企业名称', document.header.enterpriseName, '客户名称', document.header.customerName],
    ['账期', document.header.periodTitle, '状态', document.header.statusText],
    ['开始日期', asDate(document.header.startDate), document.header.endDateLabel, asDate(document.header.endDate)],
    ['商品总额', asMoney(document.totals.itemsSubtotalCents), '运费总额', asMoney(document.totals.freightCents)],
    ['应收总额', asMoney(document.totals.shipmentTotalCents), '已收金额', asMoney(document.totals.receivedCents)],
    ['剩余应收', asMoney(document.totals.outstandingCents), '发货笔数', document.counts.shipments],
    ['生成时间', document.header.generatedAt, '', '']
  ]
  rows.forEach((values, index) => {
    const row = sheet.addRow(values)
    row.height = 26
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { color: color(BODY_TEXT_COLOR), size: 11 }
      cell.fill = solidFill(WHITE_COLOR)
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
      cell.border = thinBorder()
    })
    ;[1, 3].forEach(column => {
      row.getCell(column).font = { bold: true, color: color(PRIMARY_COLOR), size: 11 }
      row.getCell(column).fill = solidFill(HEADER_FILL)
    })
    if (index === 2) {
      row.getCell(2).numFmt = DATE_FORMAT
      row.getCell(4).numFmt = DATE_FORMAT
      row.getCell(2).alignment.horizontal = 'center'
      row.getCell(4).alignment.horizontal = 'center'
    }
    if (index >= 3 && index <= 5) {
      row.getCell(2).numFmt = MONEY_FORMAT
      row.getCell(2).alignment.horizontal = 'right'
      if (index < 5) row.getCell(4).numFmt = MONEY_FORMAT
      if (index < 5) row.getCell(4).alignment.horizontal = 'right'
    }
  })
  sheet.printArea = `A1:D${sheet.rowCount}`
  sheet.getCell('B7').font = { bold: true, color: color(BODY_TEXT_COLOR), size: 11 }
  sheet.getCell('D7').font = { bold: true, color: color(BODY_TEXT_COLOR), size: 11 }
  sheet.getCell('A8').font = { bold: true, color: color(OUTSTANDING_COLOR), size: 13 }
  sheet.getCell('B8').font = { bold: true, color: color(OUTSTANDING_COLOR), size: 13 }
  return sheet
}

function addShipmentSheet(workbook, document) {
  const sheet = workbook.addWorksheet('发货明细', {
    views: [{ state: 'frozen', ySplit: 1 }]
  })
  configureSheet(sheet, { orientation: 'landscape' })
  sheet.columns = [
    { header: '发货日期', key: 'shipmentDate', width: 14 },
    { header: '发货编号', key: 'shipmentId', width: 30 },
    { header: '产品名称', key: 'productName', width: 38 },
    { header: '规格', key: 'specification', width: 25 },
    { header: '颜色', key: 'color', width: 12 },
    { header: '齿型', key: 'toothType', width: 12 },
    { header: '原数量', key: 'originalQuantity', width: 12 },
    { header: '原单位', key: 'originalUnit', width: 10 },
    { header: '计价数量', key: 'pricingQuantity', width: 12 },
    { header: '计价单位', key: 'pricingUnit', width: 10 },
    { header: '换算关系', key: 'conversion', width: 18 },
    { header: '单价（元）', key: 'unitPrice', width: 14 },
    { header: '商品金额（元）', key: 'lineAmount', width: 16 },
    { header: '本笔商品小计（元）', key: 'shipmentSubtotal', width: 18 },
    { header: '本笔运费（元）', key: 'freight', width: 16 },
    { header: '本笔总额（元）', key: 'shipmentTotal', width: 16 },
    { header: '物流', key: 'logisticsProvider', width: 16 },
    { header: '物流原文', key: 'logisticsRaw', width: 28 },
    { header: '发货备注', key: 'note', width: 28 },
    { header: '录入人', key: 'createdBy', width: 16 }
  ]
  styleHeaderRow(sheet.getRow(1))
  sheet.autoFilter = { from: 'A1', to: 'T1' }
  ;(document.shipments || []).forEach(shipment => {
    const lines = shipment.lines && shipment.lines.length ? shipment.lines : [{}]
    lines.forEach((line, index) => {
      const snapshot = line.productSnapshot || {}
      const first = index === 0
      const row = sheet.addRow({
        shipmentDate: asDate(shipment.shipmentDate),
        shipmentId: shipment.id,
        productName: productName(line),
        specification: productSpecification(line),
        color: snapshot.color || '',
        toothType: snapshot.toothType || '',
        originalQuantity: line.originalQuantity == null ? '' : Number(line.originalQuantity),
        originalUnit: line.originalUnit || '',
        pricingQuantity: line.pricingQuantity == null ? '' : Number(line.pricingQuantity),
        pricingUnit: line.pricingUnit || '',
        conversion: conversionText(line.conversion),
        unitPrice: line.unitPriceCents == null ? '' : asMoney(line.unitPriceCents),
        lineAmount: line.lineAmountCents == null ? '' : asMoney(line.lineAmountCents),
        shipmentSubtotal: first ? asMoney(shipment.itemsSubtotalCents) : '',
        freight: first ? asMoney(shipment.freightCents) : '',
        shipmentTotal: first ? asMoney(shipment.totalAmountCents) : '',
        logisticsProvider: first ? shipment.logistics && shipment.logistics.provider || '' : '',
        logisticsRaw: first ? shipment.logistics && shipment.logistics.raw || '' : '',
        note: first ? shipment.note || '' : '',
        createdBy: first ? shipment.createdByNameSnapshot || '' : ''
      })
      styleDataRow(row)
      row.getCell('shipmentDate').numFmt = DATE_FORMAT
      ;['unitPrice', 'lineAmount', 'shipmentSubtotal', 'freight', 'shipmentTotal']
        .forEach(key => { row.getCell(key).numFmt = MONEY_FORMAT })
      alignCells(row, ['productName', 'specification', 'logisticsProvider', 'logisticsRaw', 'note'], 'left')
      alignCells(row, ['shipmentDate', 'shipmentId', 'color', 'toothType', 'originalUnit', 'pricingUnit', 'createdBy'], 'center')
      alignCells(row, ['originalQuantity', 'pricingQuantity', 'unitPrice', 'lineAmount', 'shipmentSubtotal', 'freight', 'shipmentTotal'], 'right')
    })
  })
  sheet.printArea = `A1:T${Math.max(1, sheet.rowCount)}`
  return sheet
}

function addPaymentSheet(workbook, document) {
  const sheet = workbook.addWorksheet('收款明细', {
    views: [{ state: 'frozen', ySplit: 1 }]
  })
  configureSheet(sheet, { orientation: 'landscape' })
  sheet.columns = [
    { header: '收款日期', key: 'paymentDate', width: 14 },
    { header: '收款编号', key: 'paymentId', width: 25 },
    { header: '收款金额（元）', key: 'amount', width: 18 },
    { header: '收款方式', key: 'method', width: 16 },
    { header: '备注', key: 'note', width: 36 },
    { header: '操作人', key: 'createdBy', width: 18 }
  ]
  styleHeaderRow(sheet.getRow(1))
  sheet.autoFilter = { from: 'A1', to: 'F1' }
  ;(document.payments || []).forEach(payment => {
    const row = sheet.addRow({
      paymentDate: asDate(payment.paymentDate),
      paymentId: payment.id,
      amount: asMoney(payment.amountCents),
      method: payment.method || '',
      note: payment.note || '',
      createdBy: payment.createdByNameSnapshot || ''
    })
    styleDataRow(row)
    row.getCell('paymentDate').numFmt = DATE_FORMAT
    row.getCell('amount').numFmt = MONEY_FORMAT
    alignCells(row, ['paymentDate', 'paymentId', 'method', 'createdBy'], 'center')
    alignCells(row, ['note'], 'left')
    alignCells(row, ['amount'], 'right')
  })
  sheet.printArea = `A1:F${Math.max(1, sheet.rowCount)}`
  return sheet
}

async function writeStatementWorkbook(document, filePath, options) {
  const settings = options || {}
  const workbook = new (settings.ExcelJS || ExcelJS).stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: true
  })
  workbook.creator = '客户往来记账小程序'
  workbook.created = new Date(document.header.generatedAt || Date.now())
  const sheets = [
    addSummarySheet(workbook, document),
    addShipmentSheet(workbook, document),
    addPaymentSheet(workbook, document)
  ]
  sheets.forEach(sheet => sheet.commit())
  await workbook.commit()
  return filePath
}

module.exports = {
  MONEY_FORMAT,
  DATE_FORMAT,
  asDate,
  productSpecification,
  writeStatementWorkbook
}
