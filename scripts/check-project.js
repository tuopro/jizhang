const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
const projectPrivateConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.private.config.json'), 'utf8'))
const failures = []

if (projectConfig.appid !== 'wx5093ae94c1ece97b') {
  failures.push('项目 AppID 应为独立记账小程序 wx5093ae94c1ece97b')
}
if (projectConfig.cloudfunctionRoot !== 'cloudfunctions/') {
  failures.push('正式版必须配置 cloudfunctions/ 云函数目录')
}
if (projectConfig.miniprogramRoot !== './') {
  failures.push('根目录项目必须显式配置 miniprogramRoot 为 ./')
}
if (projectConfig.setting.ignoreDevUnusedFiles !== true) {
  failures.push('项目配置必须保持开启开发时无依赖文件过滤')
}
if (projectConfig.setting.ignoreUploadUnusedFiles !== true) {
  failures.push('项目配置必须保持开启上传时无依赖文件过滤')
}
if (projectPrivateConfig.setting.ignoreDevUnusedFiles !== true) {
  failures.push('本机项目配置必须与公开项目配置一致开启无依赖文件过滤')
}
const includesPages = (projectConfig.packOptions.include || []).some(item =>
  item.type === 'folder' && item.value === 'pages'
)
if (!includesPages) {
  failures.push('开启依赖过滤时必须显式把 pages 目录加入打包白名单')
}

appJson.pages.forEach(pagePath => {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    const filePath = path.join(root, `${pagePath}.${extension}`)
    if (!fs.existsSync(filePath)) failures.push(`缺少页面文件：${pagePath}.${extension}`)
  }
})

const tabBarPages = ((appJson.tabBar || {}).list || []).map(item => item.pagePath)
const expectedTabBarPages = [
  'pages/index/index',
  'pages/clients/clients',
  'pages/history/history',
  'pages/mine/mine'
]
if (appJson.entryPagePath !== expectedTabBarPages[0]) {
  failures.push('小程序入口页必须显式设为首页 Tab')
}
if (JSON.stringify(tabBarPages) !== JSON.stringify(expectedTabBarPages)) {
  failures.push('底部四个 Tab 的 pagePath 或顺序不正确')
}
tabBarPages.forEach(pagePath => {
  if (!appJson.pages.includes(pagePath)) failures.push(`Tab 页面未在 pages 注册：${pagePath}`)
})
const subpackagePages = (appJson.subpackages || appJson.subPackages || []).flatMap(pkg =>
  (pkg.pages || []).map(page => `${pkg.root}/${page}`.replace(/\/+/g, '/'))
)
tabBarPages.forEach(pagePath => {
  if (subpackagePages.includes(pagePath)) failures.push(`Tab 页面不能放入分包：${pagePath}`)
})

const jsFiles = []
function collectJs(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
    if (['node_modules', '.git'].includes(entry.name)) return
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectJs(fullPath)
    if (entry.isFile() && entry.name.endsWith('.js')) jsFiles.push(fullPath)
  })
}
collectJs(root)

jsFiles.forEach(filePath => {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' })
  if (result.status !== 0) failures.push(`${path.relative(root, filePath)} 语法错误：${result.stderr.trim()}`)
})

const tabPageModulePattern = /(?:require\s*\(|\bfrom\s+)[^\n]*(?:pages\/)?(?:index|clients|history|mine)\/(?:index|clients|history|mine)\.js/
jsFiles.forEach(filePath => {
  if (tabPageModulePattern.test(fs.readFileSync(filePath, 'utf8'))) {
    failures.push(`页面脚本不应被其他模块 require/import：${path.relative(root, filePath)}`)
  }
})

const productSource = fs.readFileSync(path.join(root, 'data/product-specs.js'), 'utf8')
if (/basePrice\s*:/.test(productSource)) failures.push('产品库中不应出现通用基础价格')

const sharedCloudFiles = [
  ['services/ledger-repository.js', 'cloudfunctions/ledger/services/ledger-repository.js'],
  ['services/pricing.js', 'cloudfunctions/ledger/services/pricing.js'],
  ['data/product-specs.js', 'cloudfunctions/ledger/data/product-specs.js'],
  ['data/demo-seed.js', 'cloudfunctions/ledger/data/demo-seed.js'],
  ['utils/money.js', 'cloudfunctions/ledger/utils/money.js']
]
sharedCloudFiles.forEach(([source, cloudCopy]) => {
  const sourcePath = path.join(root, source)
  const cloudPath = path.join(root, cloudCopy)
  if (!fs.existsSync(cloudPath) || fs.readFileSync(sourcePath, 'utf8') !== fs.readFileSync(cloudPath, 'utf8')) {
    failures.push(`云函数共享业务规则未同步：${cloudCopy}`)
  }
})

const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8')
if (!/dataAccessMode:\s*'cloud'/.test(appSource)) failures.push('正式版默认数据模式必须为 cloud')

async function main() {
  if (failures.length) throw new Error(failures.join('\n'))

  const compilerPath = process.env.WECHAT_WCC_PATH ||
    '/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc'
  if (!fs.existsSync(compilerPath)) {
    throw new Error('未找到微信原生 WXML/WXSS 编译器')
  }
  const { wcc, wcsc } = require(compilerPath)
  const wxmlFiles = appJson.pages.map(page => `${page}.wxml`)
  const wxssFiles = [...appJson.pages.map(page => `${page}.wxss`), 'app.wxss']
  const wxmlOutput = await wcc({ cwd: root, files: wxmlFiles })
  const wxssOutput = await wcsc({ cwd: root, files: wxssFiles, pageCount: appJson.pages.length })
  if (!wxmlOutput || !wxssOutput) throw new Error('微信原生编译器返回空结果')

  console.log(
    `项目检查通过：${appJson.pages.length}个页面，${jsFiles.length}个JS文件，` +
    `${wxmlFiles.length}个WXML和${wxssFiles.length}个WXSS完成微信原生编译。`
  )
}

main().catch(error => {
  console.error(error.message || error)
  process.exitCode = 1
})
