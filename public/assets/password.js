// 蜂群2计划 P3：修改密码页（首登强制改密的唯一出口）。
import { $, apiFetch } from './ui.js'

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
    const response = await apiFetch('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: $('current').value, newPassword: next }),
    })
    if (response.ok) {
      window.location.href = '/'
      return
    }
    const body = await response.json().catch(() => ({}))
    error.textContent =
      body.error === 'invalid_current_password'
        ? '当前密码不对'
        : body.error === 'password_too_short'
          ? '新密码至少 10 个字符'
          : `修改失败（${response.status}）`
    error.hidden = false
  } catch (err) {
    error.textContent = `无法连接服务器：${err.message}`
    error.hidden = false
  } finally {
    save.disabled = false
    save.textContent = '修改密码'
  }
})
