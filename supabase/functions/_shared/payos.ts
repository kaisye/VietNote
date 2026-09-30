// payOS REST client: payment links for credit orders and webhook signatures.
export const PAYOS_API = 'https://api-merchant.payos.vn'

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} secret is not set`)
  return value
}

async function hmac(text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('PAYOS_CHECKSUM_KEY')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// payOS signs `key=value` pairs sorted by key; null becomes an empty string.
function canonical(data: Record<string, unknown>): string {
  return Object.keys(data).sort().filter(key => data[key] !== undefined).map(key => {
    const value = data[key]
    return `${key}=${value === null || value === 'null' || value === 'undefined' ? '' : Array.isArray(value) ? JSON.stringify(value) : value}`
  }).join('&')
}

export async function verifySignature(data: Record<string, unknown>, signature: string): Promise<boolean> {
  const expected = await hmac(canonical(data))
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

function headers() {
  return { 'x-client-id': env('PAYOS_CLIENT_ID'), 'x-api-key': env('PAYOS_API_KEY'), 'Content-Type': 'application/json' }
}

export type PaymentLink = { checkoutUrl: string; paymentLinkId: string; qrCode: string }

export async function createPaymentLink(order: {
  orderCode: number; amount: number; description: string; itemName: string
  returnUrl: string; cancelUrl: string; buyerEmail?: string
}): Promise<PaymentLink> {
  const signature = await hmac(canonical({
    amount: order.amount, cancelUrl: order.cancelUrl, description: order.description,
    orderCode: order.orderCode, returnUrl: order.returnUrl,
  }))
  const response = await fetch(`${PAYOS_API}/v2/payment-requests`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      orderCode: order.orderCode, amount: order.amount, description: order.description,
      items: [{ name: order.itemName, quantity: 1, price: order.amount }],
      buyerEmail: order.buyerEmail, returnUrl: order.returnUrl, cancelUrl: order.cancelUrl,
      expiredAt: Math.floor(Date.now() / 1000) + 30 * 60, signature,
    }),
  })
  const body = await response.json().catch(() => ({})) as { code?: string; desc?: string; data?: PaymentLink }
  if (body.code !== '00' || !body.data) throw new Error(`payOS ${response.status} ${body.code} ${body.desc}`)
  return body.data
}

export type PaymentInfo = { status: string; amountPaid: number; transactions?: { reference?: string }[] }

export async function paymentInfo(orderCode: number): Promise<PaymentInfo> {
  const response = await fetch(`${PAYOS_API}/v2/payment-requests/${orderCode}`, { headers: headers() })
  const body = await response.json().catch(() => ({})) as { code?: string; desc?: string; data?: PaymentInfo }
  if (body.code !== '00' || !body.data) throw new Error(`payOS ${response.status} ${body.code} ${body.desc}`)
  return body.data
}
