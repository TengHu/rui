/**
 * Standard Sandbox I/O Tools
 *
 * These tools provide file system and shell access from the sandbox.
 * They are pre-installed in the shared tool registry (/.mcp-tools/).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ============================================================================
// SANDBOX-READ: Read file from sandbox filesystem
// ============================================================================

export const readFileTool = {
  name: "sandbox-read",
  title: "Read File",
  description: "Read a file from the sandbox filesystem",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to read"
      }
    },
    required: ["path"]
  },
};

export async function readFileHandler({ path: filePath }: { path: string }) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return {
      content: [{ type: "text" as const, text: content }],
      structuredContent: { path: filePath, size: content.length }
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error reading file: ${message}` }],
      isError: true
    };
  }
}

// ============================================================================
// SANDBOX-WRITE: Write content to a file
// ============================================================================

export const writeFileTool = {
  name: "sandbox-write",
  title: "Write File",
  description: "Write content to a file in the sandbox (creates parent directories)",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write"
      },
      content: {
        type: "string",
        description: "Content to write to the file"
      }
    },
    required: ["path", "content"]
  },
};

export async function writeFileHandler({
  path: filePath,
  content
}: {
  path: string;
  content: string;
}) {
  try {
    // Create parent directories if they don't exist
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return {
      content: [{ type: "text" as const, text: `Written ${content.length} bytes to ${filePath}` }],
      structuredContent: { path: filePath, bytesWritten: content.length }
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error writing file: ${message}` }],
      isError: true
    };
  }
}

// ============================================================================
// SANDBOX-LIST: List directory contents
// ============================================================================

export const listDirTool = {
  name: "sandbox-list",
  title: "List Directory",
  description: "List files and directories in a path",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list"
      }
    },
    required: ["path"]
  },
};

interface FileEntry {
  name: string;
  isDir: boolean;
  size?: number;
}

export async function listDirHandler({ path: dirPath }: { path: string }) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: FileEntry[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const fileEntry: FileEntry = {
        name: entry.name,
        isDir: entry.isDirectory(),
      };

      // Get file size for regular files
      if (!entry.isDirectory()) {
        try {
          const stats = await fs.stat(fullPath);
          fileEntry.size = stats.size;
        } catch {
          // Ignore stat errors
        }
      }

      files.push(fileEntry);
    }

    // Sort: directories first, then files, alphabetically
    files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }],
      structuredContent: { path: dirPath, entries: files }
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error listing directory: ${message}` }],
      isError: true
    };
  }
}

// ============================================================================
// SANDBOX-EXEC: Execute shell command
// ============================================================================

export const execTool = {
  name: "sandbox-exec",
  title: "Execute Command",
  description: "Run a shell command in the sandbox",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute"
      },
      cwd: {
        type: "string",
        description: "Working directory (optional)"
      }
    },
    required: ["command"]
  },
};

export async function execHandler({
  command,
  cwd
}: {
  command: string;
  cwd?: string;
}) {
  try {
    const options = cwd ? { cwd } : {};
    const { stdout, stderr } = await execAsync(command, options);
    const output = stdout || stderr || "(no output)";

    return {
      content: [{ type: "text" as const, text: output }],
      structuredContent: {
        command,
        cwd: cwd || process.cwd(),
        stdout,
        stderr,
        exitCode: 0
      }
    };
  } catch (error: unknown) {
    const execError = error as { message?: string; stderr?: string; code?: number };
    const message = execError.message || String(error);
    const stderr = execError.stderr || "";

    return {
      content: [{
        type: "text" as const,
        text: `Command failed: ${message}\n${stderr}`
      }],
      structuredContent: {
        command,
        error: message,
        stderr,
        exitCode: execError.code || 1
      },
      isError: true
    };
  }
}
