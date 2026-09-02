export function shouldGateNativeSessionTransition(
  previousSessionId: string | null,
  currentSessionId: string | null,
  native: boolean,
): boolean {
  return Boolean(
    native && previousSessionId && previousSessionId !== currentSessionId,
  );
}
