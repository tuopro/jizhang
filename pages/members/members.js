const { loadPage, handleMutation, handleAccessError } = require('../../services/page-context')
const { isCloudMode } = require('../../services/repository-instance')

function formatInviteExpiry(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间无效'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function inviteView(invite) {
  return invite ? Object.assign({}, invite, { expiresAtText: formatInviteExpiry(invite.expiresAt) }) : null
}

Page({
  data: {
    members: [], activeMembers: [], currentMemberId: '', isAdmin: false,
    invite: null, inviteLoading: false, unownedClientCount: 0
  },
  onShow() {
    wx.showShareMenu({ menus: ['shareAppMessage'] })
    this.load()
  },
  load() {
    loadPage(this, (repository, tenantId) => {
      const identity = repository.isCloudRepository ? repository.getIdentity() : {
        memberId: 'member_local_admin', displayName: '管理员', role: 'admin'
      }
      const members = repository.listMembers(tenantId).map(item => Object.assign({}, item, {
        roleText: item.role === 'admin' ? '管理员' : '成员',
        statusText: item.status === 'active' ? '正常' : '已停用',
        isCurrent: item.id === identity.memberId
      }))
      const unownedClientCount = repository.listClients(tenantId, { includeInactive: true })
        .filter(item => item.active !== false && !item.ownerMemberId).length
      this.repository = repository
      this.tenantId = tenantId
      this.setData({
        members,
        activeMembers: members.filter(item => item.status === 'active'),
        currentMemberId: identity.memberId,
        isAdmin: identity.role === 'admin',
        invite: null,
        inviteLoading: identity.role === 'admin' && isCloudMode(),
        unownedClientCount
      })
      if (identity.role === 'admin' && isCloudMode()) {
        repository.getActiveMemberInvite().then(invite => {
          this.setData({ invite: inviteView(invite), inviteLoading: false })
        }).catch(error => {
          this.setData({ invite: null, inviteLoading: false })
          if (handleAccessError(error)) return
          wx.showModal({ title: '邀请加载失败', content: error.message || '请稍后重试', showCancel: false })
        })
      }
    })
  },
  createInvite() {
    if (!isCloudMode()) {
      wx.showModal({ title: '仅云端可用', content: '成员邀请必须由正式 ledger 云函数生成。', showCancel: false })
      return
    }
    handleMutation(this.repository.createMemberInvite(), invite => {
      this.setData({ invite: inviteView(invite), inviteLoading: false })
      wx.showModal({
        title: '邀请已生成',
        content: '邀请7天内有效，可供多位同事加入本企业。现在可以分享到公司同事群。',
        showCancel: false
      })
    })
  },
  revokeInvite() {
    const invite = this.data.invite
    if (!invite || !invite.id) return
    wx.showModal({
      title: '作废邀请',
      content: '作废后，聊天中已经分享的旧邀请将永久无法继续加入。',
      confirmText: '确认作废',
      confirmColor: '#c43d3d',
      success: modal => {
        if (!modal.confirm) return
        handleMutation(this.repository.revokeMemberInvite(invite.id), () => {
          this.setData({ invite: null })
          wx.showToast({ title: '邀请已作废' })
        })
      }
    })
  },
  onShareAppMessage() {
    const invite = this.data.invite
    if (!invite) return { title: '企业账本', path: '/pages/index/index' }
    return {
      title: `${invite.enterpriseName}邀请你加入企业账本`,
      path: invite.path
    }
  },
  renameMember(event) {
    const member = this.data.members.find(item => item.id === event.currentTarget.dataset.id)
    if (!member) return
    wx.showModal({
      title: '企业显示姓名', editable: true, placeholderText: '请输入真实姓名或内部常用名',
      content: member.displayName === '未设置' ? '' : member.displayName,
      confirmText: '保存',
      success: modal => {
        if (!modal.confirm) return
        const result = this.repository.updateMemberDisplayName(this.tenantId, {
          confirmed: true, memberId: member.id, displayName: modal.content
        })
        handleMutation(result, () => this.load())
      }
    })
  },
  changeStatus(event) {
    const member = this.data.members.find(item => item.id === event.currentTarget.dataset.id)
    if (!member) return
    if (member.status === 'disabled') {
      this.confirmStatusChange(member, 'active', '')
      return
    }
    const replacements = this.data.activeMembers.filter(item => item.id !== member.id)
    if (member.clientCount || member.openPeriodCount) {
      if (!replacements.length) {
        wx.showModal({ title: '无法停用', content: '该成员仍有负责业务，但当前没有其他有效成员可以接替。', showCancel: false })
        return
      }
      wx.showActionSheet({
        itemList: replacements.map(item => `转移给 ${item.displayName}`),
        success: result => this.confirmStatusChange(member, 'disabled', replacements[result.tapIndex].id)
      })
      return
    }
    this.confirmStatusChange(member, 'disabled', '')
  },
  confirmStatusChange(member, status, replacementMemberId) {
    const restoring = status === 'active'
    const transferText = replacementMemberId ? '\n其负责的客户和未结账期会一并转移。' : ''
    wx.showModal({
      title: restoring ? '恢复成员' : '停用成员',
      content: `确认${restoring ? '恢复' : '停用'}“${member.displayName}”吗？${transferText}`,
      confirmText: restoring ? '恢复' : '停用',
      confirmColor: restoring ? '#21865a' : '#c43d3d',
      success: modal => {
        if (!modal.confirm) return
        const result = this.repository.setMemberStatus(this.tenantId, {
          confirmed: true, memberId: member.id, status, replacementMemberId
        })
        handleMutation(result, () => this.load())
      }
    })
  },
  assignLegacyClients() {
    wx.showModal({
      title: '补负责人',
      content: `将${this.data.unownedClientCount}个未设置负责人的旧客户及其未结账期，明确指定给当前管理员。此操作会写入审计记录。`,
      confirmText: '确认指定',
      success: modal => {
        if (!modal.confirm) return
        const result = this.repository.assignUnownedClients(this.tenantId, {
          confirmed: true, memberId: this.data.currentMemberId, includeOpenPeriods: true
        })
        handleMutation(result, value => {
          wx.showToast({ title: `已指定${value.assignedCount}个` })
          this.load()
        })
      }
    })
  }
})
