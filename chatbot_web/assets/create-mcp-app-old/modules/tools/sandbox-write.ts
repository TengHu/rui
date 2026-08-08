/**
 * sandbox-write tool - Write content to a file
 *
 * Re-export from sandbox-io.ts for MCP server tool registration.
 * The MCP server expects each tool in its own file with { tool, handler } exports.
 */
export { writeFileTool as tool, writeFileHandler as handler } from "./sandbox-io.js";
