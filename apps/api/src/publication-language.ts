/** Short publication follow-ups refer to the existing verified workspace. */
export function shippingFollowup(text: string): { publication: boolean; deployment: boolean } {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const publication = /^(?:please\s+)?(?:ship\s+(?:it|this|the\s+changes)|publish\s+(?:the\s+)?changes|apply\s+(?:those|these|the)\s+fixes\s+to\s+(?:main|master)|make\s+sure\s+(?:everything\s+is|the\s+changes\s+are)\s+in\s+(?:main|master)|get\s+(?:it|this)\s+live)[.!?\s]*$/.test(normalized);
  return { publication, deployment: publication && /\bget\s+(?:it|this)\s+live\b/.test(normalized) };
}

/** Deployment is downstream of publication; tests/build/file checks are not. */
export function prePublicationMissing(missing: string[]): string[] {
  return missing.filter(item => item !== 'publish' && item !== 'deployment');
}
export function deploymentVerified(state: { configured?: boolean; live?: boolean; commitMatches?: boolean; commitSha?: string | null }, expectedSha: string): boolean {
  return state.configured === true && state.live === true && state.commitMatches === true && state.commitSha === expectedSha;
}
