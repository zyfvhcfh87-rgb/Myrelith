import { useEffect, useRef, type ReactNode } from 'react'
import PluginSafeModeCard from './PluginSafeModeCard'
import { usePluginAppSnapshot, usePluginUi } from './PluginUiHooks'

export interface PluginStartupSurfaceProps {
  readonly showCard: boolean
  readonly children: ReactNode
}

export default function PluginStartupSurface({
  showCard,
  children,
}: PluginStartupSurfaceProps) {
  const { controller } = usePluginUi()
  const snapshot = usePluginAppSnapshot()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const reviewRequired = snapshot.startup.mode === 'review-required'

  useEffect(() => {
    if (!reviewRequired) return
    const heading = surfaceRef.current?.querySelector<HTMLElement>('#plugin-safe-mode-heading')
    if (!heading) return
    heading.tabIndex = -1
    heading.focus()
  }, [reviewRequired])

  const card = snapshot.startup.mode === 'safe-mode' ? (
    <PluginSafeModeCard
      startupMode="safe-mode"
      startupReason={snapshot.startup.recommendationReason}
      installedPluginCount={null}
    />
  ) : snapshot.startup.mode === 'review-required' ? (
    <PluginSafeModeCard
      startupMode="review-required"
      startupReason={snapshot.startup.recommendationReason}
      installedPluginCount={null}
      enterSafeModeAction={snapshot.startupActions.enterSafeMode}
      continueReviewedNormalAction={snapshot.startupActions.continueReviewedNormal}
      onEnterSafeMode={() => { void controller.enterSafeMode() }}
      onContinueReviewedNormal={() => {
        void controller.continueWithReviewedNormalStartup()
      }}
    />
  ) : (
    <PluginSafeModeCard
      startupMode="normal"
      startupReason={snapshot.startup.recommendationReason}
      installedPluginCount={null}
      enterSafeModeAction={snapshot.startupActions.enterSafeMode}
      onEnterSafeMode={() => { void controller.enterSafeMode() }}
    />
  )

  return (
    <div ref={surfaceRef} className="plugin-startup-surface">
      {showCard || reviewRequired ? card : null}
      {reviewRequired ? null : children}
    </div>
  )
}
