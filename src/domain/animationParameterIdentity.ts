/** Portable declaration identity is data; no installation, permission or runtime state. */
export interface AnimationParameterIdentity {
  version: number
  effectType: string
  descriptorVersion: number
  contributionId: string
  contributionVersion: number
  packageDigest: string
}

const FIELDS = ['version', 'effectType', 'descriptorVersion', 'contributionId', 'contributionVersion', 'packageDigest'] as const

export function animationParameterIdentityError(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Animation parameter identity must be a record.'
  const object = value as Record<string, unknown>
  if (Object.keys(object).length !== FIELDS.length || FIELDS.some((key) => !Object.hasOwn(object, key))) return 'Animation parameter identity requires its exact envelope.'
  for (const field of ['version', 'descriptorVersion', 'contributionVersion'] as const) {
    if (!Number.isSafeInteger(object[field]) || (object[field] as number) < 1) return `Animation identity ${field} must be a positive safe integer.`
  }
  for (const field of ['effectType', 'contributionId', 'packageDigest'] as const) {
    const text = object[field]
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > 256) return `Animation identity ${field} exceeds its string bound.`
  }
  if (object.version === 1 && !/^sha256:[0-9a-f]{64}$/u.test(object.packageDigest as string)) return 'Animation identity requires an exact SHA-256 package digest.'
  return null
}

/** A future identity remains opaque; matching visible strings cannot activate it. */
export function animationParameterIdentityMatches(
  identity: AnimationParameterIdentity | undefined,
  declaration: Omit<AnimationParameterIdentity, 'version'>,
): boolean {
  return identity?.version === 1 && animationParameterIdentityError(identity) === null
    && identity.effectType === declaration.effectType
    && identity.descriptorVersion === declaration.descriptorVersion
    && identity.contributionId === declaration.contributionId
    && identity.contributionVersion === declaration.contributionVersion
    && identity.packageDigest === declaration.packageDigest
}
