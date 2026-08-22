interface PointerButtonEventLike {
  readonly button: number
  readonly ctrlKey: boolean
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const navigatorWithData = navigator as Navigator & {
    userAgentData?: { readonly platform?: string }
  }
  const platform = navigatorWithData.userAgentData?.platform
    ?? navigator.platform
    ?? ''
  return /mac|iphone|ipad|ipod/iu.test(platform)
}

/**
 * Editing gestures accept only the primary button. macOS Ctrl-click is a
 * native secondary click even though browsers report button 0 for its
 * pointerdown, so it must not mutate Timeline state before `contextmenu`.
 */
export function isPrimaryEditingPointer(
  event: PointerButtonEventLike,
): boolean {
  return event.button === 0 && !(event.ctrlKey && isMacPlatform())
}
