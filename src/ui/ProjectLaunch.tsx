import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  activateResumedProject,
  canRememberProjectFiles,
  canRememberProjectMedia,
  chooseProjectFile,
  chooseProjectMedia,
  connectProjectMedia,
  createNewProject,
  openProjectFile,
  openRecentProject,
  openRecoveryProject,
  returnToProjectHome,
  showNewProject,
  showResumeProject,
} from '../app/projectController'
import {
  discardRecoveryJournal,
  forgetRecentProject,
  refreshProjectLibrary,
} from '../app/projectLibraryController'
import {
  DEFAULT_PROJECT_SETTINGS,
  PROJECT_AUDIO_SAMPLE_RATE_PRESETS,
  PROJECT_FRAME_RATE_PRESETS,
  PROJECT_RESOLUTION_PRESETS,
  type ProjectSettings,
} from '../domain/projectSettings'
import { MAX_PROJECT_NAME_CHARACTERS } from '../domain/projectLimits'
import type { FrameRate } from '../domain/schema'
import { useProjectSessionStore } from '../state/projectSessionStore'
import { useProjectLibraryStore } from '../state/projectLibraryStore'

function rateKey(rate: FrameRate): string {
  return `${rate.num}/${rate.den}`
}

function formatRate(rate: FrameRate): string {
  const decimal = rate.den === 1
    ? String(rate.num)
    : (rate.num / rate.den)
      .toFixed(3)
      .replace(/0+$/, '')
      .replace(/\.$/, '')
  return rate.den === 1
    ? `${decimal} fps`
    : `${decimal} fps (${rate.num}/${rate.den})`
}

function formatLocalTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

function isBusy(phase: string): boolean {
  return phase === 'reading-project'
    || phase === 'relinking'
    || phase === 'activating'
}

function confirmRecoveryDiscard(projectName: string): boolean {
  return window.confirm(
    `Discard the recovery copy for "${projectName}"? This permanently removes its local unsaved safety copies.`,
  )
}

function LaunchFrame({
  children,
  home = false,
}: {
  children: ReactNode
  home?: boolean
}) {
  return (
    <main className="project-launch">
      <section
        className={`project-launch-frame${home ? ' project-launch-frame-home' : ''}`}
      >
        {children}
      </section>
    </main>
  )
}

function HomeScreen() {
  const libraryPhase = useProjectLibraryStore((state) => state.phase)
  const recentSupported = useProjectLibraryStore(
    (state) => state.recentProjectsSupported,
  )
  const recentProjects = useProjectLibraryStore((state) => state.recentProjects)
  const recoveries = useProjectLibraryStore((state) => state.recoveries)
  const libraryError = useProjectLibraryStore((state) => state.error)
  const homeError = useProjectSessionStore((state) => state.error)

  useEffect(() => {
    void refreshProjectLibrary().catch((cause) => {
      console.warn('Could not refresh the local project library', cause)
    })
  }, [])

  const libraryEmpty = libraryPhase !== 'loading'
    && recentProjects.length === 0
    && recoveries.length === 0

  return (
    <LaunchFrame home>
      <div className="project-launch-heading project-launch-heading-home">
        <span className="project-launch-eyebrow">Browser video editor</span>
        <h1>WebCut</h1>
        <p>Start fresh or reconnect a portable project file.</p>
      </div>
      <div className="project-launch-actions" aria-label="Project actions">
        <button
          className="project-launch-card project-launch-card-primary"
          type="button"
          onClick={showNewProject}
        >
          <strong>Create a new project</strong>
          <span>Choose the canvas, frame rate, and audio quality.</span>
        </button>
        <button
          className="project-launch-card"
          type="button"
          onClick={showResumeProject}
        >
          <strong>Resume previous work</strong>
          <span>Open a .webcut file and restore its source media.</span>
        </button>
      </div>
      <section className="project-library" aria-labelledby="project-library-title">
        <header className="project-library-header">
          <div>
            <span className="project-launch-eyebrow">Stored in this browser</span>
            <h2 id="project-library-title">Your projects</h2>
          </div>
          <button
            className="project-library-refresh"
            type="button"
            disabled={libraryPhase === 'loading'}
            onClick={() => void refreshProjectLibrary()}
          >
            Refresh
          </button>
        </header>

        {libraryPhase === 'loading' && (
          <p className="project-library-status" role="status">
            Checking recent projects and recovery copies…
          </p>
        )}
        {(libraryError || homeError) && (
          <p className="project-launch-error" role="alert">
            {homeError ?? libraryError}
          </p>
        )}

        {recoveries.length > 0 && (
          <div className="project-library-group">
            <div className="project-library-group-heading">
              <h3>Recovery copies</h3>
              <span>Unsaved safety copies — never opened automatically</span>
            </div>
            <ul className="project-library-list">
              {recoveries.map((recovery) => (
                <li key={recovery.journalId} data-kind="recovery">
                  <button
                    className="project-library-open"
                    type="button"
                    aria-label={`Recover ${recovery.projectName}`}
                    onClick={() => void openRecoveryProject(recovery.journalId)}
                  >
                    <strong>{recovery.projectName}</strong>
                    <span>
                      {recovery.projectFileName ?? 'Not saved to a .webcut yet'}
                    </span>
                    <time dateTime={new Date(recovery.updatedAt).toISOString()}>
                      Updated {formatLocalTime(recovery.updatedAt)} · {recovery.generationCount} safety {recovery.generationCount === 1 ? 'copy' : 'copies'}
                    </time>
                  </button>
                  <button
                    className="project-library-remove"
                    type="button"
                    aria-label={`Discard recovery for ${recovery.projectName}`}
                    onClick={() => {
                      if (confirmRecoveryDiscard(recovery.projectName)) {
                        void discardRecoveryJournal(recovery.journalId)
                      }
                    }}
                  >
                    Discard
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recentProjects.length > 0 && (
          <div className="project-library-group">
            <div className="project-library-group-heading">
              <h3>Recent projects</h3>
              <span>Shortcuts to files you already chose</span>
            </div>
            <ul className="project-library-list">
              {recentProjects.map((project) => (
                <li key={project.documentId} data-kind="recent">
                  <button
                    className="project-library-open"
                    type="button"
                    aria-label={`Open ${project.projectName}`}
                    onClick={() => void openRecentProject(project.documentId)}
                  >
                    <strong>{project.projectName}</strong>
                    <span>{project.fileName}</span>
                    <time dateTime={new Date(project.lastOpenedAt).toISOString()}>
                      Last used {formatLocalTime(project.lastOpenedAt)} · {project.permission === 'granted' ? 'Ready' : project.permission === 'denied' ? 'Access blocked' : 'Permission may be needed'}
                    </time>
                  </button>
                  <button
                    className="project-library-remove"
                    type="button"
                    aria-label={`Remove ${project.projectName} from Recent`}
                    title="Remove this shortcut only — the .webcut file stays on disk"
                    onClick={() => void forgetRecentProject(project.documentId)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {libraryEmpty && (
          <p className="project-library-empty">
            {recentSupported
              ? 'No recent projects or recovery copies yet.'
              : 'No recovery copies yet. Recent-file shortcuts need Chrome file access.'}
          </p>
        )}
      </section>
    </LaunchFrame>
  )
}

function NewProjectScreen() {
  const phase = useProjectSessionStore((state) => state.phase)
  const error = useProjectSessionStore((state) => state.error)
  const busy = isBusy(phase)
  const [name, setName] = useState('Untitled project')
  const [resolution, setResolution] = useState(
    `${DEFAULT_PROJECT_SETTINGS.width}x${DEFAULT_PROJECT_SETTINGS.height}`,
  )
  const [frameRate, setFrameRate] = useState(
    rateKey(DEFAULT_PROJECT_SETTINGS.frameRate),
  )
  const [audioSampleRate, setAudioSampleRate] = useState(
    String(DEFAULT_PROJECT_SETTINGS.audioSampleRate),
  )

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const selectedResolution = PROJECT_RESOLUTION_PRESETS.find(
      (preset) => `${preset.width}x${preset.height}` === resolution,
    )
    const selectedRate = PROJECT_FRAME_RATE_PRESETS.find(
      (preset) => rateKey(preset) === frameRate,
    )
    const selectedAudioRate = Number(audioSampleRate)
    if (!selectedResolution || !selectedRate) return
    const settings: ProjectSettings = {
      ...selectedResolution,
      frameRate: { ...selectedRate },
      audioSampleRate: selectedAudioRate,
    }
    void createNewProject(name, settings)
  }

  return (
    <LaunchFrame>
      <div className="project-launch-heading">
        <span className="project-launch-eyebrow">New project</span>
        <h1>Set up your canvas</h1>
        <p>These settings stay exact throughout editing and export.</p>
      </div>
      <form className="project-form" onSubmit={submit}>
        <label className="project-field project-field-wide">
          <span>Project name</span>
          <input
            autoFocus
            type="text"
            value={name}
            maxLength={MAX_PROJECT_NAME_CHARACTERS}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="project-field">
          <span>Resolution</span>
          <select
            value={resolution}
            disabled={busy}
            onChange={(event) => setResolution(event.target.value)}
          >
            {PROJECT_RESOLUTION_PRESETS.map((preset) => (
              <option
                key={`${preset.width}x${preset.height}`}
                value={`${preset.width}x${preset.height}`}
              >
                {preset.width} × {preset.height}
              </option>
            ))}
          </select>
        </label>
        <label className="project-field">
          <span>Frame rate</span>
          <select
            value={frameRate}
            disabled={busy}
            onChange={(event) => setFrameRate(event.target.value)}
          >
            {PROJECT_FRAME_RATE_PRESETS.map((preset) => (
              <option key={rateKey(preset)} value={rateKey(preset)}>
                {formatRate(preset)}
              </option>
            ))}
          </select>
        </label>
        <label className="project-field project-field-wide">
          <span>Audio quality</span>
          <select
            value={audioSampleRate}
            disabled={busy}
            onChange={(event) => setAudioSampleRate(event.target.value)}
          >
            {PROJECT_AUDIO_SAMPLE_RATE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset / 1_000} kHz
              </option>
            ))}
          </select>
        </label>
        {error && <p className="project-launch-error" role="alert">{error}</p>}
        {phase === 'activating' && (
          <p className="project-launch-status" role="status">
            Preparing your project…
          </p>
        )}
        <div className="project-form-actions">
          <button
            className="project-button project-button-secondary"
            type="button"
            disabled={busy}
            onClick={returnToProjectHome}
          >
            Back
          </button>
          <button
            className="project-button project-button-primary"
            type="submit"
            disabled={busy}
          >
            Create project
          </button>
        </div>
      </form>
    </LaunchFrame>
  )
}

function ResumeProjectScreen() {
  const phase = useProjectSessionStore((state) => state.phase)
  const candidate = useProjectSessionStore((state) => state.candidate)
  const error = useProjectSessionStore((state) => state.error)
  const busy = isBusy(phase)
  const mediaHandlePickerAvailable = canRememberProjectMedia()
  const projectHandlePickerAvailable = canRememberProjectFiles()
  const recovering = candidate?.origin === 'recovery'
  const needsPermission = candidate?.assets.some(
    (asset) => asset.status === 'remembered',
  ) ?? false
  const missingCount = candidate?.assets.filter(
    (asset) => asset.status === 'missing',
  ).length ?? 0

  return (
    <LaunchFrame>
      <div className="project-launch-heading">
        <span className="project-launch-eyebrow">
          {recovering ? 'Recovery copy' : 'Resume project'}
        </span>
        <h1>{recovering ? 'Review recovered work' : 'Reconnect your work'}</h1>
        <p>
          {recovering
            ? 'This local safety copy is checked before you choose to restore it.'
            : 'The project is checked before it opens. Missing sources can stay offline and be reconnected later.'}
        </p>
      </div>

      <div className="project-resume-body">
        {projectHandlePickerAvailable ? (
          <button
            className={`project-file-choice${busy ? ' is-disabled' : ''}`}
            aria-label="Choose a WebCut project file"
            type="button"
            disabled={busy}
            onClick={() => void chooseProjectFile()}
          >
            <strong>{candidate ? 'Choose another project file' : 'Choose a .webcut file'}</strong>
            <span>Only a validated portable WebCut project will continue.</span>
          </button>
        ) : (
          <label className={`project-file-choice${busy ? ' is-disabled' : ''}`}>
            <strong>{candidate ? 'Choose another project file' : 'Choose a .webcut file'}</strong>
            <span>Only a validated portable WebCut project will continue.</span>
            <input
              className="project-file-input"
              aria-label="Choose a WebCut project file"
              type="file"
              accept=".webcut"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void openProjectFile(file)
              }}
            />
          </label>
        )}

        {candidate && (
          <section className="project-candidate" aria-label="Project summary">
            <div className="project-candidate-title">
              <div>
                <span>{candidate.projectFileName}</span>
                <h2>{candidate.projectName}</h2>
              </div>
              <strong>
                {candidate.origin === 'recovery'
                  ? 'Recovery ready'
                  : candidate.origin === 'recent'
                    ? 'Recent'
                    : 'Validated'}
              </strong>
            </div>
            <dl className="project-profile">
              <div>
                <dt>Canvas</dt>
                <dd>{candidate.width} × {candidate.height}</dd>
              </div>
              <div>
                <dt>Frame rate</dt>
                <dd>{formatRate(candidate.frameRate)}</dd>
              </div>
              <div>
                <dt>Audio</dt>
                <dd>{candidate.audioSampleRate / 1_000} kHz</dd>
              </div>
            </dl>

            <div className="project-relink-heading">
              <div>
                <h3>Source media</h3>
                <p>
                  {candidate.assets.length === 0
                    ? 'This project does not need any source files.'
                    : needsPermission
                      ? 'WebCut remembers these files. Open the project once to allow access again.'
                      : missingCount > 0
                        ? `${missingCount} source${missingCount === 1 ? '' : 's'} will open offline. You can reconnect them now or from the editor.`
                        : 'Every source is ready. Remembered files reconnect automatically.'}
                </p>
              </div>
              {candidate.assets.length > 0 && (
                mediaHandlePickerAvailable ? (
                  <button
                    className="project-button project-button-secondary project-relink-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void chooseProjectMedia()}
                  >
                    Reconnect files
                  </button>
                ) : (
                  <label className={`project-button project-button-secondary project-relink-button${busy ? ' is-disabled' : ''}`}>
                    Reconnect files
                    <input
                      className="project-file-input"
                      aria-label="Reconnect project source media"
                      type="file"
                      accept="video/*,audio/*,.mp4,.mov,.mkv,.webm"
                      multiple
                      disabled={busy}
                      onChange={(event) => {
                        const files = [...(event.target.files ?? [])]
                        event.target.value = ''
                        if (files.length > 0) void connectProjectMedia(files)
                      }}
                    />
                  </label>
                )
              )}
            </div>

            {candidate.assets.length > 0 && (
              <ul className="project-source-list">
                {candidate.assets.map((asset) => (
                  <li key={asset.id} data-status={asset.status}>
                    <div>
                      <strong>{asset.fileName}</strong>
                      <span>{asset.kind}</span>
                    </div>
                    <span>
                      {asset.status === 'ready'
                        ? 'Ready'
                        : asset.status === 'remembered'
                          ? 'Remembered'
                          : 'Opens offline'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {error && <p className="project-launch-error" role="alert">{error}</p>}
        {phase !== 'idle' && phase !== 'error' && (
          <p className="project-launch-status" role="status">
            {phase === 'reading-project' && 'Checking the project file…'}
            {phase === 'relinking' && 'Checking the selected source media…'}
            {phase === 'activating' && 'Opening the project…'}
          </p>
        )}

        <div className="project-form-actions">
          <button
            className="project-button project-button-secondary"
            type="button"
            disabled={busy}
            onClick={returnToProjectHome}
          >
            Back
          </button>
          <button
            className="project-button project-button-primary"
            type="button"
            disabled={busy || !candidate}
            onClick={() => void activateResumedProject()}
          >
            {needsPermission
              ? recovering ? 'Allow media & recover' : 'Allow media & open'
              : missingCount > 0
                ? recovering
                  ? `Recover with ${missingCount} offline`
                  : `Open with ${missingCount} offline`
                : recovering ? 'Recover project' : 'Open project'}
          </button>
        </div>
      </div>
    </LaunchFrame>
  )
}

export default function ProjectLaunch() {
  const screen = useProjectSessionStore((state) => state.screen)
  if (screen === 'new-project') return <NewProjectScreen />
  if (screen === 'resume') return <ResumeProjectScreen />
  return <HomeScreen />
}
