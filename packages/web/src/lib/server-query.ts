export const DEFAULT_SERVER_QUERY_PARAMS = ["status", "limit", "offset"] as const;

export const SESSION_SERVER_QUERY_PARAMS = [
  ...DEFAULT_SERVER_QUERY_PARAMS,
  "excludeStatus",
] as const;

export function buildServerPath(
  basePath: string,
  searchParams: URLSearchParams,
  allowedQueryParams: readonly string[] = DEFAULT_SERVER_QUERY_PARAMS
): string {
  const forwardedSearchParams = new URLSearchParams();

  for (const key of allowedQueryParams) {
    const values = searchParams.getAll(key);

    for (const value of values) {
      forwardedSearchParams.append(key, value);
    }
  }

  const queryString = forwardedSearchParams.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}
