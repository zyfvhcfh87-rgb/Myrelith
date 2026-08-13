export const EXPECTED_MOTION_RESEARCH_FIXTURE_VERSION = 'issue-44-synthetic-v2'
export const EXPECTED_MOTION_ANALYSIS_ALGORITHM_VERSION = 'similarity-block-ransac-v3'

export function assertMotionResearchProvenance(evidence) {
  if (
    evidence?.fixtureVersion !== EXPECTED_MOTION_RESEARCH_FIXTURE_VERSION
    || evidence?.algorithmVersion !== EXPECTED_MOTION_ANALYSIS_ALGORITHM_VERSION
  ) {
    throw new Error(
      'Motion-analysis evidence provenance did not match the runner contract: '
        + `expected ${EXPECTED_MOTION_RESEARCH_FIXTURE_VERSION} / `
        + `${EXPECTED_MOTION_ANALYSIS_ALGORITHM_VERSION}`,
    )
  }
}
