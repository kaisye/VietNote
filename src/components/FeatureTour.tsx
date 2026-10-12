import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, BookOpen, FileAudio, Languages, MessageCircleQuestion, PanelTop, Sparkles, X } from 'lucide-react'
import type { AppModel } from '../hooks/useAppModel'
import type { Page } from '../services/types'
import { isMac, shortcutLabel } from '../services/island'
import { audioOptions, languageOptions } from './MeetingControls'

type Guide = { steps: string[]; action: { label: string; run: () => void; disabled?: boolean } }
type Feature = { Icon: typeof Sparkles; title: string; text: string; page?: Page; guide?: Guide }

/** What VietNote does, shown on the start screen. A card opens its page, or a short how-to. */
export function FeatureTour({ model, setPage }: { model: AppModel; setPage: (page: Page) => void }) {
  const [open, setOpen] = useState<Feature | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const source = audioOptions.find(option => option.value === model.audioInput)?.label ?? ''
  const language = languageOptions.find(option => option.value === model.sourceLanguage)?.label
  const go = (page: Page) => { setOpen(null); setPage(page) }
  const features: Feature[] = [
    { Icon: Sparkles, title: 'Tóm tắt trực tiếp', text: 'Ghi lời theo từng người nói, rút ra ý chính, quyết định và việc cần làm ngay trong cuộc họp.', guide: {
      steps: [
        `Bấm “Bắt đầu tóm tắt”. VietNote ghi ${source.toLowerCase()}; đổi nguồn trong Cài đặt.`,
        'Bản ghi hiện ở cột trái theo từng người nói, bản tóm tắt bên phải tự cập nhật. Bấm “Cập nhật tóm tắt” để làm mới ngay.',
        'Bấm “Kết thúc & lưu”: VietNote gợi ý tên và lưu thành ghi chú có ý chính, quyết định và việc cần làm.',
      ],
      action: { label: 'Bắt đầu tóm tắt', run: () => { setOpen(null); void model.startMeeting() }, disabled: !model.canStartMeeting || model.busy },
    } },
    { Icon: Languages, title: 'Phiên dịch - lồng tiếng', text: 'Tự nhận diện tiếng Anh, tiếng Trung, dịch ngay khi đang nói và đọc to bản dịch bằng giọng tiếng Việt.', page: 'translate' },
    { Icon: MessageCircleQuestion, title: 'Hỏi về cuộc họp', text: 'Bôi đen một đoạn bản ghi hoặc hỏi bất cứ điều gì về nội dung vừa nghe.', guide: {
      steps: [
        'Trong lúc họp, bôi đen một đoạn bản ghi hoặc tóm tắt rồi bấm “Hỏi AI” hiện ngay cạnh đoạn đó.',
        'Hoặc gõ câu hỏi vào khung hỏi đáp ở cuối bản ghi, ví dụ “Họ vừa chốt điều gì?”.',
        'Đang ở ứng dụng khác: bấm ' + shortcutLabel + ' để hỏi ngay trên island.',
        'Với cuộc họp đã lưu: mở ghi chú và bấm “Hỏi về cuộc họp này”.',
      ],
      action: { label: 'Mở ghi chú', run: () => go('notes') },
    } },
    { Icon: PanelTop, title: 'Phụ đề trên mọi ứng dụng', text: isMac ? 'Island ở notch hiện bản ghi và bản dịch, kể cả khi xem video toàn màn hình.' : 'Island ở cạnh trên màn hình hiện bản ghi và bản dịch, kể cả khi xem video toàn màn hình.', guide: {
      steps: [
        'Bật “Hiện island” trong Cài đặt → VietNote Island.',
        `Island nằm ${isMac ? 'ở notch' : 'giữa cạnh trên màn hình'}. Bấm “Bắt đầu nghe” trên island: VietNote ghi âm thanh máy, không cần mở cửa sổ chính.`,
        'Rê chuột vào island để chọn nguồn âm thanh. Nhấp đúp để chuyển sang dạng phụ đề, kéo để đặt ở góc màn hình.',
        `Bấm ${shortcutLabel} để hỏi về những gì đang nghe.`,
      ],
      action: { label: 'Cài đặt island', run: () => go('settings') },
    } },
    { Icon: FileAudio, title: 'Dịch file & link', text: 'Biến video, podcast hay file ghi âm thành phụ đề, biên bản hoặc bài viết.', page: 'file' },
    { Icon: BookOpen, title: 'Ghi chú theo lịch', text: 'Mọi cuộc họp được lưu theo ngày, tìm lại nhanh và xuất ra file khi cần.', page: 'notes' },
  ]

  return <section className="feature-tour" aria-label="Tính năng chính">
    <div className="feature-grid">{features.map(feature => {
      const { Icon, title, text, page } = feature
      return <button type="button" key={title} className="glass-card feature-card" onClick={() => page ? setPage(page) : setOpen(feature)} aria-haspopup={page ? undefined : 'dialog'}>
        <span className="feature-icon"><Icon size={18}/></span>
        <strong>{title}<ArrowRight size={14} className="feature-go"/></strong>
        <p>{text}</p>
        <small className="feature-hint">{page ? 'Mở trang' : 'Xem cách dùng'}</small>
      </button>
    })}</div>
    <p className="feature-defaults">Ghi {source.toLowerCase()} · {language}{model.sourceLanguage !== 'vi' && !model.translateForeign ? ' · không dịch' : ''}<button type="button" onClick={() => setPage('settings')}>Thay đổi</button></p>
    {/* On the body: the page's entrance animation would otherwise confine the overlay to the page. */}
    {open?.guide && createPortal(<div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(null) }}>
      <div className="app-dialog feature-guide" role="dialog" aria-modal="true" aria-label={`Cách dùng: ${open.title}`}>
        <div className="feature-guide-head"><span className="feature-icon"><open.Icon size={18}/></span><h2>{open.title}</h2><button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label="Đóng"><X size={16}/></button></div>
        <ol>{open.guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
        <div className="dialog-actions"><button type="button" className="pill-btn" onClick={() => setOpen(null)}>Đóng</button><button type="button" className="pill-btn primary" autoFocus disabled={open.guide.action.disabled} onClick={open.guide.action.run}>{open.guide.action.label}</button></div>
      </div>
    </div>, document.body)}
  </section>
}
