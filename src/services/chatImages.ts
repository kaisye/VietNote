/** Screenshots pasted into a chat: one copy sized for the AI to read, a small one kept with the thread. */
export interface ChatImage { id: string; url: string; thumb: string }

export const MAX_CHAT_IMAGES = 3
/** Long edge sent to the AI: slide text stays legible while the upload stays a few hundred KB. */
const READ_EDGE = 1600
const THUMB_EDGE = 320
export const IMAGE_QUESTION = 'Ảnh này nói gì? Giải thích ngắn gọn và nối với nội dung cuộc họp nếu liên quan.'

export function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter(file => file.type.startsWith('image/'))
}

function draw(image: ImageBitmap, edge: number, quality: number): string {
  const scale = Math.min(1, edge / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')!
  // Transparent screenshots would turn black as JPEG.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

export async function prepareImage(file: Blob): Promise<ChatImage> {
  const image = await createImageBitmap(file).catch(() => { throw new Error('Không đọc được ảnh này.') })
  try {
    return { id: crypto.randomUUID(), url: draw(image, READ_EDGE, 0.85), thumb: draw(image, THUMB_EDGE, 0.7) }
  } finally { image.close() }
}
