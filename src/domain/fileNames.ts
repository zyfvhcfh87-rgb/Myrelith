/** Windows-safe file-name pieces shared by export, delivery, project and collect names. */

/** A Windows device name, alone or before any extension ("con", "COM1.txt"). */
export const WINDOWS_RESERVED_FILE_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i

/**
 * Make a file-name stem safe on Windows: invalid and control characters become
 * '-', the stem keeps at most `maxCharacters` code points without trailing dots
 * or spaces, and a device name gains a "myrelith-" prefix. The result may be
 * empty; each caller supplies its own fallback.
 */
export function windowsSafeFileStem(value: string, maxCharacters: number): string {
  let stem = value.replace(/[<>:"/\\|?*]/g, '-')
  stem = Array.from(stem, (character) => (
    character.charCodeAt(0) < 32 ? '-' : character
  )).join('')
  stem = Array.from(stem).slice(0, maxCharacters).join('').replace(/[. ]+$/g, '')
  return WINDOWS_RESERVED_FILE_NAME.test(stem) ? `myrelith-${stem}` : stem
}
