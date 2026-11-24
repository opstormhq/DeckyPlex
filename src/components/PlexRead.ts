function isConnectionReset(error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : error;
  return /connection reset by peer|econnreset|remote end closed connection|connection aborted/i.test(String(message));
}

export async function retryPlexRead<T extends { error?: string }>(request: () => Promise<T>): Promise<T> {
  let result;
  try {
    result = await request();
  } catch (error) {
    if (isConnectionReset(error)) return request();
    throw error;
  }
  return result?.error && isConnectionReset(result.error) ? request() : result;
}
