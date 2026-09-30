import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { UserRound, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import { desktop } from '../services/desktop'
import { minutesText, SIGN_IN_EVENT } from '../services/credits'

/** Sidebar account badge; opens sign-in or the account menu as a centered dialog. */
export function AccountMenu({ model }: { model: AppModel }) {
  const { account, refreshAccount } = model
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [message, setMessage] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    const onRequest = () => { setOpen(true); setMessage('Đăng nhập để bắt đầu ghi và tóm tắt.') }
    window.addEventListener(SIGN_IN_EVENT, onRequest)
    return () => window.removeEventListener(SIGN_IN_EVENT, onRequest)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const show = () => {
    setOpen(true)
    setMessage('')
    void refreshAccount()
  }

  const run = async (action: () => Promise<string>) => {
    setWorking(true)
    setMessage('')
    try { setMessage(await action()) } catch (error) { setMessage(String(error)) } finally { setWorking(false) }
  }

  const sendCode = () => run(async () => {
    await desktop.accountSendCode(email)
    setCodeSent(true)
    return `Đã gửi mã xác nhận tới ${email.trim()}.`
  })

  const verifyCode = () => run(async () => {
    await desktop.accountVerify(email, code)
    setCode('')
    setCodeSent(false)
    await refreshAccount()
    return 'Đã đăng nhập.'
  })

  const signOut = () => run(async () => {
    await desktop.accountSignOut()
    await refreshAccount()
    return 'Đã đăng xuất.'
  })

  // Switching accounts restarts recognition, so it waits until the meeting ends.
  const busy = model.capturing || model.meetingActive
  const disabled = !desktop.isDesktop || working || busy

  return <>
    <button className="worker-badge account-badge" aria-haspopup="dialog" onClick={show} title={model.ready ? 'Sẵn sàng' : 'Đang khởi động'}>
      <div><UserRound size={14}/><strong>{account?.email ?? 'Đăng nhập'}</strong></div>
      <small><span className={`status-dot ${model.ready ? 'ready' : ''}`}/>{account?.email ? minutesText(account.balanceSeconds) : 'Để bắt đầu ghi và tóm tắt'}</small>
    </button>
    {open && createPortal(<div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}><div className="account-popover" role="dialog" aria-modal="true" aria-label="Tài khoản VietNote">
      <button className="account-close" aria-label="Đóng" onClick={() => setOpen(false)}><X size={16}/></button>
      {account?.email ? <>
        <strong>{account.email}</strong>
        <span className="account-minutes">{minutesText(account.balanceSeconds)}</span>
        <small className="muted">Chép lời, dịch và tóm tắt dùng phút của tài khoản.</small>
        <button className="pill-btn" disabled={disabled} onClick={() => void signOut()}>Đăng xuất</button>
      </> : account && !account.configured ? <small className="muted">Bản build này chưa kết nối máy chủ VietNote.</small> : <>
        <strong>Đăng nhập VietNote</strong>
        <small className="muted">Nhập email để nhận mã đăng nhập.</small>
        <input aria-label="Email" type="email" autoComplete="email" spellCheck={false} placeholder="vietnote@gmail.com" value={email} onChange={event => setEmail(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && email.trim() && !disabled) void sendCode() }} disabled={disabled} autoFocus/>
        <button className={`pill-btn ${codeSent ? '' : 'primary'}`} disabled={disabled || !email.trim()} onClick={() => void sendCode()}>{codeSent ? 'Gửi lại mã' : 'Gửi mã'}</button>
        {codeSent && <>
          <input aria-label="Mã xác nhận" inputMode="numeric" autoComplete="one-time-code" placeholder="Nhập mã trong email" value={code} onChange={event => setCode(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && code.trim() && !disabled) void verifyCode() }} disabled={disabled} autoFocus/>
          <button className="pill-btn primary" disabled={disabled || !code.trim()} onClick={() => void verifyCode()}>Đăng nhập</button>
        </>}
      </>}
      {busy && <small className="muted">Kết thúc cuộc họp để đổi tài khoản.</small>}
      {message && <small role="status" className="groq-key-message">{message}</small>}
    </div></div>, document.body)}
  </>
}
