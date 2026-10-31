type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Extract only an explicitly named audience from the customer's original text.
 * This is not a market-research inference and does not fill an unnamed audience.
 */
export function explicitAudienceFromIntent(intent: string): string | null {
  const normalized = intent.replace(/\s+/gu, " ").trim();
  const patterns = [
    /(?:面向|针对|目标受众(?:是|为|[:：])?)\s*([^，。；]{1,40}?)(?:的|群体|观众|用户|人群)/u,
    /(?:给|向)([\p{Script=Han}A-Za-z0-9+·/_-]{1,24})(?:看|做|制作|介绍)/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

export function bindExplicitAudienceMetadata(
  metadataValue: RecordValue,
  intent: string,
): { metadata: RecordValue; audience: string | null; changed: boolean } {
  const metadata = structuredClone(metadataValue);
  const audience = explicitAudienceFromIntent(intent);
  if (!audience) return { metadata, audience: null, changed: false };
  const brief = isRecord(metadata.brief) ? metadata.brief : {};
  if (typeof brief.audience === "string" && brief.audience.trim()) {
    return { metadata, audience: brief.audience.trim(), changed: false };
  }
  metadata.brief = { ...brief, audience };
  return { metadata, audience, changed: true };
}
