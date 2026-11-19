// 返回路徑僅接受已存在的本站頁面，保留篩選與期間，不形成開放轉址。
export function safePublicReturn(
  value: string | null,
  origin = window.location.origin,
): string {
  if (!value || value.length > 4096) return "/vaults";
  try {
    const url = new URL(value, origin);
    return url.origin === origin &&
      !url.username &&
      !url.password &&
      ["/", "/vaults", "/portfolio", "/portfolios"].includes(
        url.pathname.replace(/\/$/, "") || "/",
      )
      ? url.pathname + url.search + url.hash
      : "/vaults";
  } catch {
    return "/vaults";
  }
}
