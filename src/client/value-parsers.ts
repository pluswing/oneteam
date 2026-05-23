export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function recordArrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
