import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { MagnifyingGlass, X } from '@phosphor-icons/react'
import {
  executeEditorCommand,
  resolveEditorCommands,
  type EditorCommandId,
  type ResolvedEditorCommand,
} from '../app/editorCommands'

interface EditorCommandPaletteProps {
  onClose: () => void
}

function searchableText(command: ResolvedEditorCommand): string {
  return [
    command.label,
    command.description,
    command.category,
    command.shortcut?.label,
    ...command.keywords,
  ].join(' ').toLocaleLowerCase()
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute('disabled') && !element.hidden)
}

export default function EditorCommandPalette({ onClose }: EditorCommandPaletteProps) {
  const [commands] = useState(() => resolveEditorCommands())
  const [query, setQuery] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const resultsId = useId()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleCommands = useMemo(() => (
    normalizedQuery
      ? commands.filter((command) => searchableText(command).includes(normalizedQuery))
      : commands
  ), [commands, normalizedQuery])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const runCommand = (id: EditorCommandId): void => {
    const result = executeEditorCommand(id)
    if (!result.executed) {
      setFeedback(result.reason ?? 'That command is unavailable right now.')
      return
    }
    onClose()
  }

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Command letters must never escape the modal and trigger global edits.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }

    const focusables = dialogRef.current ? focusableElements(dialogRef.current) : []
    if (event.key === 'ArrowDown' && event.target === searchRef.current) {
      event.preventDefault()
      focusables.find((element) => element.dataset.commandId)?.focus()
      return
    }
    if (event.key !== 'Tab' || focusables.length === 0) return

    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="command-palette-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="command-palette-header">
          <div>
            <span className="command-palette-eyebrow">Editor commands</span>
            <h2 id={titleId}>Find a command</h2>
          </div>
          <button
            type="button"
            className="command-palette-close"
            aria-label="Close command palette"
            title="Close command palette (Escape)"
            onClick={onClose}
          >
            <X aria-hidden="true" size={18} weight="bold" />
          </button>
        </div>
        <p id={descriptionId} className="command-palette-description">
          Search WebCut’s existing editing commands. Unavailable commands explain what they need.
        </p>
        <label className="command-palette-search">
          <MagnifyingGlass aria-hidden="true" size={17} />
          <span className="visually-hidden">Search commands</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search commands, tools, or shortcuts"
            aria-controls={resultsId}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setFeedback(null)
            }}
          />
        </label>
        <div className="command-palette-summary" aria-live="polite" aria-atomic="true">
          {visibleCommands.length === 1
            ? '1 command'
            : `${visibleCommands.length} commands`}
        </div>
        <ul id={resultsId} className="command-palette-results">
          {visibleCommands.map((command) => {
            const safeId = command.id.replaceAll('.', '-')
            const description = `command-${safeId}-description`
            const disabledReason = `command-${safeId}-disabled`
            return (
              <li key={command.id}>
                <button
                  type="button"
                  className="command-palette-item"
                  data-command-id={command.id}
                  aria-label={command.label}
                  aria-disabled={!command.enabled}
                  aria-keyshortcuts={command.shortcut?.ariaKeyShortcuts}
                  aria-describedby={command.enabled
                    ? description
                    : `${description} ${disabledReason}`}
                  onClick={() => runCommand(command.id)}
                >
                  <span className="command-palette-item-copy">
                    <span className="command-palette-item-title">
                      {command.label}
                      <span>{command.category}</span>
                    </span>
                    <span id={description}>{command.description}</span>
                    {!command.enabled && (
                      <span id={disabledReason} className="command-palette-disabled-reason">
                        {command.disabledReason}
                      </span>
                    )}
                  </span>
                  {command.shortcut && (
                    <kbd aria-label={`Shortcut: ${command.shortcut.label}`}>
                      {command.shortcut.label}
                    </kbd>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        {visibleCommands.length === 0 && (
          <p className="command-palette-empty">No existing command matches “{query}”.</p>
        )}
        <div className="command-palette-feedback" role="status" aria-live="polite">
          {feedback}
        </div>
      </div>
    </div>
  )
}
