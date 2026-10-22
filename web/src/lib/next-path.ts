// Where sign-in may send someone afterwards. Only these exact shapes, so a crafted link can never redirect off-site:
//   /auth/reset                                 finishing a password reset
//   /oauth/consent?authorization_id=<id>        an AI app asking to connect (the platform MCP server)
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw === "/auth/reset") return raw;
  return /^\/oauth\/consent\?authorization_id=[A-Za-z0-9_-]{8,128}$/.test(raw) ? raw : null;
}
