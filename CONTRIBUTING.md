# Contributing to Squads CLI

Thank you for your interest in contributing to Squads CLI! This document provides guidelines and instructions for contributing.

## Code of Conduct

This project adheres to a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include as many details as possible:

* **Use a clear and descriptive title**
* **Describe the exact steps to reproduce the problem**
* **Provide specific examples** - Include command output, screenshots, or code samples
* **Describe the behavior you observed** and what you expected to see
* **Include your environment details**: OS, Node.js version, squads-cli version

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

* **Use a clear and descriptive title**
* **Provide a detailed description** of the suggested enhancement
* **Explain why this enhancement would be useful** to most Squads CLI users
* **List examples** of how the enhancement would be used

### Pull Requests

* Fill in the pull request template
* Follow the TypeScript style guide used in the project
* Include tests for new functionality
* Update documentation as needed
* End all files with a newline
* Ensure the CI/CD pipeline passes

### Issue Priority and Escalation

The project follows strict SLA policies for critical issues:

* **P1 issues**: Must be resolved within 7 days
* **P2 issues**: Target resolution within 30 days
* **P3 issues**: Best effort

See [docs/ESCALATION.md](docs/ESCALATION.md) for the complete escalation policy and monitoring process.

## Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/your-username/squads-cli.git
   cd squads-cli
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Link for local development**
   ```bash
   npm link
   ```

5. **Run tests**
   ```bash
   npm test
   ```

## Project Structure

```
squads-cli/
├── src/              # Source code
│   ├── commands/     # CLI commands
│   ├── lib/          # Core library code
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Utility functions
├── tests/            # Test files
└── docs/             # Documentation
```

## Coding Guidelines

### TypeScript Style

* Use TypeScript for all new code
* Enable strict mode
* Add type annotations for function parameters and return values
* Use interfaces for complex types
* Avoid `any` type when possible

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types:
* `feat`: New feature
* `fix`: Bug fix
* `docs`: Documentation changes
* `style`: Code style changes (formatting, etc.)
* `refactor`: Code refactoring
* `test`: Adding or updating tests
* `chore`: Maintenance tasks

Example:
```
feat(memory): add semantic search for memory queries

- Implement vector embeddings for memory entries
- Add similarity search API
- Update CLI to support semantic queries

Closes #123
```

### Testing

* Write tests for new features
* Ensure all tests pass before submitting PR
* Aim for high code coverage
* Use descriptive test names

## Documentation

* Update README.md for new features
* Add JSDoc comments for public APIs
* Update CHANGELOG.md following [Keep a Changelog](https://keepachangelog.com/)
* Create or update docs/ files for significant changes

## Release Process

Maintainers follow this process for releases:

1. Update version in package.json
2. Update CHANGELOG.md
3. Create git tag
4. Push to GitHub
5. Publish to npm
6. Create GitHub release

## Getting Help

* **Documentation**: https://docs.agents-squads.com
* **Discussions**: https://github.com/agents-squads/squads-cli/discussions
* **Issues**: https://github.com/agents-squads/squads-cli/issues
* **Contact**: contact@agents-squads.com

## Recognition

Contributors will be recognized in:
* CHANGELOG.md for their contributions
* GitHub contributors page
* Release notes

Thank you for contributing to Squads CLI! 🎉
