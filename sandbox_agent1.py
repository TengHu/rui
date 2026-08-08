"""Claude agent code executed inside the sandbox."""

import asyncio
import base64
import json
import mimetypes
import os
import sys
import time
import traceback
from pathlib import Path
from threading import Event, Lock, Thread


class DebugLogger:
    """File-based logger for sandbox debugging - agent can read this file."""

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        # Clear log at start of each run
        self.log_path.write_text("")

    def log(self, level: str, message: str, **kwargs):
        """Write a log entry to the debug file."""
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "level": level,
            "message": message,
            **kwargs,
        }
        with self.log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")
            f.flush()

    def info(self, message: str, **kwargs):
        self.log("INFO", message, **kwargs)

    def error(self, message: str, **kwargs):
        self.log("ERROR", message, **kwargs)

    def warning(self, message: str, **kwargs):
        self.log("WARNING", message, **kwargs)

    def debug(self, message: str, **kwargs):
        self.log("DEBUG", message, **kwargs)

    def exception(self, message: str, exc: Exception = None):
        """Log an exception with full traceback."""
        tb = traceback.format_exc() if exc else traceback.format_exc()
        self.log("ERROR", message, traceback=tb, exception_type=type(exc).__name__ if exc else None)


# Global debug logger - initialized in run_agent_code
_debug_logger: DebugLogger = None


def get_debug_logger() -> DebugLogger:
    """Get the debug logger instance."""
    return _debug_logger


# Lazy import to capture import errors
ClaudeSDKClient = None
ClaudeAgentOptions = None
HookMatcher = None


def _import_sdk():
    """Import SDK with error handling - writes errors to debug log."""
    global ClaudeSDKClient, ClaudeAgentOptions, HookMatcher
    try:
        from claude_agent_sdk import ClaudeSDKClient as _Client, ClaudeAgentOptions as _Options, HookMatcher as _Matcher
        ClaudeSDKClient = _Client
        ClaudeAgentOptions = _Options
        HookMatcher = _Matcher
        if _debug_logger:
            _debug_logger.info("SDK imported successfully")
        return True
    except ImportError as e:
        if _debug_logger:
            _debug_logger.exception(f"Failed to import claude_agent_sdk: {e}", exc=e)
        return False
    except Exception as e:
        if _debug_logger:
            _debug_logger.exception(f"Unexpected error importing SDK: {e}", exc=e)
        return False

# Default system prompt for the agent
DEFAULT_SYSTEM_PROMPT = """You're an AI agent named Rui with full access to a computer with terminal to do whatever task given.
Users won't have direct access to the computer. When you build apps or create files that users need to see or interact with, use the app-presenter skill to expose your work to them.

CRITICAL: NEVER run blocking processes. When starting any server or long-running process, you MUST use the Bash tool with `run_in_background: true` parameter.
Example: Bash(command="python3 -m http.server 8000 --bind 0.0.0.0", run_in_background=true)
Do NOT use `&` at the end - use the run_in_background parameter instead.
After starting, immediately give the user the URL. Never wait on a running server.

IMPORTANT: You (the agent) are running as a Python process inside this sandbox. Be extremely careful and precise when modifying, terminating, or interfering with running Python processes, as you could inadvertently terminate yourself or cause system instability.
"""


class EventEmitter:
    """Centralized event emitter for streaming events to file."""

    def __init__(self, file_path: Path):
        self.file_path = file_path
        self.seq = self._read_last_seq() + 1
        self.lock = Lock()
        # Rotation/compaction is handled server-side by FilePoller — agent only appends

    def _read_last_seq(self) -> int:
        """Read the last seq number from the existing file, or -1 if empty."""
        try:
            if not self.file_path.exists():
                return -1
            with self.file_path.open("r") as f:
                last_line = ""
                for line in f:
                    stripped = line.strip()
                    if stripped:
                        last_line = stripped
                if not last_line:
                    return -1
                return json.loads(last_line).get("seq", -1)
        except Exception:
            return -1

    def emit(self, event_type: str, data: dict):
        """Emit an event to the events file."""
        event = {
            "seq": self.seq,
            "ts": time.time(),
            "type": event_type,
            "data": data,
        }
        self.seq += 1

        with self.lock:
            with self.file_path.open("a") as f:
                f.write(json.dumps(event) + "\n")
                f.flush()


def run_agent_code(query: str, cwd: str, system_prompt: str = None, session_id: str = None) -> str:
    """Run the Claude agent inside the sandbox and return final output.

    Args:
        query: The user query/task
        cwd: Working directory
        system_prompt: System prompt for the agent (uses DEFAULT_SYSTEM_PROMPT if not provided)
        session_id: Optional session ID to resume a previous conversation

    Debug logs are written to: {cwd}/agent_debug.log
    The agent can read this file to diagnose issues.
    """
    global _debug_logger

    if not system_prompt:
        system_prompt = DEFAULT_SYSTEM_PROMPT

    os.makedirs(cwd, exist_ok=True)
    os.chdir(cwd)

    # Initialize debug logger FIRST - writes to /tmp/agent_debug.log
    debug_log_path = Path("/tmp") / "agent_debug.log"
    _debug_logger = DebugLogger(debug_log_path)
    _debug_logger.info("Agent starting", query=query[:200], cwd=cwd, session_id=session_id)

    # Check environment
    _debug_logger.info("Environment check",
        anthropic_api_key_set=bool(os.environ.get("ANTHROPIC_API_KEY")),
        python_version=sys.version,
        working_dir=os.getcwd(),
    )

    # Import SDK with error handling
    if not _import_sdk():
        error_msg = "Failed to import claude_agent_sdk - check agent_debug.log for details"
        _debug_logger.error(error_msg)
        # Still write to events file so frontend knows (append, don't truncate)
        events_file_env = os.environ.get("EVENTS_FILE")
        events_file = Path(events_file_env) if events_file_env else Path("/tmp") / "events.jsonl"
        with events_file.open("a") as f:
            f.write(json.dumps({
                "seq": 0, "ts": time.time(), "type": "agent_end",
                "data": {"success": False, "error": error_msg}
            }) + "\n")
        return f"ERROR: {error_msg}"

    events_file_env = os.environ.get("EVENTS_FILE")
    if events_file_env:
        events_file = Path(events_file_env)
    else:
        events_file = Path("/tmp") / "events.jsonl"
    # Ensure file exists (append mode — rotation is handled by the server-side FilePoller)
    if not events_file.exists():
        events_file.write_text("")
    _debug_logger.info("Events file initialized", path=str(events_file))

    emitter = EventEmitter(events_file)

    def truncate_large(content, max_length=10000):
        if isinstance(content, str) and len(content) > max_length:
            return content[:max_length] + f"... [truncated {len(content) - max_length} chars]"
        return content

    async def pre_tool_use_hook(input_data, tool_use_id, context):
        # Note: "file" events for Write/Edit are now emitted early during streaming
        # (see input_json_delta handling above). This hook only emits tool_start.
        tool_name = input_data.get("tool_name")
        emitter.emit(
            "tool_start",
            {
                "id": tool_use_id,
                "tool": tool_name,
                "input": truncate_large(input_data.get("tool_input", {})),
            },
        )

        return {"continue": True}

    async def post_tool_use_hook(input_data, tool_use_id, context):
        def serialize_output(value):
            if value is None:
                return ""
            if isinstance(value, str):
                return value
            try:
                return json.dumps(value, ensure_ascii=True, default=str)
            except Exception:
                return str(value)

        def extract_tool_output(data):
            for key in ("tool_output", "tool_response", "result", "output"):
                if key in data and data[key] not in (None, ""):
                    return data[key]
            return ""

        output_value = extract_tool_output(input_data or {})

        # Emit image events for Write tool (text file "writing" is emitted pre-tool)
        tool_name = input_data.get("tool_name")
        if tool_name == "Write":
            tool_input = input_data.get("tool_input", {})
            file_path = tool_input.get("file_path", "")
            if file_path:
                ext = file_path.lower().split(".")[-1] if "." in file_path else ""
                if ext in ("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"):
                    # Image file - read and emit as base64
                    try:
                        img_path = Path(file_path)
                        if img_path.exists():
                            content_bytes = img_path.read_bytes()
                            emitter.emit("image", {
                                "path": file_path,
                                "base64": base64.b64encode(content_bytes).decode(),
                                "mime": mimetypes.guess_type(file_path)[0] or "image/png",
                            })
                    except Exception:
                        pass

        emitter.emit(
            "tool_end",
            {
                "id": tool_use_id,
                "output": truncate_large(serialize_output(output_value)),
                "error": input_data.get("error"),
            },
        )
        return {"continue": True}

    assistant_text = []
    captured_session_id = None
    current_tool_block = {}  # index -> {"id": tool_use_id, "name": tool_name}

    def _extract_session_id(message):
        """Best-effort extraction across SDK message shapes."""
        value = getattr(message, "session_id", None)
        if value:
            return value
        data = getattr(message, "data", None)
        if isinstance(data, dict):
            value = data.get("session_id")
            if value:
                return value
        event = getattr(message, "event", None)
        if isinstance(event, dict):
            value = event.get("session_id")
            if value:
                return value
        raw = getattr(message, "raw", None)
        if isinstance(raw, dict):
            value = raw.get("session_id") or raw.get("sessionId")
            if value:
                return value
        return None

    async def run_query():
        nonlocal captured_session_id
        _debug_logger.info("run_query started")
        emitter.emit("agent_start", {"query": query, "session_id": session_id})

        # Check for ANTHROPIC_API_KEY early - emit error if missing
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            error_msg = "ANTHROPIC_API_KEY not set in sandbox environment"
            _debug_logger.error(error_msg)
            emitter.emit("agent_end", {"success": False, "error": error_msg, "session_id": None})
            raise RuntimeError(error_msg)

        _debug_logger.info("API key present, creating ClaudeAgentOptions")

        # Stderr capture for CLI subprocess debugging
        cli_stderr_lines = []
        def on_stderr(line: str):
            cli_stderr_lines.append(line)
            _debug_logger.debug("CLI stderr", line=line.rstrip())

        try:
            options = ClaudeAgentOptions(
                system_prompt=system_prompt,
                setting_sources=["project", "user"],
                allowed_tools=["Bash", "WebSearch", "Read", "Write", "Edit", "Grep", "Task", "Skill", "mcp__app-server__*"],
                permission_mode="bypassPermissions",
                model="claude-opus-4-6",
                cwd=cwd,
                env={"IS_SANDBOX": "1"},  # Allows bypassPermissions as root
                include_partial_messages=True,  # Enable streaming
                stderr=on_stderr,  # Capture CLI stderr for debugging
                mcp_servers={
                    "app-server": {
                        "type": "http",
                        "url": "http://localhost:3000/mcp",
                    }
                },
                hooks={
                    "PreToolUse": [
                        HookMatcher(
                            matcher=None,
                            hooks=[pre_tool_use_hook],
                        )
                    ],
                    "PostToolUse": [
                        HookMatcher(
                            matcher=None,
                            hooks=[post_tool_use_hook],
                        )
                    ],
                },
            )

            if session_id:
                options.resume = session_id
                _debug_logger.info("Resuming session", session_id=session_id)

            _debug_logger.info("Creating ClaudeSDKClient")
            async with ClaudeSDKClient(options=options) as client:
                _debug_logger.info("ClaudeSDKClient created, sending query")
                await client.query(prompt=query)
                _debug_logger.info("Query sent, receiving response stream")
                async for message in client.receive_response():
                    msg_type = type(message).__name__

                    # Capture session ID from any message that contains it
                    if not captured_session_id:
                        extracted = _extract_session_id(message)
                        if extracted:
                            captured_session_id = extracted
                            emitter.emit("session_init", {"session_id": captured_session_id})

                    # Handle streaming events (token-by-token)
                    if msg_type == "StreamEvent":
                        event = message.event
                        event_type = event.get("type")

                        # Track content_block_start for tool context on input deltas
                        if event_type == "content_block_start":
                            cb = event.get("content_block", {})
                            if cb.get("type") == "tool_use":
                                current_tool_block[event.get("index", 0)] = {
                                    "id": cb.get("id"),
                                    "name": cb.get("name", ""),
                                }
                        elif event_type == "content_block_stop":
                            current_tool_block.pop(event.get("index", 0), None)
                        elif event_type == "content_block_delta":
                            delta = event.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    emitter.emit("text_delta", {"text": text})
                            elif delta.get("type") == "input_json_delta":
                                block_idx = event.get("index", 0)
                                tool_ctx = current_tool_block.get(block_idx, {})
                                emitter.emit("input_json_delta", {
                                    "partial_json": delta.get("partial_json", ""),
                                    "tool_use_id": tool_ctx.get("id"),
                                    "tool_name": tool_ctx.get("name", ""),
                                })

                    # Handle complete assistant messages
                    elif msg_type == "AssistantMessage":
                        message_texts = []
                        for block in message.content:
                            if type(block).__name__ == "TextBlock":
                                message_texts.append(block.text)
                        if message_texts:
                            full_text = "".join(message_texts)
                            assistant_text.append(full_text)
                            emitter.emit("text_done", {"full_text": full_text})


            _debug_logger.info("Agent completed successfully", session_id=captured_session_id)
            emitter.emit("agent_end", {"success": True, "session_id": captured_session_id})

        except Exception as e:
            # Log to debug file for agent visibility
            _debug_logger.exception(f"Agent execution failed: {e}", exc=e)
            # Dump all captured CLI stderr lines
            if cli_stderr_lines:
                full_stderr = "\n".join(cli_stderr_lines)
                _debug_logger.error("CLI stderr (captured via callback)", stderr=full_stderr[:5000])
            else:
                _debug_logger.error("No CLI stderr lines captured via callback")
            # Capture stderr from ProcessError if available
            stderr_output = getattr(e, "stderr", None) or getattr(e, "error_output", None) or ""
            if stderr_output:
                _debug_logger.error("CLI stderr (from exception)", stderr=str(stderr_output))
            # Also log all attributes of the error for debugging
            error_attrs = {k: str(v)[:500] for k, v in vars(e).items()} if hasattr(e, "__dict__") else {}
            if error_attrs:
                _debug_logger.error("ProcessError attributes", attrs=error_attrs)
            # Combine all stderr sources
            all_stderr = "\n".join(filter(None, [
                "\n".join(cli_stderr_lines) if cli_stderr_lines else "",
                str(stderr_output) if stderr_output else "",
            ])).strip()
            # Always emit agent_end, even on error, so the UI knows we're done
            error_detail = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            if all_stderr:
                error_detail += f"\nCLI Stderr:\n{all_stderr}"
            emitter.emit("agent_end", {"success": False, "error": str(e), "traceback": error_detail, "cli_stderr": all_stderr or None, "session_id": captured_session_id})
            raise

    def run_async(coro):
        try:
            asyncio.get_running_loop()
            _debug_logger.info("Running in existing event loop via thread")
        except RuntimeError:
            _debug_logger.info("No running event loop, using asyncio.run()")
            asyncio.run(coro)
            return

        done = Event()
        error = {}

        def runner():
            try:
                asyncio.run(coro)
            except Exception as exc:
                _debug_logger.exception(f"Async runner thread failed: {exc}", exc=exc)
                error["exc"] = exc
            finally:
                done.set()

        thread = Thread(target=runner, daemon=True)
        thread.start()
        done.wait()
        if "exc" in error:
            raise error["exc"]

    try:
        run_async(run_query())
        _debug_logger.info("run_async completed", output_length=len("".join(assistant_text)))
    except Exception as e:
        _debug_logger.exception(f"run_async failed: {e}", exc=e)
        raise

    return "".join(assistant_text)


if __name__ == "__main__":
    print(run_agent_code("what skills are available", ".", "You are a helpful assistant."))
