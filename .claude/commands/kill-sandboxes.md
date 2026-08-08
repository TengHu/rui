# Kill E2B Sandboxes

Kill all running E2B sandboxes using the kill_all_sandboxes.py script.

## Usage

Load the E2B_API_KEY from .env and run the script:

```bash
export $(grep E2B_API_KEY .env | xargs) && python kill_all_sandboxes.py
```

## Options

- `--dry-run`: List sandboxes without killing them (preview mode)

```bash
export $(grep E2B_API_KEY .env | xargs) && python kill_all_sandboxes.py --dry-run
```

## Instructions

1. First run with `--dry-run` to see what sandboxes are running
2. Then run without the flag to kill all sandboxes
3. Report the results to the user
