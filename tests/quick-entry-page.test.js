const test = require('node:test')
const assert = require('node:assert/strict')

test('记一笔页面可完成验收示例并在补齐28元后解锁确认入账', async () => {
  let storedValue = null
  let pageDefinition = null
  let navigatedBack = false

  global.wx = {
    getStorageSync(key) {
      if (key === 'ledger_privacy_consent') {
        return { version: '2026-09-v2', agreedAt: '2026-09-20T12:00:00.000Z' }
      }
      return storedValue
    },
    setStorageSync(key, value) {
      storedValue = JSON.parse(JSON.stringify(value))
    },
    getPrivacySetting(options) {
      options.success({ needAuthorization: false, privacyContractName: '线槽记账助手隐私保护指引' })
    },
    showToast() {},
    showModal(options) {
      if (options.confirmText) {
        assert.ok(Array.from(options.confirmText).length <= 4, '微信确认按钮文字不得超过4个字符')
      }
      if (options.success) options.success({ confirm: true })
    },
    navigateBack() {
      navigatedBack = true
    }
  }
  global.Page = definition => {
    pageDefinition = definition
  }

  require('../pages/quick-entry/quick-entry.js')
  function createPage() {
    return Object.assign({}, pageDefinition, {
      data: JSON.parse(JSON.stringify(pageDefinition.data)),
      setData(update, callback) {
        Object.assign(this.data, update)
        if (callback) callback()
      }
    })
  }

  const page = createPage()

  await page.onLoad()
  page.loadAcceptanceSample()
  assert.equal(page.data.rows.length, 3)
  assert.equal(page.data.missingCount, 1)
  assert.equal(page.data.itemsSubtotalText, '¥2180.00')
  assert.equal(page.data.freightText, '¥0.00')
  assert.equal(page.data.totalText, '¥2180.00')
  assert.equal(page.data.canPost, false)
  assert.equal(page.data.rows[2].saveAsDefault, true)

  page.onPriceInput({
    currentTarget: { dataset: { index: 2 } },
    detail: { value: '28.00' }
  })
  assert.equal(page.data.missingCount, 0)
  assert.equal(page.data.itemsSubtotalText, '¥3020.00')
  assert.equal(page.data.freightText, '¥0.00')
  assert.equal(page.data.totalText, '¥3020.00')
  assert.equal(page.data.canPost, true)

  page.onFreightInput({ detail: { value: '120' } })
  assert.equal(page.data.freightText, '¥120.00')
  assert.equal(page.data.totalText, '¥3140.00')
  assert.equal(page.data.canPost, true)
  page.onFreightInput({ detail: { value: '-1' } })
  assert.match(page.data.freightError, /运费必须/)
  assert.equal(page.data.canPost, false)
  page.onFreightInput({ detail: { value: '12.50' } })
  assert.equal(page.data.freightText, '¥12.50')
  assert.equal(page.data.totalText, '¥3032.50')
  page.onFreightInput({ detail: { value: '' } })
  assert.equal(page.data.freightText, '¥0.00')
  assert.equal(page.data.totalText, '¥3020.00')
  assert.equal(page.data.canPost, true)

  page.postShipment()
  assert.equal(navigatedBack, true)
  const tenant = storedValue.tenants.tenant_demo_cndes
  assert.equal(tenant.shipments.length, 1)
  assert.equal(tenant.shipments[0].totalAmountCents, 302000)
  assert.ok(tenant.customerPrices.some(price =>
    price.productId === page.data.rows[2].productId && price.unitPriceCents === 2800
  ))

  const mismatchPage = createPage()
  await mismatchPage.onLoad()
  mismatchPage.setData({ orderText: '4040开口白色50根' })
  mismatchPage.parseOrder()
  assert.equal(mismatchPage.data.rows[0].unit, '根')
  assert.equal(mismatchPage.data.rows[0].pricingUnit, '米')
  assert.equal(mismatchPage.data.rows[0].unitMismatch, true)
  assert.equal(mismatchPage.data.canPost, false)
  mismatchPage.onConversionInput({
    currentTarget: { dataset: { index: 0 } },
    detail: { value: '2' }
  })
  assert.equal(mismatchPage.data.canPost, true)
  assert.equal(mismatchPage.data.totalText, '¥680.00')

  const customPage = createPage()
  await customPage.onLoad()
  customPage.setData({ orderText: '白色装潢1525，1.3米长的50根' })
  customPage.parseOrder()
  assert.equal(customPage.data.rows[0].canCreateCustomProduct, true)
  assert.equal(customPage.data.canPost, false)
  customPage.createCustomProduct({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(customPage.data.selectorOpen, true)
  assert.equal(customPage.data.showCustomForm, true)
  assert.equal(customPage.data.customForm.unitLengthText, '1.3')
  customPage.onCustomFormInput({
    currentTarget: { dataset: { field: 'name' } },
    detail: { value: '白色装潢1525定尺1.3M' }
  })
  customPage.saveCustomProduct()
  assert.ok(customPage.data.rows[0].productId)
  assert.equal(customPage.data.rows[0].pricingUnit, '根')
  assert.equal(customPage.data.canPost, false, '创建产品后仍必须补客户专属价')
  customPage.onPriceInput({
    currentTarget: { dataset: { index: 0 } },
    detail: { value: '12.50' }
  })
  assert.equal(customPage.data.totalText, '¥625.00')
  assert.equal(customPage.data.canPost, true)
  customPage.postShipment()

  const repeatPage = createPage()
  await repeatPage.onLoad()
  repeatPage.setData({ orderText: '白色装潢1525，1.3米的100根' })
  repeatPage.parseOrder()
  assert.equal(repeatPage.data.rows[0].canCreateCustomProduct, false)
  assert.equal(repeatPage.data.rows[0].unitPriceYuan, '12.50')
  assert.equal(repeatPage.data.totalText, '¥1250.00')
  assert.equal(repeatPage.data.canPost, true)

  const correctionPage = createPage()
  await correctionPage.onLoad()
  correctionPage.setData({ orderText: '白色4040，1.2米长的1000根' })
  correctionPage.parseOrder()
  assert.equal(correctionPage.data.rows[0].productId, '')
  correctionPage.openProductSelector({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(correctionPage.data.selectorOpen, true)
  assert.ok(correctionPage.standardProductOptions.length > 0)
  assert.ok(correctionPage.customProductOptions.length > 0)
  const standardOption = correctionPage.productOptions.find(option =>
    option.label === '40×40 / 粗齿 / 白色'
  )
  correctionPage.selectProduct({ currentTarget: { dataset: { productId: standardOption.id } } })
  assert.equal(correctionPage.data.rows[0].productId, standardOption.id)
  assert.equal(correctionPage.data.rows[0].needsProductConfirmation, false)

  const lengthPage = createPage()
  await lengthPage.onLoad()
  lengthPage.setData({ orderText: '白色4040，1.2米长的1000根' })
  lengthPage.parseOrder()
  assert.equal(lengthPage.data.rows[0].productLengthMeters, 1.2)
  assert.equal(lengthPage.data.rows[0].quantityText, '1000')
  lengthPage.createCustomProduct({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(lengthPage.data.customForm.name, '白色40×40-1.2米长')
  assert.equal(lengthPage.data.customForm.baseSpecText, '40×40')
  assert.equal(lengthPage.data.customForm.unitLengthText, '1.2')
  lengthPage.saveCustomProduct()
  assert.ok(lengthPage.data.rows[0].productId)
  assert.equal(lengthPage.data.canPost, false)
  lengthPage.onPricingUnitChange({
    currentTarget: { dataset: { index: 0 } },
    detail: { value: '0' }
  })
  lengthPage.onPriceInput({
    currentTarget: { dataset: { index: 0 } },
    detail: { value: '2.90' }
  })
  assert.equal(lengthPage.data.rows[0].suggestedConversionRate, '1.2')
  assert.equal(lengthPage.data.canPost, false, '单根长度只提示，未确认换算前仍锁定')
  lengthPage.confirmSuggestedConversion({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(lengthPage.data.totalText, '¥3480.00')
  assert.equal(lengthPage.data.canPost, true)
  lengthPage.postShipment()

  const lengthRepeatPage = createPage()
  await lengthRepeatPage.onLoad()
  lengthRepeatPage.setData({ orderText: '白色4040 1.2米长500根' })
  lengthRepeatPage.parseOrder()
  assert.equal(lengthRepeatPage.data.rows[0].canCreateCustomProduct, false)
  assert.ok(lengthRepeatPage.data.rows[0].productId)
  assert.equal(lengthRepeatPage.data.rows[0].unitPriceYuan, '2.90')
  assert.equal(lengthRepeatPage.data.rows[0].suggestedConversionRate, '1.2')
  assert.equal(lengthRepeatPage.data.canPost, false)
  lengthRepeatPage.confirmSuggestedConversion({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(lengthRepeatPage.data.totalText, '¥1740.00')
  assert.equal(lengthRepeatPage.data.canPost, true)

  delete global.Page
  delete global.wx
})
