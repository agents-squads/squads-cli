import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isPersonalEmail,
  getEmailDomain,
  saveSession,
  loadSession,
  clearSession,
  isLoggedIn,
  type AuthSession,
} from '../src/lib/auth.js';

describe('auth utilities', () => {
  describe('isPersonalEmail', () => {
    it('rejects gmail.com', () => {
      expect(isPersonalEmail('user@gmail.com')).toBe(true);
    });

    it('rejects googlemail.com', () => {
      expect(isPersonalEmail('user@googlemail.com')).toBe(true);
    });

    it('rejects yahoo.com', () => {
      expect(isPersonalEmail('user@yahoo.com')).toBe(true);
    });

    it('rejects yahoo regional domains', () => {
      expect(isPersonalEmail('user@yahoo.co.uk')).toBe(true);
      expect(isPersonalEmail('user@yahoo.fr')).toBe(true);
    });

    it('rejects hotmail.com', () => {
      expect(isPersonalEmail('user@hotmail.com')).toBe(true);
    });

    it('rejects outlook.com', () => {
      expect(isPersonalEmail('user@outlook.com')).toBe(true);
    });

    it('rejects live.com', () => {
      expect(isPersonalEmail('user@live.com')).toBe(true);
    });

    it('rejects icloud.com', () => {
      expect(isPersonalEmail('user@icloud.com')).toBe(true);
    });

    it('rejects protonmail.com', () => {
      expect(isPersonalEmail('user@protonmail.com')).toBe(true);
    });

    it('rejects proton.me', () => {
      expect(isPersonalEmail('user@proton.me')).toBe(true);
    });

    it('rejects hey.com', () => {
      expect(isPersonalEmail('user@hey.com')).toBe(true);
    });

    it('accepts business domains', () => {
      expect(isPersonalEmail('user@acme.com')).toBe(false);
      expect(isPersonalEmail('user@company.io')).toBe(false);
      expect(isPersonalEmail('user@startup.co')).toBe(false);
    });

    it('accepts agents-squads.com', () => {
      expect(isPersonalEmail('user@agents-squads.com')).toBe(false);
    });

    it('handles uppercase domains', () => {
      expect(isPersonalEmail('user@GMAIL.COM')).toBe(true);
      expect(isPersonalEmail('user@Gmail.Com')).toBe(true);
    });

    it('returns false for invalid email without @', () => {
      expect(isPersonalEmail('invalid')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isPersonalEmail('')).toBe(false);
    });
  });

  describe('getEmailDomain', () => {
    it('extracts domain from email', () => {
      expect(getEmailDomain('user@example.com')).toBe('example.com');
    });

    it('returns lowercase domain', () => {
      expect(getEmailDomain('user@EXAMPLE.COM')).toBe('example.com');
    });

    it('handles subdomains', () => {
      expect(getEmailDomain('user@mail.example.com')).toBe('mail.example.com');
    });

    it('returns empty string for missing @', () => {
      expect(getEmailDomain('invalid')).toBe('');
    });

    it('returns empty string for empty input', () => {
      expect(getEmailDomain('')).toBe('');
    });

    it('handles email with multiple @ symbols', () => {
      // Split on @ returns first part, so second @ goes to domain
      expect(getEmailDomain('user@domain@extra.com')).toBe('domain');
    });
  });
});

// Note: Session management tests (saveSession, loadSession, clearSession, isLoggedIn)
// require mocking the filesystem or HOME directory to avoid polluting the user's
// actual auth file. These would be better suited for integration tests or require
// dependency injection to be properly unit tested.
