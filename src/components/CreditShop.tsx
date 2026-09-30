import { useEffect, useState } from 'react'
import { desktop, type CreditOffer } from '../services/desktop'
import { hoursText, purchaseError, vnd } from '../services/credits'

const POLL_MS = 4000
const WAIT_LIMIT_MS = 35 * 60 * 1000

/** Credit packages in the account dialog; pays with payOS in the browser and waits for the credit. */
export function CreditShop({ onPaid }: { onPaid: () => unknown }) {
  const [offers, setOffers] = useState<CreditOffer[] | null>(null)
  const [order, setOrder] = useState<{ code: number; offer: CreditOffer; since: number } | null>(null)
  const [message, setMessage] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    desktop.accountOffers().then(setOffers).catch(error => { setOffers([]); setMessage(purchaseError(error)) })
  }, [])

  useEffect(() => {
    if (!order) return
    const timer = window.setInterval(async () => {
      if (Date.now() - order.since > WAIT_LIMIT_MS) { setOrder(null); setMessage('Hết thời gian chờ thanh toán.'); return }
      const result = await desktop.accountOrderStatus(order.code).catch(() => null)
      if (result?.status === 'paid') {
        setOrder(null)
        setMessage(`Đã cộng ${hoursText(Number(order.offer.hours) + Number(order.offer.bonus_hours))} vào tài khoản. Cảm ơn bạn!`)
        onPaid()
      } else if (result?.status === 'cancelled') {
        setOrder(null)
        setMessage('Thanh toán đã huỷ.')
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [order, onPaid])

  const buy = async (offer: CreditOffer) => {
    setWorking(true)
    setMessage('')
    try { setOrder({ code: await desktop.accountBuy(offer.id), offer, since: Date.now() }) }
    catch (error) { setMessage(purchaseError(error)) }
    finally { setWorking(false) }
  }

  if (order) return <div className="credit-shop">
    <div className="credit-waiting"><span className="status-dot ready"/>Đang chờ thanh toán {order.offer.name}…</div>
    <small className="muted">Trang thanh toán payOS đã mở trong trình duyệt. Quét mã QR bằng app ngân hàng, số phút sẽ được cộng tự động.</small>
    <button className="pill-btn" onClick={() => setOrder(null)}>Chọn gói khác</button>
  </div>

  return <div className="credit-shop">
    <strong className="credit-shop-title">Mua thêm giờ</strong>
    {offers === null && <small className="muted">Đang tải bảng giá…</small>}
    {offers?.map(offer => <button key={offer.id} className={`credit-offer ${offer.highlight ? 'highlight' : ''}`} disabled={working} onClick={() => void buy(offer)}>
      <span className="credit-offer-main">
        <b>{offer.name}</b>
        <small>{hoursText(offer.hours)}{offer.bonus_hours > 0 && <em> + tặng {hoursText(offer.bonus_hours)}</em>}</small>
        {offer.promo_label && <span className="credit-badge">{offer.promo_label}</span>}
      </span>
      <span className="credit-offer-price">
        {offer.original_price_vnd && <s>{vnd(offer.original_price_vnd)}</s>}
        <b>{vnd(offer.price_vnd)}</b>
      </span>
    </button>)}
    {message && <small role="status" className="groq-key-message">{message}</small>}
  </div>
}
