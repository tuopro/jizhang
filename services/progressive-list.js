const PAGE_SIZE = 30

// Full filtered data stays on the page instance; only visible rows cross setData.
// Keep the displayed extent on refresh so returning to a list does not collapse it.
function setProgressiveList(page, key, items, patch, reset) {
  if (!page._renderLists) page._renderLists = {}
  const previous = page._renderLists[key]
  const limit = Math.min(items.length, reset || !previous ? PAGE_SIZE : Math.max(PAGE_SIZE, previous.limit))
  page._renderLists[key] = { items, limit }
  page.setData(Object.assign({}, patch, { [key]: items.slice(0, limit) }))
}

function appendProgressiveList(page, key) {
  const state = page._renderLists && page._renderLists[key]
  if (!state || state.limit >= state.items.length) return
  const nextLimit = Math.min(state.items.length, state.limit + PAGE_SIZE)
  const patch = {}
  for (let index = state.limit; index < nextLimit; index += 1) {
    patch[`${key}[${index}]`] = state.items[index]
  }
  state.limit = nextLimit
  page.setData(patch)
}

function cancelProgressiveModel(page) {
  const task = page._progressiveModel
  if (task && task.timer) clearTimeout(task.timer)
  page._progressiveModel = null
}

// Multi-section statements must keep every section and their full totals. Yield
// between bridge updates instead of requiring a scroll past later sections.
function setProgressiveModel(page, model, fields) {
  cancelProgressiveModel(page)
  const initial = Object.assign({}, model)
  const offsets = {}
  fields.forEach(key => {
    const previous = page.data[key] || []
    const visible = model[key].slice(0, Math.max(PAGE_SIZE, previous.length))
    offsets[key] = visible.length
    // Preserve scroll position and avoid resending an unchanged rendered section.
    if (JSON.stringify(previous) === JSON.stringify(visible)) delete initial[key]
    else initial[key] = visible
  })
  const task = { timer: null }
  page._progressiveModel = task
  function append() {
    if (page._progressiveModel !== task) return
    const patch = {}
    fields.forEach(key => {
      const limit = Math.min(model[key].length, offsets[key] + PAGE_SIZE)
      for (let index = offsets[key]; index < limit; index += 1) patch[`${key}[${index}]`] = model[key][index]
      offsets[key] = limit
    })
    if (!Object.keys(patch).length) { page._progressiveModel = null; return }
    page.setData(patch, schedule)
  }
  function schedule() {
    if (page._progressiveModel !== task) return
    if (fields.every(key => offsets[key] >= model[key].length)) { page._progressiveModel = null; return }
    task.timer = setTimeout(append, 0)
  }
  page.setData(initial, schedule)
}

module.exports = { PAGE_SIZE, setProgressiveList, appendProgressiveList, setProgressiveModel, cancelProgressiveModel }
