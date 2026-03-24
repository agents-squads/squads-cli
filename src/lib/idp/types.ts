/**
 * IDP type definitions — mirrors the YAML schema in the idp/ repo.
 */

export interface CatalogEntry {
  apiVersion: string;
  kind: 'Service';
  metadata: {
    name: string;
    description: string;
    owner: string;
    repo: string;
    tags: string[];
  };
  spec: {
    type: 'product' | 'domain';
    stack: string;
    framework?: string;
    runtime?: string;
    language_version?: string;
    branches: {
      default: string;
      development?: string | null;
      workflow: 'pr-to-develop' | 'direct-to-main';
    };
    ci: {
      template: string | null;
      required_checks: string[];
      test_command?: string | null;
      build_command?: string | null;
      coverage_threshold?: number;
    };
    deploy?: {
      target: string;
      trigger: string;
      pipeline?: string;
      environments?: Array<{
        name: string;
        url: string;
      }>;
    } | null;
    health: Array<{
      name: string;
      url: string;
      type: 'http' | 'json';
      expect: number;
    }>;
    dependencies: {
      runtime: Array<{
        service: string;
        version?: string;
        type?: string;
        required?: boolean;
        description: string;
      }>;
    };
    scorecard: string;
  };
}

export interface ScorecardDefinition {
  apiVersion: string;
  kind: 'Scorecard';
  metadata: {
    name: string;
    description: string;
  };
  checks: Array<{
    name: string;
    description: string;
    weight: number;
    source: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    threshold?: {
      min: number;
      unit: string;
    };
  }>;
  grades: Record<string, { min: number }>;
}

export interface DependencyGraph {
  apiVersion: string;
  kind: 'DependencyGraph';
  metadata: {
    name: string;
    description: string;
    updated: string;
  };
  edges: Array<{
    consumer: string;
    provider: string;
    type: string;
    required?: boolean;
    contract?: string;
    description: string;
  }>;
  deploy_order: string[][];
}

export interface ScorecardResult {
  service: string;
  scorecard: string;
  score: number;
  grade: string;
  checks: Array<{
    name: string;
    passed: boolean;
    weight: number;
    detail: string;
  }>;
  timestamp: string;
}
