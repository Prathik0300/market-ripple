// Data sources with no usable API for other apps but an official MCP server, the AI apps a user can add them
// to, and what Market Ripple itself may call on each one. Market Ripple only ever calls the tools in `read`;
// anything else a server offers (orders, transfers, alerts, watchlist edits) is refused in code.
import servers from "../../supabase/functions/_shared/mcp-servers.json";

export type McpServer = {
  id: string;
  name: string;
  url: string;
  docs: string;
  what: string;
  why: string;                     // why MCP and not an API
  auth: string;
  ripple: boolean;                 // can connect to Market Ripple itself (needs self-registration + PKCE)
  scope?: string;                  // OAuth scope to ask for, when the server's default would include writes
  rippleNote?: string;
  read: string[];                  // the only tools Market Ripple will call
  pulls: { tool: string; args?: Record<string, unknown>; label: string }[];   // what the 2-hourly job collects
  caution?: string;
};

// One list for the web app and the cloud pull (supabase/functions/mcp-sync), so both enforce the same read tools.
export const SERVERS = servers as McpServer[];

// ------------------------------------------------------------------ AI apps a user can add a server to

export type Client = { id: string; name: string; steps: (s: McpServer) => { text: string; code?: string }[] };

const slug = (s: McpServer) => s.id;

export const CLIENTS: Client[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    steps: (s) => [
      { text: "In Claude, open Settings › Connectors and click Add connector (Claude labels it “Add custom connector”). Name it " + s.name + " and paste the connector address:", code: s.url },
      { text: `Click Connect, then approve on the ${s.name} sign-in page that opens.` },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    steps: (s) => [
      { text: "Add it (user scope, so every project can use it):", code: `claude mcp add --transport http --scope user ${slug(s)} ${s.url}` },
      { text: `Start claude, type /mcp, pick ${slug(s)} and choose Authenticate. Approve the ${s.name} sign-in in your browser.` },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: (s) => [
      { text: "Add this to ~/.cursor/mcp.json (create the file if it is missing):",
        code: JSON.stringify({ mcpServers: { [slug(s)]: { url: s.url } } }, null, 2) },
      { text: `Open Cursor Settings › MCP (Tools & Integrations), find ${slug(s)} and click Login / Connect. Approve the ${s.name} sign-in.` },
    ],
  },
  {
    id: "vscode",
    name: "VS Code",
    steps: (s) => [
      { text: "Run this in a terminal, or add the same entry under \"servers\" in your user mcp.json:",
        code: `code --add-mcp '${JSON.stringify({ name: slug(s), type: "http", url: s.url })}'` },
      { text: `In Copilot Chat, open the tools menu, start ${slug(s)} and accept the ${s.name} sign-in prompt.` },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    steps: (s) => [
      { text: "Add it:", code: `codex mcp add ${slug(s)} --url ${s.url}` },
      { text: "Sign in (opens your browser):", code: `codex mcp login ${slug(s)}` },
    ],
  },
];

export const CLIENT_IDS = CLIENTS.map((c) => c.id) as [string, ...string[]];
