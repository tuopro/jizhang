const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Compile the actual page template with the same native WCC used by npm run check.
// Test the resulting node tree rather than approximating wx:if with a regex.
async function compileWxml(pagePath) {
  const compilerPath = process.env.WECHAT_WCC_PATH ||
    '/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc'
  if (!fs.existsSync(compilerPath)) throw new Error('WXML 渲染测试需要微信原生编译器，可通过 WECHAT_WCC_PATH 指定')
  const { wcc } = require(compilerPath)
  const template = `${pagePath}.wxml`
  const compiled = await wcc({ cwd: path.resolve(__dirname, '../..'), files: [template] })
  return data => {
    const errors = []
    const context = vm.createContext({
      window: { __webview_engine_version__: 0.02 },
      console: { log: () => errors.push('WXML runtime error'), warn: () => errors.push('WXML runtime warning') }
    })
    vm.runInContext(compiled, context, { timeout: 1000 })
    const renderer = context.$gwx(template)
    if (typeof renderer !== 'function') throw new Error('编译输出缺少目标页面')
    const tree = renderer(data)
    if (errors.length || !tree) throw new Error(errors.join('; ') || 'WXML 没有返回渲染节点')
    return tree
  }
}

function findNodes(tree, predicate) {
  const result = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (predicate(node)) result.push(node)
    ;(node.children || []).forEach(visit)
  }
  visit(tree)
  return result
}

module.exports = { compileWxml, findNodes }
