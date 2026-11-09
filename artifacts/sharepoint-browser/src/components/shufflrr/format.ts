import { getDownloadShufflrrFileUrl } from "@workspace/api-client-react";

export const SHUFFLRR_STALE_MS = 60_000;

export function fmtSize(n: number) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(s: string) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function downloadHref(id: number) {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base}${getDownloadShufflrrFileUrl(id)}`;
}

export function errorMessage(error: unknown): string {
  const e = error as { data?: { error?: string; requestId?: string } | null; message?: string } | null;
  const msg = e?.data?.error ?? e?.message ?? "Request failed.";
  return e?.data?.requestId ? `${msg} (request-id ${e.data.requestId})` : msg;
}
