import { formatProviderError, normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";

export function nativeHttpError(status: number, body?: string, prefix?: string): string {
  const error = Object.assign(new Error(`${status} status code (no body)`), { status, body });
  return formatProviderError(normalizeProviderError(error), prefix);
}
