/**
 * sandbox-list tool - List directory contents
 *
 * Re-export from sandbox-io.ts for MCP server tool registration.
 * The MCP server expects each tool in its own file with { tool, handler } exports.
 */
export { listDirTool as tool, listDirHandler as handler } from "./sandbox-io.js";
