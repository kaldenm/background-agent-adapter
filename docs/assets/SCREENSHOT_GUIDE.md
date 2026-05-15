# Screenshot Guide

Take these screenshots and save them in this directory. The README references them.

Use dark mode. Crop tight. PNG format. Aim for ~1200px wide.

## Required Screenshots

### 1. `session-streaming.png` — Hero image

The session page with an active prompt streaming responses. Should show:

- Left: message timeline with a user prompt and the agent's streaming response
- Tool calls visible (file edits, terminal commands)
- Right sidebar: metadata, files changed, participants
- Bottom: terminal panel (if open)

**This is the most important screenshot.** It's the first thing people see.

### 2. `session-list.png` — Dashboard

The main session list page showing 4-6 sessions with:

- Mix of active/completed sessions
- Repo names, timestamps, status indicators
- Left sidebar with navigation (Sessions, Automations, Settings)

### 3. `adapter-swap.png` — Terminal screenshot

A terminal showing the env var swap. Just a simple:

```
# Switch from OpenCode to Pi
export AGENT_ADAPTER=pi

# That's it. Same bridge, same control plane, same UI.
```

Use a nice terminal theme. This is the "money shot" for the adapter story.

### 4. `slack-bot.png` — Slack integration

A Slack thread showing:

- User @mentioning the bot with a coding request
- Bot responding with session link and progress
- Thread reply with the PR link when done

### 5. `pr-created.png` — GitHub PR

A GitHub PR created by the system showing:

- Clean commit messages
- Proper author attribution
- The PR description

### 6. `automations.png` — Automations page

The automations list or creation page showing:

- A few automations (cron, webhook, Sentry)
- Schedule, repo, status columns

## Optional (nice to have)

### 7. `multiplayer.png` — Multiple participants

Session with 2+ participant avatars visible in the sidebar.

### 8. `linear-bot.png` — Linear integration

An issue assigned to the agent with activity updates.

## After capturing

1. Save PNGs in this directory (`docs/assets/`)
2. Optimize: `pngquant --quality=65-80 *.png` or use ImageOptim
3. Update README.md image references (placeholders are already there)
