# Documentation

## Reading Order

| #   | Doc                                            | What it covers                                                     |
| --- | ---------------------------------------------- | ------------------------------------------------------------------ |
| 1   | [HOW_IT_WORKS.md](HOW_IT_WORKS.md)             | Full architecture — start here to understand the system            |
| 2   | [AGENT_ADAPTER.md](AGENT_ADAPTER.md)           | How to write a custom adapter (**main contribution of this fork**) |
| 3   | [PI_ADAPTER.md](PI_ADAPTER.md)                 | Pi-specific implementation details                                 |
| 4   | [SETUP_GUIDE.md](SETUP_GUIDE.md)               | Local development setup (three paths by goal)                      |
| 5   | [GETTING_STARTED.md](GETTING_STARTED.md)       | Full deployment with Terraform                                     |
| 6   | [SECRETS.md](SECRETS.md)                       | Managing secrets and environment variables                         |
| 7   | [AUTOMATIONS.md](AUTOMATIONS.md)               | Automation triggers and webhooks                                   |
| 8   | [DEBUGGING_PLAYBOOK.md](DEBUGGING_PLAYBOOK.md) | Structured debugging guide with log catalog                        |
| 9   | [IMAGE_PREBUILD.md](IMAGE_PREBUILD.md)         | Image prebuilding for faster sandbox startup                       |
| 10  | [OPENAI_MODELS.md](OPENAI_MODELS.md)           | OpenAI model configuration                                         |

## What's from this fork vs upstream

**Added by this fork:**

- `AGENT_ADAPTER.md` — adapter interface spec
- `PI_ADAPTER.md` — Pi adapter implementation notes

**From upstream ([ColeMurray/background-agents](https://github.com/ColeMurray/background-agents)),
updated for this fork:**

- Everything else. Package references and repo URLs have been updated to match this fork.
