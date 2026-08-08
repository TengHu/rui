/**
 * sandbox-exec tool - Execute shell command
 *
 * Re-export from sandbox-io.ts for MCP server tool registration.
 * The MCP server expects each tool in its own file with { tool, handler } exports.
 */
export { execTool as tool, execHandler as handler } from "./sandbox-io.js";
