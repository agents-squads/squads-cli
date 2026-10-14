import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isAuthConfigured,
  getEmailDomain,
  saveSession,
  loadSession,
  clearSession,
  isLoggedIn,
  type AuthSession,
} from '../src/lib/auth.js';

describe('auth utilities', () => {
  describe('isAuthConfigured', () => {
    const original = process.env.SQUADS_AUTH_URL;

    afterEach(() => {
      // Restore — never leak env state across tests.
      if (original === undefined) delete process.env.SQUADS_AUTH_URL;
      else process.env.SQUADS_AUTH_URL = original;
    });

    it('returns false when SQUADS_AUTH_URL is unset', () => {
      delete process.env.SQUADS_AUTH_URL;
      expect(isAuthConfigured()).toBe(false);
    });

    it('returns false when SQUADS_AUTH_URL is empty', () => {
      process.env.SQUADS_AUTH_URL = '';
      expect(isAuthConfigured()).toBe(false);
    });

    it('returns false when SQUADS_AUTH_URL is whitespace-only', () => {
      process.env.SQUADS_AUTH_URL = '   ';
      expect(isAuthConfigured()).toBe(false);
    });

    it('returns true when SQUADS_AUTH_URL is set', () => {
      process.env.SQUADS_AUTH_URL = 'https://auth.example.com';
      expect(isAuthConfigured()).toBe(true);
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
