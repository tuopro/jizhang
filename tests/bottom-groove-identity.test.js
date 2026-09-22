const test = require('node:test')
const assert = require('node:assert/strict')
const { parseOrderText } = require('../services/order-parser')
const { createLedgerRepository } = require('../services/ledger-repository')
const { createMemoryStorage } = require('../services/storage')
const { normalizeCustomProductName, buildProductId, products, findProductWithAttributes } = require('../data/product-specs')

const variants = [
  '银灰色细齿底槽4025', '银灰色底槽细齿4025', '底槽银灰色细齿4025',
  '4025银灰色细齿底槽', '银灰色4025底槽细齿', '4025 银灰色 细齿 底槽',
  '银灰色-40×25-底槽-细齿', '银灰色，细齿，底槽，40x25'
]
function repository() {
  const storage = createMemoryStorage()
  const repo = createLedgerRepository(storage)
  repo.initializeTenant('tenant', { enterprise: { id: 'tenant', name: '底槽识别测试' } })
  return { repo, storage }
}
function create(repo, text, extra) {
  const draft = parseOrderText(`${text} 100米`).items[0].customProductDraft
  return repo.createCustomProduct('tenant', { confirmed: true, ...draft, ...extra })
}
for (const text of variants) {
  test(`${text} 保留底槽身份、灰色/细齿/40×25，不回退标准品`, () => {
    const item = parseOrderText(text).items[0]
    assert.equal(item.productId, null)
    assert.equal(item.status, 'needs_custom_product')
    assert.equal(item.height, 40)
    assert.equal(item.width, 25)
    assert.equal(item.color, '灰色')
    assert.equal(item.toothType, '细齿')
    assert.deepEqual(item.specialTags, ['底槽'])
    assert.equal(item.hasSpecialAttributes, true)
    assert.match(item.customProductDraft.name, /底槽/)
    assert.match(item.customProductDraft.normalizedName, /底槽/)
    assert.equal(item.quantity, null)
  })
}
for (const unit of ['米', '根', '箱']) {
  test(`底槽 100${unit} 数量与产品身份分离`, () => {
    const item = parseOrderText(`银灰色细齿底槽4025 100${unit}`).items[0]
    assert.equal(item.quantity, 100)
    assert.equal(item.unit, unit)
    assert.equal(item.productLengthMeters, null)
    assert.ok(!item.customProductDraft.normalizedName.includes('100'))
    assert.equal(item.customProductDraft.unitLengthMeters, null)
  })
}
test('底槽裸数量继续默认米；无数量不会误把4025作为数量', () => {
  assert.equal(parseOrderText('银灰色细齿底槽4025 100').items[0].unit, '米')
  assert.equal(parseOrderText('银灰色细齿底槽4025 100').items[0].quantity, 100)
  assert.equal(parseOrderText('银灰色细齿底槽4025').items[0].quantity, null)
})
test('底槽在 specialTags 和 normalizedName 中持久化；不同词序重复创建复用一个ID', () => {
  const { repo } = repository()
  const product = create(repo, variants[0])
  for (const text of variants) {
    const item = parseOrderText(`${text} 100米`, { customProducts: repo.listCustomProducts('tenant') }).items[0]
    assert.equal(item.productId, product.id, text)
    // Also exercise direct create API with a differently ordered raw name.
    assert.equal(repo.createCustomProduct('tenant', { confirmed: true, name: text }).id, product.id)
  }
  assert.equal(repo.listCustomProducts('tenant').length, 1)
  assert.deepEqual(product.specialTags, ['底槽'])
  assert.match(product.normalizedName, /底槽/)
  assert.notEqual(product.normalizedName, normalizeCustomProductName('灰色40×25细齿'))
})
test('只有旧名称底槽、空specialTags和旧normalizedName时也能读取复用，不改写旧产品', () => {
  const { repo, storage } = repository()
  const root = storage.read()
  root.tenants.tenant.customProducts.push({ id: 'legacy', tenantId: 'tenant', name: variants[0], normalizedName: '灰色4025细齿', specialTags: [], active: true, isStandard: false })
  storage.write(root)
  const before = storage.read()
  for (const text of variants) assert.equal(parseOrderText(`${text} 100米`, { customProducts: repo.listCustomProducts('tenant') }).items[0].productId, 'legacy')
  assert.deepEqual(storage.read(), before)
})
test('普通4025保持标准匹配，已有底槽产品不会抢占普通输入', () => {
  const { repo } = repository()
  create(repo, variants[0])
  const item = parseOrderText('银灰色细齿4025 100米', { customProducts: repo.listCustomProducts('tenant') }).items[0]
  assert.equal(item.productId, buildProductId(40, 25, '细齿', '灰色'))
  assert.equal(item.status, 'matched')
  assert.deepEqual(item.specialTags, [])
})
for (const field of ['aliases', 'recognitionKeywords']) {
  for (const direction of ['bottom-to-plain', 'plain-to-bottom']) {
    test(`${field} ${direction} 不能绕过底槽身份边界`, () => {
      const bottom = direction === 'bottom-to-plain'
      const name = bottom ? variants[0] : '银灰色细齿4025'
      const alias = bottom ? '银灰色细齿4025' : variants[0]
      const product = { id: 'wrong', name, [field]: [alias], specialTags: [], height: 40, width: 25, color: '灰色', toothType: '细齿' }
      const item = parseOrderText(`${alias} 100米`, { customProducts: [product] }).items[0]
      assert.notEqual(item.productId, 'wrong')
      assert.equal(item.productId, bottom ? buildProductId(40, 25, '细齿', '灰色') : null)
    })
  }
}
test('普通自定义4025与底槽创建为不同ID；别名交叉也不能合并', () => {
  const { repo } = repository()
  const plain = repo.createCustomProduct('tenant', { confirmed: true, name: '银灰色细齿4025', aliases: [variants[0]], specialTags: [] })
  const bottom = create(repo, variants[0], { aliases: ['银灰色细齿4025'] })
  assert.notEqual(bottom.id, plain.id)
  assert.equal(repo.listCustomProducts('tenant').length, 2)
  assert.equal(parseOrderText('银灰色细齿4025 100米', { customProducts: repo.listCustomProducts('tenant') }).items[0].productId, plain.id)
  assert.equal(parseOrderText(`${variants[0]} 100米`, { customProducts: repo.listCustomProducts('tenant') }).items[0].productId, bottom.id)
})
test('底槽与1.3米长度共同组成身份，数量100根不进入identity，不同长度不复用', () => {
  const { repo } = repository()
  const text = '银灰色细齿底槽4025 1.3米长 100根'
  const item = parseOrderText(text).items[0]
  assert.equal(item.quantity, 100)
  assert.equal(item.unit, '根')
  assert.equal(item.productLengthMeters, 1.3)
  assert.deepEqual(item.specialTags, ['底槽'])
  assert.match(item.customProductDraft.normalizedName, /底槽.*1\.3米/)
  assert.ok(!item.customProductDraft.normalizedName.includes('100'))
  const product = repo.createCustomProduct('tenant', { confirmed: true, ...item.customProductDraft })
  const customProducts = [product]
  assert.equal(parseOrderText('4025 银灰色 细齿 底槽 长度1.3米长 100根', { customProducts }).items[0].productId, product.id)
  for (const input of ['银灰色细齿4025 1.3米长 100根', '银灰色细齿底槽4025 1.2米长 100根', '银灰色细齿底槽4025 100根']) {
    assert.notEqual(parseOrderText(input, { customProducts }).items[0].productId, product.id, input)
  }
  const noLength = create(repo, variants[0])
  assert.notEqual(product.id, noLength.id)
  const wrongAlias = { ...product, aliases: ['银灰色细齿底槽4025 1.2米长'] }
  assert.notEqual(parseOrderText('银灰色细齿底槽4025 1.2米长 100根', { customProducts: [wrongAlias] }).items[0].productId, product.id)
})
test('普通特殊长度自定义产品不能匹配底槽同长度；底槽短料不能降级普通底槽', () => {
  const ordinaryLength = { id: 'length', name: '灰色40×25细齿-1.3米长', height: 40, width: 25, color: '灰色', toothType: '细齿', unitLengthMeters: 1.3, specialTags: [] }
  assert.equal(parseOrderText('银灰色细齿底槽4025 1.3米长 100根', { customProducts: [ordinaryLength] }).items[0].productId, null)
  const bottom = { ...ordinaryLength, id: 'bottom', name: '灰色40×25细齿底槽', unitLengthMeters: null, specialTags: ['底槽'] }
  assert.equal(parseOrderText('银灰色细齿底槽4025短料 100根', { customProducts: [bottom] }).items[0].productId, null)
})
test('40×25与25×40严格区分，不交换高宽；颜色和齿型不兼容也不复用', () => {
  const { repo } = repository()
  const bottom = create(repo, variants[0])
  for (const text of ['银灰色细齿底槽25×40', '白色细齿底槽40×25', '银灰色封口底槽40×25']) {
    const item = parseOrderText(`${text} 100米`, { customProducts: [bottom] }).items[0]
    assert.equal(item.productId, null)
    assert.notEqual(create(repo, text).id, bottom.id)
  }
  const reversed = parseOrderText('银灰色细齿底槽25×40 100米').items[0]
  assert.equal(reversed.height, 25)
  assert.equal(reversed.width, 40)
})
test('停用和多个重复底槽不会任意选择；直接重复创建遇歧义拒绝', () => {
  const { repo, storage } = repository()
  const bottom = create(repo, variants[0])
  assert.equal(parseOrderText('4025 银灰色 细齿 底槽 100米', { customProducts: [{ ...bottom, active: false }] }).items[0].productId, null)
  const root = storage.read()
  root.tenants.tenant.customProducts.push({ ...bottom, id: 'duplicate', name: '银灰色40×25细齿底槽', aliases: [] })
  storage.write(root)
  const before = storage.read()
  assert.equal(parseOrderText('4025 银灰色 细齿 底槽 100米', { customProducts: repo.listCustomProducts('tenant') }).items[0].productId, null)
  assert.throws(() => repo.createCustomProduct('tenant', { confirmed: true, name: '4025 银灰色 细齿 底槽' }), /多个相同底槽/)
  assert.deepEqual(storage.read(), before)
})
for (const tag of ['装潢', '定尺', '定制', '非标', '短料', '加长', '裁切', '特殊']) {
  test(`原 ${tag} 特殊属性识别保持`, () => {
    const item = parseOrderText(`银灰色细齿4025${tag} 100根`).items[0]
    assert.equal(item.productId, null)
    assert.deepEqual(item.specialTags, [tag])
    assert.equal(item.quantity, 100)
  })
}
test('本轮不扩展底板/底座/槽底/无盖/开槽同义词', () => {
  for (const word of ['底板', '底座', '槽底', '无盖', '开槽']) {
    assert.deepEqual(parseOrderText(`银灰色细齿4025${word} 100米`).items[0].specialTags, [])
  }
})
test('标准规格与盖子事实不变；特殊标准匹配底槽不得回退普通产品', () => {
  assert.equal(products.filter(p => p.productType === 'cover').length, 60)
  const cover = parseOrderText('银灰色盖板60 2米').items[0]
  assert.equal(cover.productType, 'cover')
  assert.equal(cover.status, 'matched')
  assert.equal(findProductWithAttributes(40, 25, '细齿', '灰色', { specialTags: ['底槽'] }), null)
  assert.equal(products.some(p => (p.specialTags || []).includes('底槽')), false)
})
