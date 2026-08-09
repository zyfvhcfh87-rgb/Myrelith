export type LocalAccessMode = 'remember' | 'once'

export type LocalAccessAction =
  | 'Open'
  | 'Import'
  | 'Relink'
  | 'Relink folder'

export const LOCAL_ACCESS_EXPLANATION =
  'Remember access stores a browser-only file or folder permission and its label. WebCut never copies or uploads the file. Use once keeps no reusable access after this session.'

export function localAccessChoiceLabel(
  action: LocalAccessAction,
  mode: LocalAccessMode,
): string {
  return mode === 'remember'
    ? `${action} & remember`
    : `${action} once`
}

export function localAccessChoiceDescription(mode: LocalAccessMode): string {
  return mode === 'remember'
    ? 'Reconnect directly in future sessions when browser permission is still available.'
    : 'Do not save reusable browser permission for this file or folder.'
}
