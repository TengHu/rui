---
name: sandbox-full-log
description: Pull event logs from an E2B sandbox window for debugging.
version: 4.0.0
command: sandbox-full-log
tags: [e2b, sandbox, debugging, events, jsonl]
---

# Sandbox Full Log

Download the full event log from an E2B sandbox window to a local file.

On each agent start, the previous run's events are compacted (gzipped to archives/) and the live file is cleared. The script reads archives + current file to give the full history.

## Instructions

Invoked as `/sandbox-full-log <sandbox_id> <window_id>`.

1. If window_id is missing, run `python sandbox_full_log.py <sandbox_id> --list` and ask the user to pick one.
2. Download the full log and show the summary:
   ```bash
   python sandbox_full_log.py <sandbox_id> <window_id> > debug_<window_id>.jsonl 2>&1
   python sandbox_full_log.py <sandbox_id> <window_id> --summary
   ```
3. Tell the user the local file path and the event breakdown.
