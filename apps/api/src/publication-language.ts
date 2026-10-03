/** Short publication follow-ups refer to the existing verified workspace. */
export function shippingFollowup(text: string): { publication: boolean; deployment: boolean } {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const publication = /^(?:please\s+)?(?:ship\s+(?:it|this|the\s+changes)|publish\s+(?:the\s+)?changes|apply\s+(?:those|these|the)\s+fixes\s+to\s+(?:main|master)|make\s+sure\s+(?:everything\s+is|the\s+changes\s+are)\s+in\s+(?:main|master)|get\s+(?:it|this)\s+live)[.!?\s]*$/.test(normalized);
  return { publication, deployment: publication && /\bget\s+(?:it|this)\s+live\b/.test(normalized) };
}
