import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

interface IndexedTextStyle extends CSSProperties {
  '--project-launch-char-index': number
}

function indexedTextStyle(index: number): IndexedTextStyle {
  return { '--project-launch-char-index': index }
}

function useRevealOnce<T extends HTMLElement>(): {
  ref: RefObject<T | null>
  visible: boolean
} {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  )

  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return undefined

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -8% 0px',
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, visible }
}

export function SplitRevealHeading({
  id,
  lines,
}: {
  id: string
  lines: readonly string[]
}) {
  const reveal = useRevealOnce<HTMLHeadingElement>()
  let charOffset = 0

  return (
    <h1
      ref={reveal.ref}
      id={id}
      className={`project-launch-split-text${reveal.visible ? ' is-visible' : ''}`}
    >
      <span className="project-launch-text-sr-only">{lines.join(' ')}</span>
      <span className="project-launch-split-visual" aria-hidden="true">
        {lines.map((line, lineIndex) => {
          const chars = Array.from(line)
          const lineOffset = charOffset
          charOffset += chars.length + 3
          return (
            <span className="project-launch-headline-line" key={`${lineIndex}-${line}`}>
              {chars.map((char, charIndex) => (
                <span
                  className="project-launch-split-char"
                  key={`${lineIndex}-${charIndex}`}
                  style={indexedTextStyle(lineOffset + charIndex)}
                >
                  {char === ' ' ? '\u00a0' : char}
                </span>
              ))}
            </span>
          )
        })}
      </span>
    </h1>
  )
}

export function FoldRevealTitle({ text }: { text: string }) {
  const reveal = useRevealOnce<HTMLElement>()

  return (
    <strong
      ref={reveal.ref}
      className={`project-launch-fold-title${reveal.visible ? ' is-visible' : ''}`}
    >
      <span className="project-launch-text-sr-only">{text}</span>
      <span className="project-launch-fold-visual" aria-hidden="true">
        {Array.from(text).map((char, index) => (
          <span
            className="project-launch-fold-segment"
            key={`${char}-${index}`}
            style={indexedTextStyle(index)}
          >
            <span className="project-launch-fold-piece">
              {char === ' ' ? '\u00a0' : char}
            </span>
          </span>
        ))}
      </span>
    </strong>
  )
}
