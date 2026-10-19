import "server-only";
import { SERVERS, type McpServer } from "./mcp-catalog";
import testServer from "../../supabase/functions/_shared/mcp-test-server.json";

// The connectors the API accepts. The pretend broker (scripts/mcp-test-server.mjs) is accepted only when a
// developer sets MCP_TEST_SERVER=1 for a local run; the Connectors page never lists it.
const all = (): McpServer[] => process.env.MCP_TEST_SERVER === "1" ? [...SERVERS, ...(testServer as McpServer[])] : SERVERS;
export const serverById = (id: string) => all().find((s) => s.id === id);
