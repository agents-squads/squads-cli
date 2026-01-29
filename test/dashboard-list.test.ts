/**
 * Tests for dashboard list renderer utilities
 * Tests list rendering functions
 */

import { describe, it, expect, vi } from 'vitest';
import { renderList, renderDetailedList, renderRecentList } from '../src/lib/dashboard/renderers/list.js';
import type { ViewDefinition, QueryResult } from '../src/lib/dashboard/types.js';

// Helper to strip ANSI codes for easier assertion
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('renderList', () => {
  describe('empty data', () => {
    it('should show "No data" message for empty rows', () => {
      const view: ViewDefinition = { id: 'test', type: 'list' };
      const data: QueryResult = { rows: [], columns: [] };

      const lines = renderList(view, data);

      expect(lines).toHaveLength(1);
      expect(stripAnsi(lines[0])).toContain('No data');
    });
  });

  describe('with title', () => {
    it('should render title when provided', () => {
      const view: ViewDefinition = { id: 'test', type: 'list', title: 'Test List' };
      const data: QueryResult = {
        rows: [{ name: 'Item 1' }],
        columns: ['name'],
      };

      const lines = renderList(view, data);

      expect(stripAnsi(lines[0])).toContain('Test List');
    });

    it('should add empty line after title', () => {
      const view: ViewDefinition = { id: 'test', type: 'list', title: 'Test' };
      const data: QueryResult = {
        rows: [{ name: 'Item 1' }],
        columns: ['name'],
      };

      const lines = renderList(view, data);

      // Title, empty line, then data
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[1]).toBe('');
    });
  });

  describe('column rendering', () => {
    it('should infer columns from data when not specified', () => {
      const view: ViewDefinition = { id: 'test', type: 'list' };
      const data: QueryResult = {
        rows: [{ name: 'Alice', age: 30 }],
        columns: ['name', 'age'],
      };

      const lines = renderList(view, data);

      // Should contain both values
      const dataLine = stripAnsi(lines[0]);
      expect(dataLine).toContain('Alice');
      expect(dataLine).toContain('30');
    });

    it('should use explicit columns when provided', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [{ field: 'name', label: 'Name' }],
      };
      const data: QueryResult = {
        rows: [{ name: 'Alice', age: 30, hidden: 'secret' }],
        columns: ['name', 'age', 'hidden'],
      };

      const lines = renderList(view, data);
      const dataLine = stripAnsi(lines[0]);

      // Should only show name field
      expect(dataLine).toContain('Alice');
      expect(dataLine).not.toContain('secret');
    });

    it('should render column label prefix when provided', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [{ field: 'count', label: 'Total' }],
      };
      const data: QueryResult = {
        rows: [{ count: 42 }],
        columns: ['count'],
      };

      const lines = renderList(view, data);
      const dataLine = stripAnsi(lines[0]);

      expect(dataLine).toContain('Total:');
      expect(dataLine).toContain('42');
    });

    it('should format values based on column format', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [{ field: 'amount', format: 'currency' }],
      };
      const data: QueryResult = {
        rows: [{ amount: 99.50 }],
        columns: ['amount'],
      };

      const lines = renderList(view, data);
      const dataLine = stripAnsi(lines[0]);

      expect(dataLine).toContain('$99.50');
    });
  });

  describe('multiple rows', () => {
    it('should render each row on its own line', () => {
      const view: ViewDefinition = { id: 'test', type: 'list' };
      const data: QueryResult = {
        rows: [
          { name: 'First' },
          { name: 'Second' },
          { name: 'Third' },
        ],
        columns: ['name'],
      };

      const lines = renderList(view, data);

      expect(lines).toHaveLength(3);
      expect(stripAnsi(lines[0])).toContain('First');
      expect(stripAnsi(lines[1])).toContain('Second');
      expect(stripAnsi(lines[2])).toContain('Third');
    });
  });
});

describe('renderDetailedList', () => {
  describe('empty data', () => {
    it('should show "No data" message for empty rows', () => {
      const view: ViewDefinition = { id: 'test', type: 'list' };
      const data: QueryResult = { rows: [], columns: [] };

      const lines = renderDetailedList(view, data);

      expect(lines).toHaveLength(1);
      expect(stripAnsi(lines[0])).toContain('No data');
    });
  });

  describe('with title', () => {
    it('should render title when provided', () => {
      const view: ViewDefinition = { id: 'test', type: 'list', title: 'Details' };
      const data: QueryResult = {
        rows: [{ name: 'Item' }],
        columns: ['name'],
      };

      const lines = renderDetailedList(view, data);

      expect(stripAnsi(lines[0])).toContain('Details');
    });
  });

  describe('multi-line rendering', () => {
    it('should render first column as header', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [
          { field: 'name' },
          { field: 'status' },
        ],
      };
      const data: QueryResult = {
        rows: [{ name: 'Task A', status: 'pending' }],
        columns: ['name', 'status'],
      };

      const lines = renderDetailedList(view, data);

      // First column value should be on its own line
      const nameLine = lines.find(l => stripAnsi(l).includes('Task A'));
      expect(nameLine).toBeDefined();
    });

    it('should render remaining columns as indented details', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [
          { field: 'name' },
          { field: 'status', label: 'Status' },
        ],
      };
      const data: QueryResult = {
        rows: [{ name: 'Task A', status: 'pending' }],
        columns: ['name', 'status'],
      };

      const lines = renderDetailedList(view, data);

      // Find the status detail line
      const statusLine = lines.find(l => stripAnsi(l).includes('Status:'));
      expect(statusLine).toBeDefined();
      expect(stripAnsi(statusLine!)).toContain('pending');
    });

    it('should add spacing between items', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [{ field: 'name' }, { field: 'value' }],
      };
      const data: QueryResult = {
        rows: [
          { name: 'Item 1', value: 'A' },
          { name: 'Item 2', value: 'B' },
        ],
        columns: ['name', 'value'],
      };

      const lines = renderDetailedList(view, data);

      // Should have empty line between items
      const emptyLineIndex = lines.findIndex(l => l === '');
      expect(emptyLineIndex).toBeGreaterThan(0);
    });
  });
});

describe('renderRecentList', () => {
  describe('empty data', () => {
    it('should show "No recent items" message for empty rows', () => {
      const view: ViewDefinition = { id: 'test', type: 'list' };
      const data: QueryResult = { rows: [], columns: [] };

      const lines = renderRecentList(view, data);

      expect(lines).toHaveLength(1);
      expect(stripAnsi(lines[0])).toContain('No recent items');
    });
  });

  describe('with title', () => {
    it('should render title when provided', () => {
      const view: ViewDefinition = { id: 'test', type: 'list', title: 'Recent Activity' };
      const data: QueryResult = {
        rows: [{ name: 'Event' }],
        columns: ['name'],
      };

      const lines = renderRecentList(view, data);

      expect(stripAnsi(lines[0])).toContain('Recent Activity');
    });
  });

  describe('time column handling', () => {
    it('should detect time column by format', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [
          { field: 'created', format: 'relative_time' },
          { field: 'message' },
        ],
      };
      const data: QueryResult = {
        rows: [{ created: new Date().toISOString(), message: 'Hello' }],
        columns: ['created', 'message'],
      };

      const lines = renderRecentList(view, data);

      // Time should be rendered
      const dataLine = stripAnsi(lines[lines.length - 1]);
      expect(dataLine).toContain('Hello');
    });

    it('should detect time column by field name containing _at', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [
          { field: 'updated_at' },
          { field: 'name' },
        ],
      };
      const data: QueryResult = {
        rows: [{ updated_at: new Date().toISOString(), name: 'Test' }],
        columns: ['updated_at', 'name'],
      };

      const lines = renderRecentList(view, data);

      const dataLine = stripAnsi(lines[lines.length - 1]);
      expect(dataLine).toContain('Test');
    });
  });

  describe('multiple rows', () => {
    it('should render each row on its own line', () => {
      const view: ViewDefinition = {
        id: 'test',
        type: 'list',
        columns: [{ field: 'event' }],
      };
      const data: QueryResult = {
        rows: [
          { event: 'Login' },
          { event: 'Logout' },
        ],
        columns: ['event'],
      };

      const lines = renderRecentList(view, data);

      expect(lines.some(l => stripAnsi(l).includes('Login'))).toBe(true);
      expect(lines.some(l => stripAnsi(l).includes('Logout'))).toBe(true);
    });
  });
});
