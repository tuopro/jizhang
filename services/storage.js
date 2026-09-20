const STORAGE_KEY = 'monthly_credit_ledger_v1'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createMemoryStorage(initialValue) {
  let current = clone(initialValue || null)
  return {
    read() {
      return clone(current)
    },
    write(value) {
      current = clone(value)
    }
  }
}

function createWxStorage() {
  if (typeof wx === 'undefined') {
    throw new Error('微信存储只能在小程序运行环境中使用')
  }
  return {
    read() {
      return wx.getStorageSync(STORAGE_KEY) || null
    },
    write(value) {
      wx.setStorageSync(STORAGE_KEY, value)
    }
  }
}

module.exports = {
  STORAGE_KEY,
  createMemoryStorage,
  createWxStorage
}
