/** Remaining credit as shown to users, e.g. "Còn 1 giờ 5 phút". */
export function minutesText(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return 'Chưa đọc được số phút'
  if (seconds < 0) return `Đang nợ ${Math.ceil(-seconds / 60)} phút`
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours ? `Còn ${hours} giờ${minutes % 60 ? ` ${minutes % 60} phút` : ''}` : `Còn ${minutes} phút`
}

/** Opens the sign-in dialog of the sidebar account menu. */
export const SIGN_IN_EVENT = 'vietnote:sign-in'
export function requestSignIn() { window.dispatchEvent(new Event(SIGN_IN_EVENT)) }
