// Buying credit with payOS.
//   POST {action:"offers"}                 -> {offers}
//   POST {action:"create", package_id}     -> {order_code, checkout_url}
//   POST {action:"status", order_code}     -> {status, balance_seconds}
// The webhook normally marks orders paid; "status" also asks payOS directly,
// so a missed webhook still credits the user while the app is waiting.
import { admin, json } from '../_shared/credits.ts'
import { createPaymentLink, paymentInfo } from '../_shared/payos.ts'

const SITE_URL = (Deno.env.get('SITE_URL') || 'https://vietnote.pages.dev').replace(/\/$/, '')

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const db = admin()
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const { data: auth, error: authError } = await db.auth.getUser(token)
  if (authError || !auth.user) return json({ error: 'unauthorized' }, 401)
  const user = auth.user
  const body = await request.json().catch(() => ({})) as { action?: string; package_id?: string; order_code?: number }

  if (body.action === 'offers') {
    const { data, error } = await db.rpc('credit_offers')
    if (error) return json({ error: 'offers_failed' }, 500)
    return json({ offers: data })
  }

  if (body.action === 'create') {
    const { data: offers } = await db.rpc('credit_offers')
    const offer = (offers as { id: string; name: string; hours: number; bonus_hours: number; price_vnd: number }[] | null)
      ?.find(item => item.id === body.package_id)
    if (!offer) return json({ error: 'unknown_package' }, 404)
    // Unique, below 2^53, and its last 7 digits make a short transfer note.
    const orderCode = Date.now() * 100 + Math.floor(Math.random() * 100)
    const seconds = Math.round((Number(offer.hours) + Number(offer.bonus_hours)) * 3600)
    const { error } = await db.from('credit_orders').insert({
      order_code: orderCode, user_id: user.id, package_id: offer.id, amount_vnd: offer.price_vnd, seconds,
    })
    if (error) return json({ error: 'order_failed' }, 500)
    try {
      const link = await createPaymentLink({
        orderCode, amount: offer.price_vnd, description: `VN${orderCode % 10_000_000}`, itemName: offer.name,
        buyerEmail: user.email, returnUrl: `${SITE_URL}/thanh-toan`, cancelUrl: `${SITE_URL}/thanh-toan`,
      })
      await db.from('credit_orders').update({ payment_link_id: link.paymentLinkId, checkout_url: link.checkoutUrl }).eq('order_code', orderCode)
      return json({ order_code: orderCode, checkout_url: link.checkoutUrl })
    } catch (err) {
      console.error(err)
      await db.from('credit_orders').update({ status: 'cancelled' }).eq('order_code', orderCode)
      return json({ error: 'payment_unavailable' }, 502)
    }
  }

  if (body.action === 'status') {
    const { data: order } = await db.from('credit_orders').select('order_code, status')
      .eq('order_code', body.order_code ?? 0).eq('user_id', user.id).maybeSingle()
    if (!order) return json({ error: 'unknown_order' }, 404)
    let status = order.status as string
    if (status === 'pending') {
      try {
        const info = await paymentInfo(order.order_code)
        if (info.status === 'PAID') {
          await db.rpc('pay_credit_order', { p_order: order.order_code, p_amount: info.amountPaid, p_reference: info.transactions?.[0]?.reference ?? null })
          status = 'paid'
        } else if (info.status === 'CANCELLED' || info.status === 'EXPIRED') {
          await db.from('credit_orders').update({ status: 'cancelled' }).eq('order_code', order.order_code).eq('status', 'pending')
          status = 'cancelled'
        }
      } catch (err) { console.error(err) }
    }
    const { data: profile } = await db.from('profiles').select('balance_seconds').eq('id', user.id).single()
    return json({ status, balance_seconds: profile?.balance_seconds ?? null })
  }

  return json({ error: 'unknown_action' }, 400)
})
