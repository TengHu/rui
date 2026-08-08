#!/usr/bin/env python3
"""
Sandbox Runner - connect to an existing sandbox by ID and run the agent.
"""

import argparse
import asyncio
import logging
import os
import shlex
import sys
import uuid
from dataclasses import dataclass
from typing import Dict, Optional
from e2b_code_interpreter import AsyncSandbox
from e2b import CommandExitException, SandboxException
from e2b.exceptions import TimeoutException
import httpx

from observability import EventFileWatcherAsync


logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class AgentResult:
    """Result from running the agent."""
    success: bool
    output: str
    error: Optional[str] = None


@dataclass(frozen=True)
class AgentSpec:
    """Configuration for an agent module to upload and run."""
    name: str
    module: str
    entrypoint: str
    local_filename: str
    remote_filename: str


AGENT_SPECS: Dict[str, AgentSpec] = {
    "simple": AgentSpec(
        name="simple",
        module="sandbox_agent1",
        entrypoint="run_agent_code",
        local_filename="sandbox_agent1.py",
        remote_filename="sandbox_agent1.py",
    ),
}

# One-line swap: change this to another key in AGENT_SPECS.
DEFAULT_AGENT = "simple"


def _build_agent_runner(
    query: str,
    cwd: str,
    system_prompt: str,
    spec: AgentSpec,
    session_id: Optional[str] = None,
    events_file: Optional[str] = None,
) -> str:
    """Create the sandbox runner script that invokes the uploaded agent module."""
    # Set EVENTS_FILE env var if provided (for per-window event isolation)
    events_file_setup = ""
    if events_file:
        events_file_setup = f"os.environ['EVENTS_FILE'] = {repr(events_file)}\n"

    code = f"""
import os
import sys

cwd = {repr(cwd)}
os.makedirs(cwd, exist_ok=True)
os.chdir(cwd)
if cwd not in sys.path:
    sys.path.insert(0, cwd)

{events_file_setup}
import importlib
module = importlib.import_module({repr(spec.module)})
importlib.reload(module)
output = getattr(module, {repr(spec.entrypoint)})({repr(query)}, cwd, {repr(system_prompt)}, {repr(session_id)})
print(output)
"""
    # logger.info(f"Agent runner code: {code}")
    return code


async def run_agent(
    sandbox: AsyncSandbox,
    query: str,
    cwd: str = "/workspace",
    system_prompt: Optional[str] = None,
    spec: Optional[AgentSpec] = None,
    session_id: Optional[str] = None,
    events_file: Optional[str] = None,
) -> AgentResult:
    """
    Run a simple Claude Agent SDK chatbot in the given sandbox.

    Args:
        sandbox: E2B AsyncSandbox instance to run in
        query: User query/task for the agent
        cwd: Working directory (default: /workspace)
        system_prompt: Optional system prompt
        spec: Agent specification (default: simple agent)
        session_id: Optional session ID to resume a previous conversation
        events_file: Optional path for the events JSONL file (for per-window isolation)

    Returns:
        AgentResult with success status and output
    """
    # system_prompt defaults to None - agent will use its own DEFAULT_SYSTEM_PROMPT
    spec = spec or AGENT_SPECS[DEFAULT_AGENT]

    try:
        logger.info("Installing claude-agent-sdk in sandbox (if needed)")
        await ensure_agent_dependencies(sandbox)

        if session_id:
            logger.info("Running agent in sandbox (resuming session: %s)", session_id)
        else:
            logger.info("Running agent in sandbox (new session)")

        agent_code = _build_agent_runner(
            query=query,
            cwd=cwd,
            system_prompt=system_prompt,
            spec=spec,
            session_id=session_id,
            events_file=events_file,
        )

        # Write agent code to a temp file and execute as an OS process
        # so multiple agents can run in parallel (run_code uses a single
        # serialized Jupyter kernel).
        runner_path = f"/tmp/_agent_runner_{uuid.uuid4().hex[:8]}.py"
        envs = {}
        if events_file:
            envs["EVENTS_FILE"] = events_file

        try:
            await sandbox.files.write(runner_path, agent_code)

            last_error = None
            for attempt in range(10):
                try:
                    logger.info(f"Agent execution attempt {attempt + 1}/10")
                    cmd_result = await sandbox.commands.run(
                        f"python3 {runner_path}",
                        timeout=3600,
                        cwd=cwd,
                        envs=envs if envs else None,
                    )
                    output = cmd_result.stdout.strip() if cmd_result.stdout else ""
                    logger.info("Agent completed successfully")
                    return AgentResult(success=True, output=output)
                except CommandExitException as e:
                    stderr = e.stderr.strip() if e.stderr else ""
                    stdout = e.stdout.strip() if e.stdout else ""
                    logger.error(f"Agent exited with code {e.exit_code}: {stderr[:200]}")
                    return AgentResult(success=False, output=stdout, error=stderr or f"Agent exited with code {e.exit_code}")
                except (TimeoutException, SandboxException, httpx.RemoteProtocolError) as e:
                    last_error = e
                    logger.warning(f"Agent execution attempt {attempt + 1}/10 failed: {type(e).__name__}: {e}")
                    await asyncio.sleep(1)

            logger.error(f"All 10 agent execution attempts failed. Last error: {last_error}")
            return AgentResult(success=False, output="", error="Sandbox not ready after retries")
        finally:
            try:
                await sandbox.commands.run(f"rm -f {runner_path}", timeout=5)
            except Exception:
                pass

    except Exception as e:
        logger.exception("Agent execution failed")
        return AgentResult(success=False, output="", error=f"Agent execution failed: {str(e)}")


async def ensure_agent_dependencies(sandbox: AsyncSandbox) -> None:
    """Ensure the agent SDK and CLI are installed in the sandbox."""
    install_cmd = (
        "python3 -c 'import claude_agent_sdk' 2>/dev/null "
        "|| pip install claude-agent-sdk; "
        "pip install claude-code"
    )
    for attempt in range(10):
        try:
            await sandbox.commands.run(install_cmd, timeout=120)
            break
        except CommandExitException as e:
            logger.warning(f"Dependency install attempt {attempt + 1}/10 failed (exit {e.exit_code}): {e.stderr[:200] if e.stderr else ''}")
            await asyncio.sleep(1)
        except (TimeoutException, SandboxException) as e:
            logger.warning(f"Dependency install attempt {attempt + 1}/10 failed: {type(e).__name__}: {e}")
            await asyncio.sleep(1)
    else:
        raise RuntimeError("Failed to install agent dependencies after 10 attempts")


async def monitor_events_async(
    sandbox: AsyncSandbox,
    events_path: str,
    output_file: Optional[str] = None,
):
    watcher = EventFileWatcherAsync(sandbox=sandbox, events_path=events_path)

    output = open(output_file, "a") if output_file else None

    def handle_event(event: dict):
        event_type = event.get("type", "unknown")
        seq = event.get("seq", "?")
        logger.info(f"Event #{seq}: {event_type}")

        if event_type == "tool_start":
            tool = event.get("data", {}).get("tool", "unknown")
            logger.info(f"  → Tool: {tool}")
        elif event_type == "tool_end":
            error = event.get("data", {}).get("error")
            if error:
                logger.warning(f"  → Error: {error}")

        # If you ALSO want structured JSON lines in the local file (optional):
        # if output:
        #     output.write(json.dumps(event) + "\n")
        #     output.flush()

    def handle_raw(new_text: str):
        if not output or not new_text:
            return
        output.write(new_text)
        output.flush()

    try:
        await watcher.watch(handle_event, raw_callback=handle_raw, timeout=0)
    finally:
        if output:
            output.close()


async def upload_agent(sandbox: AsyncSandbox, cwd: str, spec: AgentSpec) -> None:
    """Upload the selected agent module to the sandbox working directory."""
    local_path = os.path.join(os.path.dirname(__file__), spec.local_filename)
    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Missing agent code file: {local_path}")

    with open(local_path, "r", encoding="utf-8") as f:
        agent_code = f.read()

    for attempt in range(10):
        try:
            await sandbox.commands.run(f"mkdir -p {shlex.quote(cwd)}", timeout=10)
            break
        except (TimeoutException, SandboxException, CommandExitException) as e:
            logger.warning(f"mkdir attempt {attempt + 1}/10 for {cwd} failed: {e}")
            await asyncio.sleep(1)

    remote_path = os.path.join(cwd, spec.remote_filename)
    uploaded = False
    for attempt in range(10):
        try:
            await sandbox.files.write(remote_path, agent_code)
            uploaded = True
            break
        except TimeoutException:
            await asyncio.sleep(1)

    if not uploaded:
        raise RuntimeError(f"Failed to upload agent module to {remote_path}")

    local_claude_dir = os.path.join(os.path.dirname(__file__), "chatbot_web", "assets", "sandbox-claude")
    remote_claude_dir = os.path.join(cwd, ".claude")
    await upload_directory(sandbox, local_claude_dir, remote_claude_dir)


async def upload_directory(sandbox: AsyncSandbox, local_dir: str, remote_dir: str) -> None:
    """Upload a local directory (recursively) to the sandbox working directory."""
    if not os.path.isdir(local_dir):
        raise FileNotFoundError(f"Missing directory to upload: {local_dir}")

    for root, _, files in os.walk(local_dir):
        rel_root = os.path.relpath(root, local_dir)
        remote_root = remote_dir if rel_root == "." else os.path.join(remote_dir, rel_root)
        for attempt in range(10):
            try:
                await sandbox.commands.run(f"mkdir -p {shlex.quote(remote_root)}", timeout=10)
                break
            except (TimeoutException, SandboxException, CommandExitException) as e:
                logger.warning(f"mkdir attempt {attempt + 1}/10 for {remote_root} failed: {e}")
                await asyncio.sleep(1)

        for filename in files:
            local_path = os.path.join(root, filename)
            with open(local_path, "r", encoding="utf-8") as f:
                contents = f.read()

            remote_path = os.path.join(remote_root, filename)
            for attempt in range(10):
                try:
                    await sandbox.files.write(remote_path, contents)
                    break
                except TimeoutException:
                    await asyncio.sleep(1)
            else:
                raise RuntimeError(f"Failed to upload file to {remote_path}")


async def agent_runner(args: argparse.Namespace) -> int:
    """Run the agent against an existing sandbox using parsed CLI args."""
    if not os.environ.get("E2B_API_KEY"):
        logger.error("E2B_API_KEY not found in environment")
        return 1

    if not os.path.exists(args.query_file):
        logger.error("Query file not found: %s", args.query_file)
        return 1

    with open(args.query_file, "r", encoding="utf-8") as f:
        query = f.read().strip()

    if not query:
        logger.error("Query file is empty: %s", args.query_file)
        return 1

    # Resolve system prompt (inline or file). Inline takes precedence.
    system_prompt: Optional[str] = getattr(args, "system_prompt", None)
    system_prompt_file: Optional[str] = getattr(args, "system_prompt_file", None)
    if not system_prompt and system_prompt_file:
        if not os.path.exists(system_prompt_file):
            logger.error("System prompt file not found: %s", system_prompt_file)
            return 1
        with open(system_prompt_file, "r", encoding="utf-8") as f:
            system_prompt = f.read().strip()
        if not system_prompt:
            logger.error("System prompt file is empty: %s", system_prompt_file)
            return 1

    logger.info("Connecting to sandbox %s", args.sandbox_id)
    sandbox = await AsyncSandbox.connect(sandbox_id=args.sandbox_id)

    if DEFAULT_AGENT not in AGENT_SPECS:
        logger.error("Unknown DEFAULT_AGENT: %s", DEFAULT_AGENT)
        return 1

    spec = AGENT_SPECS[DEFAULT_AGENT]
    logger.info("Uploading agent code to sandbox (%s)", spec.name)
    await upload_agent(sandbox=sandbox, cwd=args.cwd, spec=spec)

    # Start event monitoring in background task if requested
    monitor_task = None
    if args.watch_events or args.save_events:
        events_path = f"{args.cwd}/events.jsonl"
        try:
            if not await sandbox.files.exists(events_path):
                await sandbox.files.write(events_path, "")
        except Exception as e:
            logger.warning("Failed to pre-create events file at %s: %s", events_path, e)

        # Create a separate sandbox connection for monitoring
        async def run_monitor():
            monitor_sandbox = await AsyncSandbox.connect(sandbox_id=args.sandbox_id)
            try:
                await monitor_events_async(
                    sandbox=monitor_sandbox,
                    events_path=events_path,
                    output_file=args.save_events,
                )
            except asyncio.CancelledError:
                pass
            finally:
                api_client = getattr(monitor_sandbox, "_envd_api", None)
                aclose = getattr(api_client, "aclose", None)
                if callable(aclose):
                    await aclose()

        monitor_task = asyncio.create_task(run_monitor())

    logger.info("Running agent")
    session_id = getattr(args, 'session_id', None)
    result = await run_agent(
        sandbox=sandbox,
        query=query,
        cwd=args.cwd,
        system_prompt=system_prompt,
        spec=spec,
        session_id=session_id,
    )

    # Let event monitor catch up
    if args.watch_events or args.save_events:
        await asyncio.sleep(2)
        if monitor_task:
            monitor_task.cancel()
            try:
                await monitor_task
            except asyncio.CancelledError:
                pass

    if result.success:
        print(result.output)
        return 0

    if result.output:
        print(result.output)
    logger.error("Agent failed: %s", result.error)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run an agent in an existing E2B sandbox.",
    )
    parser.add_argument("sandbox_id", help="Sandbox ID to connect to")
    parser.add_argument(
        "--query-file",
        default="input_query.txt",
        help="Path to query file (default: input_query.txt)",
    )
    parser.add_argument("--cwd", default="/home/user/workspace", help="Working directory")
    parser.add_argument(
        "--session-id",
        type=str,
        help="Session ID to resume a previous conversation"
    )
    parser.add_argument(
        "--system-prompt",
        type=str,
        help="System prompt to pass to the agent (overrides --system-prompt-file)",
    )
    parser.add_argument(
        "--system-prompt-file",
        type=str,
        help="Path to a file containing the system prompt",
    )
    parser.add_argument(
        "--watch-events",
        action="store_true",
        help="Monitor and display agent events in real-time"
    )
    parser.add_argument(
        "--save-events",
        type=str,
        help="Save events to local file (e.g., events_output.jsonl)"
    )

    args = parser.parse_args()
    return asyncio.run(agent_runner(args))


if __name__ == "__main__":
    sys.exit(main())
