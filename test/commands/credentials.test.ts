import { describe, it, expect } from 'vitest';
import { parseGcpCredentials } from '../../src/commands/credentials.js';

describe('parseGcpCredentials', () => {
  it('parses roles and apis from inline YAML format', () => {
    const content = `# My Squad

credentials:
  gcp:
    roles: [roles/bigquery.dataViewer, roles/bigquery.jobUser]
    apis: [bigquery.googleapis.com]
`;
    const result = parseGcpCredentials(content);
    expect(result).not.toBeNull();
    expect(result!.roles).toEqual(['roles/bigquery.dataViewer', 'roles/bigquery.jobUser']);
    expect(result!.apis).toEqual(['bigquery.googleapis.com']);
    expect(result!.description).toBe('2 roles, 1 APIs');
  });

  it('parses quoted values', () => {
    const content = `credentials:
  gcp:
    roles: ['roles/storage.admin', "roles/run.developer"]
    apis: ['storage.googleapis.com']
`;
    const result = parseGcpCredentials(content);
    expect(result).not.toBeNull();
    expect(result!.roles).toEqual(['roles/storage.admin', 'roles/run.developer']);
    expect(result!.apis).toEqual(['storage.googleapis.com']);
  });

  it('parses multiple APIs', () => {
    const content = `credentials:
  gcp:
    roles: [roles/cloudsql.admin, roles/run.developer, roles/secretmanager.secretAccessor]
    apis: [sqladmin.googleapis.com, run.googleapis.com, secretmanager.googleapis.com]
`;
    const result = parseGcpCredentials(content);
    expect(result).not.toBeNull();
    expect(result!.roles).toHaveLength(3);
    expect(result!.apis).toHaveLength(3);
  });

  it('returns null when no credentials block exists', () => {
    const content = `# My Squad

mission: Do great things
`;
    expect(parseGcpCredentials(content)).toBeNull();
  });

  it('returns null when gcp block has no roles or apis', () => {
    const content = `credentials:
  github:
    token: ghp_xxx
`;
    expect(parseGcpCredentials(content)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGcpCredentials('')).toBeNull();
  });

  it('parses roles even without apis', () => {
    const content = `credentials:
  gcp:
    roles: [roles/viewer]
`;
    const result = parseGcpCredentials(content);
    expect(result).not.toBeNull();
    expect(result!.roles).toEqual(['roles/viewer']);
    expect(result!.apis).toEqual([]);
  });

  it('handles credentials block mixed with other SQUAD.md content', () => {
    const content = `# Engineering Squad

mission: Build and maintain infrastructure

agents:
  - name: infra-lead
    role: orchestrates deployments

credentials:
  gcp:
    roles: [roles/cloudsql.admin, roles/run.developer]
    apis: [sqladmin.googleapis.com, run.googleapis.com]

model:
  default: sonnet
`;
    const result = parseGcpCredentials(content);
    expect(result).not.toBeNull();
    expect(result!.roles).toEqual(['roles/cloudsql.admin', 'roles/run.developer']);
    expect(result!.apis).toEqual(['sqladmin.googleapis.com', 'run.googleapis.com']);
  });
});
