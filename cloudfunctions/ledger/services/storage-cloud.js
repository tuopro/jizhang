function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createMemoryStorage(initialValue) {
  let current = clone(initialValue || null)
  return {
    read() { return clone(current) },
    write(value) { current = clone(value) }
  }
}

module.exports = { createMemoryStorage }
