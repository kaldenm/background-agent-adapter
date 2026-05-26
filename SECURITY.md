# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please use
[GitHub's private vulnerability reporting](https://github.com/Goober-Codes/background-agent-adapter/security/advisories/new).

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 72 hours. We will work with you to understand and address the
issue before any public disclosure.

## Security Model

This system is designed for **single-tenant deployment only**, where all users are trusted members
of the same organization. See the [Security Model](README.md#security-model-single-tenant-only)
section in the README.

Key points:

- All users share the same GitHub App credentials
- No per-user repository access validation at the session level
- User OAuth tokens are used for PR creation (ensuring proper attribution)
- Repo secrets are encrypted with AES-256-GCM

### Token Types

| Token            | Purpose                | Scope                            |
| ---------------- | ---------------------- | -------------------------------- |
| GitHub App Token | Clone repos, push code | All repos where App is installed |
| User OAuth Token | Create PRs, user info  | Repos user has access to         |
| WebSocket Token  | Real-time session auth | Single session                   |

## Best Practices for Deployers

1. Deploy behind your organization's SSO/VPN
2. Install the GitHub App only on intended repositories
3. Use GitHub's repository selection (specific repos, not "All repositories")
4. Rotate `INTERNAL_CALLBACK_SECRET` and other shared secrets periodically
5. Cloudflare Workers require PKCS#8 format for GitHub App private keys
