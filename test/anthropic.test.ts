import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractSkillTitle,
  extractSkillDescription,
  loadSkillFiles,
  isApiKeyConfigured,
} from '../src/lib/anthropic';
import type { SkillFile } from '../src/lib/anthropic';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('anthropic utilities', () => {
  describe('extractSkillTitle', () => {
    it('extracts title from YAML frontmatter name field', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
name: My Custom Skill
description: A test skill
---

# Skill Heading

Content here.`,
        },
      ];

      expect(extractSkillTitle(files)).toBe('My Custom Skill');
    });

    it('extracts title from markdown heading when no frontmatter', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `# My Skill Title

This is the description paragraph.`,
        },
      ];

      expect(extractSkillTitle(files)).toBe('My Skill Title');
    });

    it('prefers frontmatter name over markdown heading', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
name: Frontmatter Name
---

# Markdown Heading

Content.`,
        },
      ];

      expect(extractSkillTitle(files)).toBe('Frontmatter Name');
    });

    it('throws error when SKILL.md not found', () => {
      const files: SkillFile[] = [
        { name: 'README.md', content: '# Readme' },
        { name: 'index.ts', content: 'export {}' },
      ];

      expect(() => extractSkillTitle(files)).toThrow('SKILL.md not found');
    });

    it('throws error when no title can be extracted', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `Just some text without heading or frontmatter.`,
        },
      ];

      expect(() => extractSkillTitle(files)).toThrow('Could not extract skill title');
    });

    it('handles SKILL.md in subdirectory', () => {
      const files: SkillFile[] = [
        {
          name: 'skills/SKILL.md',
          content: `---
name: Nested Skill
---

# Heading`,
        },
      ];

      expect(extractSkillTitle(files)).toBe('Nested Skill');
    });

    it('trims whitespace from frontmatter name', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
name:   Whitespace Skill
---`,
        },
      ];

      expect(extractSkillTitle(files)).toBe('Whitespace Skill');
    });

    it('trims whitespace from markdown heading', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `#   Spaced Heading   `,
        },
      ];

      expect(extractSkillTitle(files)).toBe('Spaced Heading');
    });

    it('handles frontmatter with empty name but valid heading', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
description: some desc
---

# Fallback Heading`,
        },
      ];

      expect(extractSkillTitle(files)).toBe('Fallback Heading');
    });
  });

  describe('extractSkillDescription', () => {
    it('extracts description from YAML frontmatter', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
name: My Skill
description: This is the skill description
---

# Heading`,
        },
      ];

      expect(extractSkillDescription(files)).toBe('This is the skill description');
    });

    it('extracts description from first paragraph when no frontmatter', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `# My Skill

This is the first paragraph after the heading.

More content here.`,
        },
      ];

      expect(extractSkillDescription(files)).toBe('This is the first paragraph after the heading.');
    });

    it('returns undefined when SKILL.md not found', () => {
      const files: SkillFile[] = [
        { name: 'README.md', content: '# Readme' },
      ];

      expect(extractSkillDescription(files)).toBeUndefined();
    });

    it('returns undefined when no description can be extracted', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
name: Just Name
---`,
        },
      ];

      expect(extractSkillDescription(files)).toBeUndefined();
    });

    it('prefers frontmatter description over paragraph', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
name: Skill
description: Frontmatter desc
---

# Heading

Paragraph desc.`,
        },
      ];

      expect(extractSkillDescription(files)).toBe('Frontmatter desc');
    });

    it('trims whitespace from frontmatter description', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `---
description:   Spaced description
---

# H`,
        },
      ];

      expect(extractSkillDescription(files)).toBe('Spaced description');
    });

    it('trims whitespace from paragraph description', () => {
      const files: SkillFile[] = [
        {
          name: 'SKILL.md',
          content: `# Title

   Indented paragraph.   `,
        },
      ];

      expect(extractSkillDescription(files)).toBe('Indented paragraph.');
    });

    it('handles SKILL.md in subdirectory', () => {
      const files: SkillFile[] = [
        {
          name: 'nested/SKILL.md',
          content: `---
name: Nested
description: Nested skill description
---`,
        },
      ];

      expect(extractSkillDescription(files)).toBe('Nested skill description');
    });
  });

  describe('loadSkillFiles', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'anthropic-test-'));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('loads single SKILL.md file', () => {
      const skillContent = '# Test Skill\n\nDescription here.';
      writeFileSync(join(tempDir, 'SKILL.md'), skillContent);

      const files = loadSkillFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('SKILL.md');
      expect(files[0].content).toBe(skillContent);
    });

    it('loads multiple files from skill directory', () => {
      writeFileSync(join(tempDir, 'SKILL.md'), '# Skill');
      writeFileSync(join(tempDir, 'helper.ts'), 'export {}');
      writeFileSync(join(tempDir, 'config.json'), '{}');

      const files = loadSkillFiles(tempDir);

      expect(files).toHaveLength(3);
      expect(files.map(f => f.name).sort()).toEqual(['SKILL.md', 'config.json', 'helper.ts']);
    });

    it('recursively loads files from subdirectories', () => {
      writeFileSync(join(tempDir, 'SKILL.md'), '# Skill');
      mkdirSync(join(tempDir, 'scripts'));
      writeFileSync(join(tempDir, 'scripts', 'run.sh'), '#!/bin/bash');
      mkdirSync(join(tempDir, 'examples'));
      writeFileSync(join(tempDir, 'examples', 'demo.ts'), 'console.log("demo")');

      const files = loadSkillFiles(tempDir);

      expect(files).toHaveLength(3);
      expect(files.map(f => f.name).sort()).toEqual([
        'SKILL.md',
        'examples/demo.ts',
        'scripts/run.sh',
      ]);
    });

    it('returns empty array for empty directory', () => {
      const files = loadSkillFiles(tempDir);
      expect(files).toHaveLength(0);
    });

    it('handles deeply nested directories', () => {
      mkdirSync(join(tempDir, 'a', 'b', 'c'), { recursive: true });
      writeFileSync(join(tempDir, 'SKILL.md'), '# Root');
      writeFileSync(join(tempDir, 'a', 'file1.ts'), 'level 1');
      writeFileSync(join(tempDir, 'a', 'b', 'file2.ts'), 'level 2');
      writeFileSync(join(tempDir, 'a', 'b', 'c', 'file3.ts'), 'level 3');

      const files = loadSkillFiles(tempDir);

      expect(files).toHaveLength(4);
      expect(files.map(f => f.name).sort()).toEqual([
        'SKILL.md',
        'a/b/c/file3.ts',
        'a/b/file2.ts',
        'a/file1.ts',
      ]);
    });

    it('preserves file content correctly', () => {
      const content = `---
name: Test
---

# Test Skill

Multi-line
content
here.`;
      writeFileSync(join(tempDir, 'SKILL.md'), content);

      const files = loadSkillFiles(tempDir);

      expect(files[0].content).toBe(content);
    });
  });

  describe('isApiKeyConfigured', () => {
    const originalEnv = process.env.ANTHROPIC_API_KEY;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalEnv;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('returns true when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      expect(isApiKeyConfigured()).toBe(true);
    });

    it('returns false when ANTHROPIC_API_KEY is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(isApiKeyConfigured()).toBe(false);
    });

    it('returns false when ANTHROPIC_API_KEY is empty string', () => {
      process.env.ANTHROPIC_API_KEY = '';
      expect(isApiKeyConfigured()).toBe(false);
    });
  });
});
