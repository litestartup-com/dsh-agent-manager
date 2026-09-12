// 蜂群2计划 P3：修改密码页（首登强制改密的唯一出口）。
import { $, apiJson } from './ui.js'

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const error = $('error')
  error.hidden = true
  const next = $('next').value
  if (next !== $('confirm').value) {
    error.textContent = '两次输入的新密码不一致'
    error.hidden = false
    return
  }
  const save = $('save')
  save.disabled = true
  save.textContent = '保存中…'
  try {
    // 债务 F6:统一 Result 层——错误码映射不变,文案来源换成 r.error/r.detail。
    const r = await apiJson('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: $('current').value, newPassword: next }),
    })
    if (r.ok) {
      window.location.href = '/'
      return
    }
    error.textContent =
      r.error === 'invalid_current_password'
        ? '当前密码不对'
        : r.error === 'password_too_short'
          ? '新密码至少 10 个字符'
          : r.detail
    error.hidden = false
  } catch (err) {
    error.textContent = `无法连接服务器：${err.message}`
    error.hidden = false
  } finally {
    save.disabled = false
    save.textContent = '修改密码'
  }
})
