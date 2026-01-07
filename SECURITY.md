# Security Policy

## Supported Versions

We actively support the following versions of Squads CLI with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of Squads CLI seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues by emailing:

**security@agents-squads.com**

Include the following information:

* **Type of vulnerability** (e.g., command injection, path traversal, etc.)
* **Affected versions** of squads-cli
* **Steps to reproduce** the vulnerability
* **Potential impact** of the vulnerability
* **Suggested fix** (if you have one)

### What to Expect

* **Initial Response**: Within 48 hours, we'll acknowledge receipt of your report
* **Investigation**: We'll investigate the issue and determine its severity
* **Updates**: We'll keep you informed of our progress
* **Resolution**: We'll develop and test a fix
* **Disclosure**: Once fixed, we'll coordinate disclosure timing with you
* **Credit**: With your permission, we'll credit you in the security advisory

### Security Update Process

1. Security issue reported and confirmed
2. Fix developed and tested
3. Security advisory drafted
4. Patch released
5. Security advisory published
6. Users notified via GitHub releases and npm

## Security Best Practices

When using Squads CLI, follow these security best practices:

### Secrets Management

* **Never commit API keys** or credentials to git repositories
* Use environment variables for sensitive data
* Use `.env` files (and add to `.gitignore`)
* Consider using secret management tools (HashiCorp Vault, AWS Secrets Manager, etc.)

### File Permissions

* Ensure `.agents/` directory has appropriate permissions (0700 recommended)
* Protect memory and state files from unauthorized access
* Be careful with agent markdown files that may contain sensitive prompts

### Agent Execution

* **Review agent prompts** before execution, especially from untrusted sources
* Be cautious with agents that execute system commands
* Use sandboxed environments for untrusted agents
* Implement least-privilege principles for agent permissions

### Network Security

* Use HTTPS for all external API calls
* Validate and sanitize all external inputs
* Implement rate limiting for API calls
* Use authentication for remote agent execution

### Dependencies

* Keep squads-cli updated to the latest version
* Monitor security advisories for dependencies
* Use `npm audit` to check for vulnerable dependencies

## Known Security Considerations

### Agent Prompt Injection

Agents accept natural language prompts which could potentially be exploited. Always:
* Review agent output before executing suggested commands
* Use trusted agent sources
* Implement input validation in production agents

### Command Execution

Some agents may execute system commands. Always:
* Review agent code before execution
* Use sandboxed environments when possible
* Implement command whitelisting for production

### Memory Storage

Memory and state files may contain sensitive information:
* Encrypt sensitive data in memory files
* Use appropriate file permissions
* Consider secure deletion for old state files

## Security Disclosure Policy

* We aim to respond to security reports within 48 hours
* We provide security updates for all supported versions
* We publicly disclose vulnerabilities after fixes are available
* We coordinate disclosure timing with reporters

## Contact

For security concerns:
* **Email**: security@agents-squads.com
* **General inquiries**: contact@agents-squads.com
* **Website**: https://agents-squads.com/contact

Thank you for helping keep Squads CLI and our community safe! 🔒
