/** Parse an ISO 8601 duration such as "PT3M45S" or "PT1H2M3.5S" into milliseconds. */
export function isoDurationToMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, d, h, min, s] = m;
  const total = (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return Number.isFinite(total) ? Math.round(total) : undefined;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
