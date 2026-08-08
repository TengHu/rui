/**
 * sandbox-read tool - Read file from sandbox filesystem
 *
 * Re-export from sandbox-io.ts for MCP server tool registration.
 * The MCP server expects each tool in its own file with { tool, handler } exports.
 */
export { readFileTool as tool, readFileHandler as handler } from "./sandbox-io.js";
