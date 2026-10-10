// Serves downloadable app assets (the read-aloud voice pack) from the private R2 bucket.
// Only files listed here are reachable; Range requests let an interrupted download resume.
const FILES = new Set(['voice-pack-v1.bin'])

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
    const key = new URL(request.url).pathname.slice(1)
    if (!FILES.has(key)) return new Response('Not found', { status: 404 })

    const object = request.method === 'HEAD'
      ? await env.ASSETS.head(key)
      : await env.ASSETS.get(key, { range: request.headers })
    if (!object) return new Response('Not found', { status: 404 })

    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'ETag': object.httpEtag,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    const range = object.range
    if (request.method === 'GET' && range && request.headers.has('Range')) {
      const start = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0)
      const length = range.length ?? (range.suffix ?? object.size - start)
      headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`)
      headers.set('Content-Length', String(length))
      return new Response(object.body, { status: 206, headers })
    }
    headers.set('Content-Length', String(object.size))
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
  },
}
