import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowRight,
  CheckCircle,
  DotsThreeVertical,
  FolderOpen,
  PlusCircle,
  ShieldCheck,
} from '@phosphor-icons/react'
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
import { MEDIA_FILE_INPUT_ACCEPT } from '../app/localMediaHandles'
import {
  DEFAULT_PROJECT_ASPECT_RATIO_ID,
  DEFAULT_PROJECT_RESOLUTION_TIER,
  DEFAULT_PROJECT_SETTINGS,
  formatProjectCanvas,
  projectAspectRatioPresetById,
  projectResolutionPresetFor,
  PROJECT_ASPECT_RATIO_PRESETS,
  PROJECT_AUDIO_SAMPLE_RATE_PRESETS,
  PROJECT_FRAME_RATE_PRESETS,
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
  setup = false,
}: {
  children: ReactNode
  home?: boolean
  setup?: boolean
}) {
  const frameClassName = [
    'project-launch-frame',
    home ? 'project-launch-frame-home' : '',
    setup ? 'project-launch-frame-setup' : '',
  ].filter(Boolean).join(' ')

  return (
    <main className="project-launch">
      <section className={frameClassName}>
        {children}
      </section>
      <footer className="project-launch-footer">
        <span>Private by design. Portable by default.</span>
        <nav aria-label="Project information">
          <a href="/privacy/">Privacy</a>
          <a href="/licenses/">Licenses</a>
          <a
            href="https://github.com/zyfvhcfh87-rgb/WebCut"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </nav>
      </footer>
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
      <header className="project-launch-home-nav">
        <div className="project-launch-brand">
          <strong>WebCut</strong>
          <span>Browser video editor</span>
        </div>
        <div className="project-launch-trust">
          <ShieldCheck aria-hidden="true" size={21} weight="regular" />
          <span>Your media stays on this device.</span>
        </div>
      </header>

      <section className="project-launch-hero" aria-labelledby="project-home-title">
        <div className="project-launch-hero-copy">
          <h1 id="project-home-title">
            <span>Your footage.</span>
            <span>Your space.</span>
            <span>Your cut.</span>
          </h1>
          <p>Edit locally in your browser—no upload, no account, no rush.</p>
          <div className="project-launch-actions" aria-label="Project actions">
            <button
              className="project-launch-card project-launch-card-primary"
              type="button"
              onClick={showNewProject}
            >
              <PlusCircle aria-hidden="true" size={28} weight="regular" />
              <strong>Start a new project</strong>
              <ArrowRight
                className="project-launch-card-arrow"
                aria-hidden="true"
                size={21}
                weight="bold"
              />
            </button>
            <button
              className="project-launch-card"
              type="button"
              onClick={showResumeProject}
            >
              <FolderOpen aria-hidden="true" size={27} weight="regular" />
              <strong>Open a project</strong>
            </button>
          </div>
          <ul className="project-launch-capabilities" aria-label="WebCut capabilities">
            <li>Portable .webcut projects</li>
            <li>Any canvas ratio</li>
            <li>Multitrack editing</li>
          </ul>
        </div>

        <figure className="project-launch-story">
          <img
            className="project-launch-story-main"
            src="/landing/coast-main.webp"
            alt="A traveler looking over a rugged coast at dusk"
          />
          <img
            className="project-launch-story-cliffs"
            src="/landing/coast-cliffs.webp"
            alt=""
          />
          <img
            className="project-launch-story-path"
            src="/landing/coast-path.webp"
            alt=""
          />
          <figcaption>From first frame to final cut.</figcaption>
        </figure>
      </section>

      <section className="project-library" aria-labelledby="project-library-title">
        <header className="project-library-header">
          <div>
            <h2 id="project-library-title">Back to your projects</h2>
            <p>Pick up where you left off.</p>
          </div>
          <div className="project-library-header-actions">
            {recoveries.length > 0 && (
              <a className="project-library-recovery-link" href="#recovery-copies">
                <span>Recovery copies</span>
                <small>Local unsaved work</small>
                <ArrowRight aria-hidden="true" size={17} weight="bold" />
              </a>
            )}
            <button
              className="project-library-refresh"
              type="button"
              disabled={libraryPhase === 'loading'}
              onClick={() => void refreshProjectLibrary()}
            >
              Refresh
            </button>
          </div>
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

        {recentProjects.length > 0 && (
          <div className="project-library-group">
            <ul className="project-library-list">
              {recentProjects.map((project, index) => (
                <li key={project.documentId} data-kind="recent">
                  <img
                    className="project-library-thumbnail"
                    src={index % 2 === 0
                      ? '/landing/project-coast.webp'
                      : '/landing/project-city.webp'}
                    alt=""
                  />
                  <button
                    className="project-library-open"
                    type="button"
                    aria-label={`Open ${project.projectName}`}
                    onClick={() => void openRecentProject(project.documentId)}
                  >
                    <span className="project-library-copy">
                      <strong>{project.projectName}</strong>
                      <span>{project.fileName}</span>
                    </span>
                    <time dateTime={new Date(project.lastOpenedAt).toISOString()}>
                      <small>Last edited</small>
                      {formatLocalTime(project.lastOpenedAt)}
                    </time>
                    <span className="project-library-open-action">
                      Open
                      <ArrowRight aria-hidden="true" size={17} weight="bold" />
                    </span>
                  </button>
                  <button
                    className="project-library-remove"
                    type="button"
                    aria-label={`Remove ${project.projectName} from Recent`}
                    title="Remove this shortcut only — the .webcut file stays on disk"
                    onClick={() => void forgetRecentProject(project.documentId)}
                  >
                    <DotsThreeVertical aria-hidden="true" size={20} weight="bold" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {recoveries.length > 0 && (
          <div className="project-library-group" id="recovery-copies">
            <div className="project-library-group-heading">
              <h3>Recovery copies</h3>
              <span>Unsaved safety copies—never opened automatically</span>
            </div>
            <ul className="project-library-list">
              {recoveries.map((recovery, index) => (
                <li key={recovery.journalId} data-kind="recovery">
                  <img
                    className="project-library-thumbnail"
                    src={index % 2 === 0
                      ? '/landing/coast-path.webp'
                      : '/landing/coast-cliffs.webp'}
                    alt=""
                  />
                  <button
                    className="project-library-open"
                    type="button"
                    aria-label={`Recover ${recovery.projectName}`}
                    onClick={() => void openRecoveryProject(recovery.journalId)}
                  >
                    <span className="project-library-copy">
                      <strong>{recovery.projectName}</strong>
                      <span>
                        {recovery.projectFileName ?? 'Not saved to a .webcut yet'}
                      </span>
                    </span>
                    <time dateTime={new Date(recovery.updatedAt).toISOString()}>
                      <small>{recovery.generationCount} safety {recovery.generationCount === 1 ? 'copy' : 'copies'}</small>
                      Updated {formatLocalTime(recovery.updatedAt)}
                    </time>
                    <span className="project-library-open-action project-library-recover-action">
                      Recover
                      <ArrowRight aria-hidden="true" size={17} weight="bold" />
                    </span>
                  </button>
                  <button
                    className="project-library-remove"
                    type="button"
                    aria-label={`Discard recovery for ${recovery.projectName}`}
                    title="Permanently discard this local recovery copy"
                    onClick={() => {
                      if (confirmRecoveryDiscard(recovery.projectName)) {
                        void discardRecoveryJournal(recovery.journalId)
                      }
                    }}
                  >
                    <DotsThreeVertical aria-hidden="true" size={20} weight="bold" />
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
  const [aspectRatioId, setAspectRatioId] = useState(
    DEFAULT_PROJECT_ASPECT_RATIO_ID,
  )
  const [resolutionTier, setResolutionTier] = useState(
    DEFAULT_PROJECT_RESOLUTION_TIER,
  )
  const [frameRate, setFrameRate] = useState(
    rateKey(DEFAULT_PROJECT_SETTINGS.frameRate),
  )
  const [audioSampleRate, setAudioSampleRate] = useState(
    String(DEFAULT_PROJECT_SETTINGS.audioSampleRate),
  )
  const selectedAspectRatio = projectAspectRatioPresetById(aspectRatioId)
  const selectedResolution = projectResolutionPresetFor(
    aspectRatioId,
    resolutionTier,
  )

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const selectedRate = PROJECT_FRAME_RATE_PRESETS.find(
      (preset) => rateKey(preset) === frameRate,
    )
    const selectedAudioRate = Number(audioSampleRate)
    if (!selectedResolution || !selectedRate) return
    const settings: ProjectSettings = {
      width: selectedResolution.width,
      height: selectedResolution.height,
      frameRate: { ...selectedRate },
      audioSampleRate: selectedAudioRate,
    }
    void createNewProject(name, settings)
  }

  return (
    <LaunchFrame setup>
      <header className="project-launch-home-nav project-setup-nav">
        <div className="project-launch-brand">
          <strong>WebCut</strong>
          <span>Browser video editor</span>
        </div>
        <div className="project-launch-trust">
          <ShieldCheck aria-hidden="true" size={21} weight="regular" />
          <span>Your media stays on this device.</span>
        </div>
      </header>

      <div className="project-setup-layout">
        <div className="project-setup-intro">
          <h1>
            <span>Set up</span>
            <span>your <em>canvas</em></span>
          </h1>
          <p>Choose the shape your story needs.</p>
        </div>

        <form className="project-form project-form-setup" onSubmit={submit}>
          <fieldset className="project-ratio-fieldset" disabled={busy}>
            <legend>Choose your canvas shape</legend>
            <div className="project-ratio-grid">
              {PROJECT_ASPECT_RATIO_PRESETS.map((aspectRatio) => {
                const selected = aspectRatio.id === aspectRatioId
                return (
                  <label
                    className={`project-ratio-card${selected ? ' is-selected' : ''}`}
                    key={aspectRatio.id}
                  >
                    <input
                      type="radio"
                      name="aspect-ratio"
                      value={aspectRatio.id}
                      checked={selected}
                      onChange={() => setAspectRatioId(aspectRatio.id)}
                    />
                    <span
                      className="project-ratio-preview"
                      data-ratio={aspectRatio.id}
                    >
                      {aspectRatio.id === DEFAULT_PROJECT_ASPECT_RATIO_ID ? (
                        <img src="/landing/coast-main.webp" alt="" />
                      ) : (
                        <span
                          className="project-ratio-shape"
                          style={{
                            aspectRatio: `${aspectRatio.ratioWidth} / ${aspectRatio.ratioHeight}`,
                          }}
                        />
                      )}
                      {selected && (
                        <CheckCircle
                          className="project-ratio-check"
                          aria-hidden="true"
                          size={27}
                          weight="fill"
                        />
                      )}
                    </span>
                    <strong>
                      {aspectRatio.label} <span>{aspectRatio.ratioLabel}</span>
                    </strong>
                  </label>
                )
              })}
            </div>
          </fieldset>

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
        <label className="project-field project-field-resolution">
          <span>Resolution</span>
          <select
            value={resolutionTier}
            disabled={busy}
            onChange={(event) => {
              const tier = Number(event.target.value)
              if (projectResolutionPresetFor(aspectRatioId, tier)) {
                setResolutionTier(tier as typeof resolutionTier)
              }
            }}
          >
            {selectedAspectRatio?.resolutions.map((preset) => (
              <option
                key={preset.tier}
                value={preset.tier}
              >
                {preset.width} × {preset.height}
              </option>
            ))}
          </select>
        </label>
        <label className="project-field project-field-frame-rate">
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
        <label className="project-field project-field-wide project-field-audio">
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
            <ArrowRight aria-hidden="true" size={18} weight="bold" />
          </button>
        </div>
        </form>
      </div>
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
  const reusableChoiceTarget = candidate ? 'another project file' : '.webcut'
  const ordinaryProjectChoice = projectHandlePickerAvailable
    ? `Quick open ${reusableChoiceTarget}`
    : candidate ? 'Choose another project file' : 'Choose a .webcut file'

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
        <div
          className="project-file-actions"
          role="group"
          aria-label="Project file choices"
        >
          {projectHandlePickerAvailable ? (
            <button
              className={`project-file-choice project-file-choice-remembered${
                busy ? ' is-disabled' : ''
              }`}
              aria-label="Choose & remember a WebCut project file"
              type="button"
              disabled={busy}
              onClick={() => void chooseProjectFile()}
            >
              <strong>Choose &amp; remember {reusableChoiceTarget}</strong>
              <span>
                Add the validated project to Recent for direct reopening.
              </span>
            </button>
          ) : null}
          <label
            className={`project-file-choice${projectHandlePickerAvailable
              ? ' project-file-choice-quick'
              : ''}${busy ? ' is-disabled' : ''}`}
          >
            <strong>{ordinaryProjectChoice}</strong>
            <span>
              {projectHandlePickerAvailable
                ? 'Open once without remembering a browser file handle.'
                : 'Only a validated portable WebCut project will continue.'}
            </span>
            <input
              className="project-file-input"
              aria-label={projectHandlePickerAvailable
                ? 'Quick open a WebCut project file'
                : 'Choose a WebCut project file'}
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
        </div>

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
                <dd>{formatProjectCanvas(candidate.width, candidate.height)}</dd>
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
                      accept={MEDIA_FILE_INPUT_ACCEPT}
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
                      <span>
                        {asset.partialTrackSelection === 'video-only'
                          ? 'video only'
                          : asset.partialTrackSelection === 'audio-only'
                            ? 'audio only'
                            : asset.kind}
                      </span>
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
