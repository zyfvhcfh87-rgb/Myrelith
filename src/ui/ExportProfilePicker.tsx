/** Accessible preset-first editor for one concrete export profile. */

import { useCallback, useEffect, useState, type RefObject } from 'react'
import {
  EXPORT_PRESETS,
  MAX_EXPORT_AUDIO_BITRATE,
  MAX_EXPORT_VIDEO_BITRATE,
  MAX_KEY_FRAME_INTERVAL_MICROSECONDS,
  MIN_EXPORT_AUDIO_BITRATE,
  MIN_EXPORT_VIDEO_BITRATE,
  updateExportProfile,
  type ExportAudioChannelLayout,
  type ExportBitrateMode,
  type ExportContainer,
  type ExportDestination,
  type ExportPresetId,
  type ExportProfile,
  type ExportSelectionId,
  type ExportVideoCodec,
} from '../domain/exportProfile'
import {
  changeExportContainer,
  exportProfileSummary,
  exportVideoCodecLabel,
  presetLabel,
  type ExportUiSelectionId,
} from './exportProfileUi'

export interface ExportPresetAvailability {
  readonly selectionId: ExportSelectionId
  readonly supported: boolean | null
  readonly reason: string | null
  readonly autoPresetId?: ExportPresetId | null
}

interface ExportProfilePickerProps {
  readonly selectionId: ExportUiSelectionId
  readonly profile: Readonly<ExportProfile>
  readonly availability: readonly Readonly<ExportPresetAvailability>[]
  readonly selectedSupported: boolean | null
  readonly selectedReason: string | null
  readonly disabled: boolean
  readonly selectedInputRef: RefObject<HTMLInputElement | null>
  onSelect(selectionId: ExportSelectionId): void
  onChangeProfile(profile: Readonly<ExportProfile>): void
  onDraftValidityChange(valid: boolean): void
}

type NumericFieldId = 'video-bitrate' | 'audio-bitrate' | 'keyframe-interval'

interface NumericSettingProps {
  readonly fieldId: NumericFieldId
  readonly label: string
  readonly accessibleName: string
  readonly title: string
  readonly unit: string
  readonly value: number
  readonly scale: number
  readonly minimum: number
  readonly maximum: number
  readonly step: string
  readonly disabled: boolean
  readonly resetKey: ExportUiSelectionId
  onValidityChange(fieldId: NumericFieldId, valid: boolean): void
  onCommit(value: number): void
}

function NumericSetting({
  fieldId,
  label,
  accessibleName,
  title,
  unit,
  value,
  scale,
  minimum,
  maximum,
  step,
  disabled,
  resetKey,
  onValidityChange,
  onCommit,
}: NumericSettingProps) {
  const [draft, setDraft] = useState(() => String(value / scale))
  const [valid, setValid] = useState(true)
  const messageId = `export-${fieldId}-message`

  useEffect(() => {
    setDraft(String(value / scale))
    setValid(true)
    onValidityChange(fieldId, true)
  }, [disabled, fieldId, onValidityChange, resetKey, scale, value])

  return (
    <label>
      <span>{label}</span>
      <span className="export-input-with-unit">
        <input
          type="number"
          aria-label={accessibleName}
          aria-invalid={!valid}
          aria-describedby={messageId}
          title={title}
          min={minimum / scale}
          max={maximum / scale}
          step={step}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.currentTarget.value
            setDraft(raw)
            const number = Number(raw)
            const integer = Math.round(number * scale)
            const nextValid = raw.trim() !== ''
              && Number.isFinite(number)
              && Number.isSafeInteger(integer)
              && integer >= minimum
              && integer <= maximum
            setValid(nextValid)
            onValidityChange(fieldId, nextValid)
            if (nextValid) onCommit(integer)
          }}
        />
        <small>{unit}</small>
      </span>
      <small
        id={messageId}
        className={`export-field-message${valid ? '' : ' is-invalid'}`}
      >
        {valid
          ? `${minimum / scale}–${maximum / scale} ${unit}`
          : `Enter ${minimum / scale}–${maximum / scale} ${unit}.`}
      </small>
    </label>
  )
}

function statusText(option: Readonly<ExportPresetAvailability>): string {
  if (option.supported === null) return 'Checking support…'
  if (!option.supported) return `Unavailable — ${option.reason ?? 'not supported'}`
  if (option.selectionId === 'auto' && option.autoPresetId) {
    return `Available — selects ${presetLabel(option.autoPresetId)}`
  }
  return 'Available'
}

function optionLabel(selectionId: ExportSelectionId): string {
  return selectionId === 'auto' ? 'Auto' : presetLabel(selectionId)
}

function optionDescription(
  option: Readonly<ExportPresetAvailability>,
): string {
  if (option.selectionId === 'auto') {
    return option.autoPresetId
      ? `Chooses ${presetLabel(option.autoPresetId)} on this browser.`
      : 'Chooses the first supported profile in the documented order.'
  }
  return EXPORT_PRESETS.find((preset) => preset.id === option.selectionId)
    ?.description ?? option.selectionId
}

function videoCodecs(container: ExportContainer): readonly ExportVideoCodec[] {
  return container === 'mp4' ? ['avc', 'hevc'] : ['vp9', 'av1']
}

function audioCodecForContainer(container: ExportContainer): 'aac' | 'opus' {
  return container === 'mp4' ? 'aac' : 'opus'
}

export default function ExportProfilePicker({
  selectionId,
  profile,
  availability,
  selectedSupported,
  selectedReason,
  disabled,
  selectedInputRef,
  onSelect,
  onChangeProfile,
  onDraftValidityChange,
}: ExportProfilePickerProps) {
  const [numericValidity, setNumericValidity] = useState<Readonly<Record<
    NumericFieldId,
    boolean
  >>>({
    'video-bitrate': true,
    'audio-bitrate': true,
    'keyframe-interval': true,
  })
  const markNumericValidity = useCallback((
    fieldId: NumericFieldId,
    valid: boolean,
  ): void => {
    setNumericValidity((current) => current[fieldId] === valid
      ? current
      : { ...current, [fieldId]: valid })
  }, [])
  const numericDraftsValid = Object.values(numericValidity).every(Boolean)

  useEffect(() => {
    onDraftValidityChange(numericDraftsValid)
  }, [numericDraftsValid, onDraftValidityChange])

  const makeCustom = (next: Readonly<ExportProfile>): void => {
    onChangeProfile(next)
  }

  const changeAudioLayout = (layout: ExportAudioChannelLayout): void => {
    if (layout === 'off') {
      makeCustom(updateExportProfile(profile, {
        audioCodec: null,
        audioChannelLayout: 'off',
        audioBitrate: null,
        audioBitrateMode: null,
      }))
      return
    }
    makeCustom(updateExportProfile(profile, {
      audioCodec: audioCodecForContainer(profile.container),
      audioChannelLayout: layout,
      audioBitrate: profile.audioBitrate ?? 192_000,
      audioBitrateMode: profile.audioBitrateMode ?? 'variable',
    }))
  }

  return (
    <div className="export-settings">
      <fieldset className="export-preset-fieldset" disabled={disabled}>
        <legend>Recommended profiles</legend>
        <div className="export-preset-grid">
          {availability.map((option) => {
            const descriptionId = `export-profile-${option.selectionId}-description`
            const unavailable = option.supported === false
            return (
              <label
                key={option.selectionId}
                className={`export-preset-card${
                  selectionId === option.selectionId ? ' is-selected' : ''
                }${unavailable ? ' is-unavailable' : ''}`}
                title={unavailable ? option.reason ?? 'Unavailable' : undefined}
              >
                <input
                  ref={selectionId === option.selectionId
                    ? selectedInputRef
                    : undefined}
                  type="radio"
                  name="export-profile"
                  value={option.selectionId}
                  checked={selectionId === option.selectionId}
                  disabled={disabled || unavailable}
                  aria-describedby={descriptionId}
                  onChange={() => onSelect(option.selectionId)}
                />
                <span className="export-preset-copy">
                  <strong>{optionLabel(option.selectionId)}</strong>
                  <span>{optionDescription(option)}</span>
                  <small
                    id={descriptionId}
                    className={unavailable ? 'is-unavailable' : undefined}
                  >
                    {statusText(option)}
                  </small>
                </span>
              </label>
            )
          })}

          {selectionId === 'custom' && (
            <label className="export-preset-card is-selected">
              <input
                ref={selectedInputRef}
                type="radio"
                name="export-profile"
                value="custom"
                checked
                readOnly
                aria-describedby="export-profile-custom-description"
              />
              <span className="export-preset-copy">
                <strong>Custom</strong>
                <span>{exportProfileSummary(profile)}</span>
                <small
                  id="export-profile-custom-description"
                  className={selectedSupported === false ? 'is-unavailable' : undefined}
                >
                  {selectedSupported === null
                    ? 'Checking support…'
                    : selectedSupported
                      ? 'Available'
                      : `Unavailable — ${selectedReason ?? 'not supported'}`}
                </small>
              </span>
            </label>
          )}
        </div>
      </fieldset>

      <details className="export-advanced">
        <summary>
          <span>Advanced settings</span>
          <small>{selectionId === 'custom' ? 'Custom profile' : 'Edit selected profile'}</small>
        </summary>

        <div className="export-advanced-grid">
          <label>
            <span>Container</span>
            <select
              aria-label="Export container"
              title="Output media container"
              value={profile.container}
              disabled={disabled}
              onChange={(event) => makeCustom(changeExportContainer(
                profile,
                event.currentTarget.value as ExportContainer,
              ))}
            >
              <option value="mp4">MP4</option>
              <option value="webm">WebM</option>
            </select>
          </label>

          <label>
            <span>Video codec</span>
            <select
              aria-label="Export video codec"
              title="Video encoder codec"
              value={profile.videoCodec}
              disabled={disabled}
              onChange={(event) => makeCustom(updateExportProfile(profile, {
                videoCodec: event.currentTarget.value as ExportVideoCodec,
              }))}
            >
              {videoCodecs(profile.container).map((codec) => (
                <option key={codec} value={codec}>
                  {exportVideoCodecLabel({ ...profile, videoCodec: codec })}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Audio</span>
            <select
              aria-label="Export audio channel layout"
              title="Disable audio or encode an explicit mono/stereo layout"
              value={profile.audioChannelLayout}
              disabled={disabled}
              onChange={(event) => changeAudioLayout(
                event.currentTarget.value as ExportAudioChannelLayout,
              )}
            >
              <option value="off">Off</option>
              <option value="mono">Mono</option>
              <option value="stereo">Stereo</option>
            </select>
          </label>

          <label>
            <span>Audio codec</span>
            <select
              aria-label="Export audio codec"
              title="Audio codec required by the selected container"
              value={profile.audioCodec ?? ''}
              disabled={disabled || profile.audioChannelLayout === 'off'}
              onChange={() => undefined}
            >
              {profile.audioChannelLayout === 'off'
                ? <option value="">No audio</option>
                : (
                    <option value={profile.audioCodec}>
                      {profile.audioCodec.toUpperCase()}
                    </option>
                  )}
            </select>
          </label>

          <NumericSetting
            fieldId="video-bitrate"
            label="Video bitrate"
            accessibleName="Export video bitrate in megabits per second"
            title="Video bitrate from 0.1 to 200 megabits per second"
            unit="Mbps"
            value={profile.videoBitrate}
            scale={1_000_000}
            minimum={MIN_EXPORT_VIDEO_BITRATE}
            maximum={MAX_EXPORT_VIDEO_BITRATE}
            step="0.1"
            disabled={disabled}
            resetKey={selectionId}
            onValidityChange={markNumericValidity}
            onCommit={(videoBitrate) => makeCustom(updateExportProfile(
              profile,
              { videoBitrate },
            ))}
          />

          <label>
            <span>Video bitrate mode</span>
            <select
              aria-label="Export video bitrate mode"
              title="Constant or variable video bitrate"
              value={profile.videoBitrateMode}
              disabled={disabled}
              onChange={(event) => makeCustom(updateExportProfile(profile, {
                videoBitrateMode: event.currentTarget.value as ExportBitrateMode,
              }))}
            >
              <option value="variable">Variable</option>
              <option value="constant">Constant</option>
            </select>
          </label>

          <NumericSetting
            fieldId="audio-bitrate"
            label="Audio bitrate"
            accessibleName="Export audio bitrate in kilobits per second"
            title="Audio bitrate from 16 to 512 kilobits per second"
            unit="kbps"
            value={profile.audioBitrate ?? 192_000}
            scale={1_000}
            minimum={MIN_EXPORT_AUDIO_BITRATE}
            maximum={MAX_EXPORT_AUDIO_BITRATE}
            step="1"
            disabled={disabled || profile.audioChannelLayout === 'off'}
            resetKey={selectionId}
            onValidityChange={markNumericValidity}
            onCommit={(audioBitrate) => makeCustom(updateExportProfile(
              profile,
              { audioBitrate },
            ))}
          />

          <label>
            <span>Audio bitrate mode</span>
            <select
              aria-label="Export audio bitrate mode"
              title="Constant or variable audio bitrate"
              value={profile.audioBitrateMode ?? 'variable'}
              disabled={disabled || profile.audioChannelLayout === 'off'}
              onChange={(event) => makeCustom(updateExportProfile(profile, {
                audioBitrateMode: event.currentTarget.value as ExportBitrateMode,
              }))}
            >
              <option value="variable">Variable</option>
              <option value="constant">Constant</option>
            </select>
          </label>

          <NumericSetting
            fieldId="keyframe-interval"
            label="Keyframe interval"
            accessibleName="Export keyframe interval in seconds"
            title="Keyframe interval from 0 to 10 seconds"
            unit="seconds"
            value={profile.keyFrameIntervalMicroseconds}
            scale={1_000_000}
            minimum={0}
            maximum={MAX_KEY_FRAME_INTERVAL_MICROSECONDS}
            step="0.1"
            disabled={disabled}
            resetKey={selectionId}
            onValidityChange={markNumericValidity}
            onCommit={(keyFrameIntervalMicroseconds) => makeCustom(
              updateExportProfile(profile, { keyFrameIntervalMicroseconds }),
            )}
          />

          <label>
            <span>Destination</span>
            <select
              aria-label="Export destination"
              title="Download to memory or stream to a user-selected file"
              value={profile.destination}
              disabled={disabled}
              onChange={(event) => makeCustom(updateExportProfile(profile, {
                destination: event.currentTarget.value as ExportDestination,
              }))}
            >
              <option value="download">Browser download</option>
              <option value="file" disabled>Choose a file (not available yet)</option>
            </select>
          </label>
        </div>
      </details>
    </div>
  )
}
