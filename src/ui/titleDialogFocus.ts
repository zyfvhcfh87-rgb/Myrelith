import type { KeyboardEvent } from 'react'

/** Keep title dialog Tab navigation inside its currently available controls. */
export function containTitleDialogKey(event: KeyboardEvent<HTMLDialogElement>): void {
  event.stopPropagation()
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
  const dialog = event.currentTarget
  const controls = [...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]')]
    .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden],[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); dialog.focus(); return }
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (active === last || active === dialog)) {
    event.preventDefault(); first.focus()
  }
}
