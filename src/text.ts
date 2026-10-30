/** Shortens long strings so tool output stays small; the marker makes truncation visible. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
