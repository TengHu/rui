/**
 * MCP App Initialization Template
 *
 * This template sets up the App class with proper handler registration.
 * CRITICAL: All handlers must be registered BEFORE calling app.connect()
 */
import { App } from "@modelcontextprotocol/ext-apps";

// Initialize the MCP App
export function createApp(name: string, version: string = "1.0.0") {
  const app = new App({ name, version });

  // === REGISTER HANDLERS BEFORE CONNECT ===

  // Handle tool results (when AI pushes results to app)
  app.ontoolresult = (result) => {
    const text = result.content?.find(c => c.type === "text")?.text;
    console.log("[App] Tool result:", text);
    // TODO: Update UI with result
  };

  // Handle complete tool input (when AI sends full input)
  app.ontoolinput = (params) => {
    console.log("[App] Tool input:", params.name, params.arguments);
    // TODO: Process input and update UI
  };

  // Handle streaming partial input (optional - for progress)
  app.ontoolinputpartial = (params) => {
    // params.arguments contains healed partial JSON
    console.log("[App] Partial input:", params.arguments);
    // TODO: Show progress/preview
  };

  // Handle cancellation
  app.ontoolcancelled = () => {
    console.log("[App] Tool cancelled");
    // TODO: Reset UI state
  };

  // Connect to host (AFTER all handlers registered)
  app.connect();

  return app;
}

/**
 * Helper to call a server-side tool
 *
 * @example
 * const result = await callTool(app, "sandbox-read", { path: "/home/user/file.txt" });
 * const content = extractText(result);
 */
export async function callTool(
  app: App,
  name: string,
  args: Record<string, unknown> = {}
) {
  try {
    const result = await app.callServerTool({ name, arguments: args });
    return result;
  } catch (error) {
    console.error(`[App] Tool call failed: ${name}`, error);
    throw error;
  }
}

/**
 * Extract text content from tool result
 */
export function extractText(result: { content?: Array<{ type: string; text?: string }> }): string | null {
  return result.content?.find(c => c.type === "text")?.text ?? null;
}

/**
 * Extract structured content from tool result
 */
export function extractStructured<T>(result: { structuredContent?: unknown }): T | null {
  return (result.structuredContent as T) ?? null;
}
