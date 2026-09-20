function getEnvironmentVersion() {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') return ''
  try {
    const account = wx.getAccountInfoSync()
    return account && account.miniProgram && account.miniProgram.envVersion || ''
  } catch (error) {
    return ''
  }
}

function canShowDeveloperTools(identity) {
  return Boolean(identity && identity.role === 'admin' && getEnvironmentVersion() === 'develop')
}

module.exports = { getEnvironmentVersion, canShowDeveloperTools }
