# Example: feeding an AI agent fresh X data

Goal: let an agent (OpenClaw, Hermes, or any LLM script) answer
"What are people saying about local-first software this week?"

## 1. Collect (human runs this once, or on a schedule)

```bash
xscraper search "local-first software since:2026-09-19" --limit 100 --format md -o localfirst.md
```

## 2. Hand to the agent

```python
import subprocess

result = subprocess.run(
    ["xscraper", "search", "local-first software since:2026-09-19",
     "--limit", "100", "--format", "md"],
    capture_output=True, text=True, timeout=600,
)
context = result.stdout  # LLM-ready Markdown, one block per post
```

## 3. Or parse structured records

```python
import json, subprocess

result = subprocess.run(
    ["xscraper", "timeline", "@nasa", "--limit", "25", "--format", "json"],
    capture_output=True, text=True, timeout=600,
)
tweets = json.loads(result.stdout)
top = max(tweets, key=lambda t: t["metrics"]["likes"] or 0)
print(top["url"], top["metrics"])
```

## Tips

- Prefer `--format md` when the output goes straight into a prompt.
- Prefer `--format jsonl` when piping into a database or dataframe.
- Keep runs small and specific; two focused 50-item searches beat one 200-item trawl.
