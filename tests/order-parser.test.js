const test = require('node:test')
const assert = require('node:assert/strict')

const { parseOrderText } = require('../services/order-parser')

test('识别 ×、x、X、* 和紧凑规格写法', () => {
  const cases = [
    '40×40开口灰色 100米',
    '40x40开口灰色 100米',
    '40X40开口灰色 100米',
    '40*40开口灰色 100米',
    '4040开灰100米'
  ]

  cases.forEach(text => {
    const item = parseOrderText(text).items[0]
    assert.equal(item.productLabel, '40×40 / 粗齿 / 灰色', text)
    assert.equal(item.quantity, 100, text)
    assert.equal(item.unit, '米', text)
    assert.equal(item.status, 'matched', text)
  })
})

test('灰、银灰、白和蓝色别名映射到三种标准颜色', () => {
  const cases = [
    ['4040开灰100米', '灰色'],
    ['4040开银灰50米', '灰色'],
    ['4040开白30米', '白色'],
    ['4040开蓝色20米', '蓝色']
  ]
  cases.forEach(([text, color]) => {
    const item = parseOrderText(text).items[0]
    assert.equal(item.color, color)
    assert.equal(item.status, 'matched')
  })
})

test('原文未写颜色时不猜测', () => {
  const item = parseOrderText('4040开口100米').items[0]
  assert.equal(item.productId, null)
  assert.equal(item.status, 'needs_confirmation')
  assert.ok(item.issues.some(issue => issue.code === 'COLOR_MISSING'))
})

test('盖板、盖和盖子均归一为盖子，支持宽度前后不同写法', () => {
  const cases = [
    ['白色15宽盖子 10米', '15mm盖子 / 白色'],
    ['蓝色15盖 10米', '15mm盖子 / 蓝色'],
    ['灰色盖板15 10米', '15mm盖子 / 灰色'],
    ['黑色盖子15mm 10米', '15mm盖子 / 黑色']
  ]
  cases.forEach(([text, label]) => {
    const item = parseOrderText(text).items[0]
    assert.equal(item.productType, 'cover', text)
    assert.equal(item.width, 15, text)
    assert.equal(item.productLabel, label, text)
    assert.equal(item.quantity, 10, text)
    assert.equal(item.status, 'matched', text)
  })
})

test('盖子未写颜色时识别宽度但要求人工选色', () => {
  ;['15宽盖子 10米', '15盖子 10米', '盖子15 10米'].forEach(text => {
    const item = parseOrderText(text).items[0]
    assert.equal(item.width, 15)
    assert.equal(item.productLabel, '15mm盖子 / 待确认颜色')
    assert.equal(item.productId, null)
    assert.ok(item.issues.some(issue => issue.code === 'COLOR_MISSING'))
  })
})

test('截图实例银灰色盖板60会直接匹配标准盖子', () => {
  const item = parseOrderText('银灰色盖板60 2米 切成一米一根').items[0]
  assert.equal(item.productLabel, '60mm盖子 / 灰色')
  assert.equal(item.quantity, 2)
  assert.equal(item.unit, '米')
  assert.equal(item.status, 'matched')
  assert.equal(item.canCreateCustomProduct, false)
})

test('同一行的线槽和盖子可分别识别', () => {
  const result = parseOrderText('4040开白10米 40盖子白色5米')
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].productLabel, '40×40 / 粗齿 / 白色')
  assert.equal(result.items[1].productLabel, '40mm盖子 / 白色')
})

test('未写单位时默认米并透明提示', () => {
  const item = parseOrderText('4040开口白色100').items[0]
  assert.equal(item.quantity, 100)
  assert.equal(item.unit, '米')
  assert.equal(item.unitSource, 'enterprise-default')
  assert.ok(item.issues.some(issue => issue.code === 'UNIT_DEFAULTED_TO_METER'))
})

test('根和箱保留原数量单位，不擅自换算', () => {
  const rootItem = parseOrderText('4040开口白色50根').items[0]
  const boxItem = parseOrderText('4040开口白色3箱').items[0]
  assert.deepEqual([rootItem.quantity, rootItem.unit], [50, '根'])
  assert.deepEqual([boxItem.quantity, boxItem.unit], [3, '箱'])
})

test('多行与连续文字都能拆出标准商品', () => {
  const multiline = parseOrderText('4040开灰100米\n6040细白50米\n8060开蓝30米')
  assert.equal(multiline.items.length, 3)

  const continuous = parseOrderText('4040开灰100 6040细白50 8060开蓝30')
  assert.equal(continuous.items.length, 3)
  assert.deepEqual(continuous.items.map(item => item.quantity), [100, 50, 30])

  const continuousWithUnits = parseOrderText('4040开灰100米 6040细白50米')
  assert.equal(continuousWithUnits.items.length, 2)
  assert.deepEqual(continuousWithUnits.items.map(item => item.status), ['matched', 'matched'])
})

test('完整微信文本能提取商品和已知物流，其余文字不入账', () => {
  const text = [
    '杭州XX电气',
    '银灰色全封闭底部打孔3030，共200米',
    '银灰色封口8080，共800米',
    '都是空白箱！',
    '成都市双流区西航港珠江路600号空港国际城2期1栋1单元722-723号 吕松收 13308072199',
    '空白箱装！发长荣双流-2199，付运费'
  ].join('\n')

  const result = parseOrderText(text)
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].productLabel, '30×30 / 全封闭 / 灰色')
  assert.equal(result.items[1].productLabel, '80×80 / 封口 / 灰色')
  assert.equal(result.logistics.provider, '长荣物流')
  assert.ok(result.unmatchedLines.includes('杭州XX电气'))
  assert.ok(result.unmatchedLines.some(line => line.includes('13308072199')))
})

test('小规格的开口口语按产品库自动纠正为细齿，不写死2525', () => {
  const first = parseOrderText('2525开口白色100').items[0]
  const second = parseOrderText('2020粗齿蓝色50米').items[0]
  ;[first, second].forEach(item => {
    assert.equal(item.toothType, '细齿')
    assert.equal(item.status, 'matched')
    assert.ok(item.issues.some(issue => issue.code === 'TOOTH_TYPE_AUTO_CORRECTED'))
  })
})

test('标准规格支持多齿型时保留用户明确输入，模糊输入不猜', () => {
  const explicit = parseOrderText('4040开口白色100米').items[0]
  assert.equal(explicit.toothType, '粗齿')

  const vague = parseOrderText('4040普通白色100米').items[0]
  assert.equal(vague.productId, null)
  assert.ok(vague.issues.some(issue => issue.code === 'TOOTH_TYPE_MISSING'))
})

test('标准尺寸带特殊长度时保留基础规格和订单数量，但不降级匹配普通标准品', () => {
  const item = parseOrderText('白色4040，1.2米长的1000根').items[0]
  assert.equal(item.height, 40)
  assert.equal(item.width, 40)
  assert.equal(item.color, '白色')
  assert.equal(item.productLengthMeters, 1.2)
  assert.equal(item.quantity, 1000)
  assert.equal(item.unit, '根')
  assert.equal(item.productId, null)
  assert.equal(item.productLabel, '白色40×40-1.2米长')
  assert.equal(item.status, 'needs_custom_product')
  assert.ok(item.issues.some(issue => issue.code === 'SPECIAL_LENGTH_DETECTED'))
  assert.ok(item.issues.some(issue => issue.code === 'CUSTOM_PRODUCT_CREATION_REQUIRED'))
})

test('带特殊长度的标准尺寸优先按结构化属性匹配已有自定义规格', () => {
  const customProducts = [{
    id: 'custom-4040-12',
    name: '4040白色短料1.2M',
    aliases: ['白色40×40-1.2米长'],
    height: 40,
    width: 40,
    color: '白色',
    toothType: null,
    unitLengthMeters: 1.2,
    isStandard: false,
    active: true
  }]
  const item = parseOrderText('白色4040 1.2米长500根', { customProducts }).items[0]
  assert.equal(item.productId, 'custom-4040-12')
  assert.equal(item.productLabel, '4040白色短料1.2M')
  assert.equal(item.quantity, 500)
  assert.equal(item.status, 'matched')

  const keywordItem = parseOrderText('4040白1.2 200根', {
    customProducts: [Object.assign({}, customProducts[0], {
      aliases: [],
      recognitionKeywords: ['4040白1.2']
    })]
  }).items[0]
  assert.equal(keywordItem.productId, 'custom-4040-12')
  assert.equal(keywordItem.quantity, 200)
})

test('定尺、定制和非标等描述会阻止普通标准品直接匹配', () => {
  ;['白色4040定尺100根', '白色4040定制100根', '白色4040非标100根'].forEach(text => {
    const item = parseOrderText(text).items[0]
    assert.equal(item.productId, null, text)
    assert.equal(item.canCreateCustomProduct, true, text)
    assert.ok(item.issues.some(issue => issue.code === 'SPECIAL_PRODUCT_FEATURE_DETECTED'), text)
  })
})

test('自定义产品的长度不会被当成订单数量', () => {
  const item = parseOrderText('白色装潢1515-1.3米长 50根').items[0]
  assert.equal(item.productLabel, '白色装潢1515-1.3米长')
  assert.equal(item.productLength, '1.3米')
  assert.equal(item.quantity, 50)
  assert.equal(item.unit, '根')
  assert.equal(item.status, 'needs_custom_product')
  assert.equal(item.canCreateCustomProduct, true)
})

test('自定义产品再次出现时按空格和符号差异匹配已有产品', () => {
  const customProducts = [{
    id: 'custom-1',
    name: '白色装潢1525，1.3米长',
    normalizedName: '白色装潢15251.3米长',
    isStandard: false,
    active: true
  }]
  const item = parseOrderText('白色装潢1525，1.3米的200根', { customProducts }).items[0]
  assert.equal(item.productId, 'custom-1')
  assert.equal(item.status, 'matched')
  assert.equal(item.quantity, 200)
  assert.equal(item.unit, '根')
  assert.equal(item.canCreateCustomProduct, false)
})

test('自定义产品名称会移除连接数量的“的”', () => {
  const item = parseOrderText('白色装潢1525，1.3米长的1000根').items[0]
  assert.equal(item.customProductDraft.name, '白色装潢1525 1.3米长')
  assert.equal(item.productLength, '1.3米')
  assert.equal(item.quantity, 1000)
  assert.equal(item.unit, '根')
})

test('规格库外的明确尺寸进入自定义产品确认，不阻止记账', () => {
  const item = parseOrderText('白色35×27特殊齿100米').items[0]
  assert.equal(item.status, 'needs_custom_product')
  assert.equal(item.customProductDraft.name, '白色35×27特殊齿')
  assert.equal(item.quantity, 100)
})

test('重复标准商品合并数量并留下显式提醒', () => {
  const result = parseOrderText('4040开灰100米\n40×40开口灰色 50米')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].quantity, 150)
  assert.ok(result.items[0].issues.some(issue => issue.code === 'DUPLICATE_MERGED'))
})

test('异常输入不会生成商品', () => {
  const result = parseOrderText('请尽快发货\n电话 13308072199\n谢谢')
  assert.equal(result.items.length, 0)
  assert.equal(result.unmatchedLines.length, 3)
})
