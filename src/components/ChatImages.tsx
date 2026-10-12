import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { imageFiles, MAX_CHAT_IMAGES, prepareImage, type ChatImage } from '../services/chatImages'

/** Screenshots waiting to be sent with the next question: paste, drop or pick them. */
export function useChatImages() {
  const [images, setImages] = useState<ChatImage[]>([])
  const [error, setError] = useState('')
  const add = async (files: File[]) => {
    if (!files.length) return
    setError('')
    const room = MAX_CHAT_IMAGES - images.length
    if (room <= 0) { setError(`Tối đa ${MAX_CHAT_IMAGES} ảnh cho một câu hỏi.`); return }
    try {
      const prepared = await Promise.all(files.slice(0, room).map(prepareImage))
      setImages(previous => [...previous, ...prepared].slice(0, MAX_CHAT_IMAGES))
      if (files.length > room) setError(`Tối đa ${MAX_CHAT_IMAGES} ảnh cho một câu hỏi.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  return {
    images, error,
    remove: (id: string) => { setError(''); setImages(previous => previous.filter(image => image.id !== id)) },
    clear: () => { setError(''); setImages([]) },
    add,
    /** On the text box: a pasted image is attached; pasted text goes in as usual. */
    onPaste: (event: ClipboardEvent) => {
      const files = imageFiles(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      void add(files)
    },
    onDragOver: (event: DragEvent) => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault() },
    onDrop: (event: DragEvent) => {
      const files = imageFiles(event.dataTransfer)
      if (!files.length) return
      event.preventDefault()
      void add(files)
    },
  }
}
export type ChatImagesState = ReturnType<typeof useChatImages>

/** Thumbnails above the text box, each with a remove button. */
export function ChatImageTray({ state }: { state: ChatImagesState }) {
  if (!state.images.length && !state.error) return null
  return <div className="chat-image-tray">
    {state.images.map((image, index) => <figure key={image.id}>
      <img src={image.thumb} alt={`Ảnh ${index + 1}`}/>
      <button type="button" onClick={() => state.remove(image.id)} aria-label={`Bỏ ảnh ${index + 1}`}><X size={12}/></button>
    </figure>)}
    {state.error && <small role="alert">{state.error}</small>}
  </div>
}

/** Opens the file picker; pasting a screenshot (⌘V / Ctrl+V) works without it. */
export function AttachImageButton({ state, disabled }: { state: ChatImagesState; disabled?: boolean }) {
  const picker = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" className="chat-attach" disabled={disabled} onClick={() => picker.current?.click()} title="Đính kèm ảnh · hoặc dán ảnh chụp màn hình vào ô hỏi" aria-label="Đính kèm ảnh"><ImagePlus size={17}/></button>
    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
      onChange={event => { void state.add([...(event.target.files ?? [])]); event.target.value = '' }}/>
  </>
}

/** Thumbnails of the screenshots a question was sent with. */
export function MessageImages({ images }: { images?: string[] }) {
  if (!images?.length) return null
  return <div className="chat-message-images">{images.map((src, index) => <img key={index} src={src} alt={`Ảnh đính kèm ${index + 1}`}/>)}</div>
}
