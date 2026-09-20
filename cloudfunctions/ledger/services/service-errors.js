function createServiceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function getServiceErrorCode(error) {
  if (error && error.code) return String(error.code)
  return 'SERVICE_ERROR'
}

module.exports = { createServiceError, getServiceErrorCode }
