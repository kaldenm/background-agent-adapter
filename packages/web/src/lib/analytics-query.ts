import { buildServerPath } from "./server-query";

export function buildAnalyticsSummaryPath(searchParams: URLSearchParams): string {
  return buildServerPath("/analytics/summary", searchParams, ["days"]);
}

export function buildAnalyticsTimeseriesPath(searchParams: URLSearchParams): string {
  return buildServerPath("/analytics/timeseries", searchParams, ["days"]);
}

export function buildAnalyticsBreakdownPath(searchParams: URLSearchParams): string {
  return buildServerPath("/analytics/breakdown", searchParams, ["days", "by"]);
}
