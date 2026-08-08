/**
 * MCP App Entry Point
 *
 * This is the main UI logic file. Customize this for your app.
 */
import { createApp, callTool, extractText } from "./app-init.js";

// DOM Elements
const loadingEl = document.getElementById("loading")!;
const errorEl = document.getElementById("error")!;
const contentEl = document.getElementById("content")!;

// Initialize app
const app = createApp("My MCP App", "1.0.0");

// UI State helpers
function showLoading() {
  loadingEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
  contentEl.classList.add("hidden");
}

function showError(message: string) {
  loadingEl.classList.add("hidden");
  errorEl.classList.remove("hidden");
  errorEl.textContent = message;
  contentEl.classList.add("hidden");
}

function showContent() {
  loadingEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
}

// === EXTENSION POINT: APP INITIALIZATION ===
async function init() {
  try {
    // TODO: Load initial data using tools
    // Example:
    // const result = await callTool(app, "sandbox-list", { path: "/home/user/workspace" });
    // const files = JSON.parse(extractText(result) || "[]");

    showContent();
  } catch (error) {
    showError(`Failed to initialize: ${error}`);
  }
}

// === EXTENSION POINT: EVENT HANDLERS ===
// Add event listeners for user interactions
// Example:
// document.getElementById("myButton")?.addEventListener("click", async () => {
//   const result = await callTool(app, "my-tool", { input: "value" });
//   console.log(extractText(result));
// });

// Start the app
init();
