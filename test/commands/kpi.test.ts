import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: {
    CLI_KPI_SHOW: 'cli.kpi.show',
    CLI_KPI_RECORD: 'cli.kpi.record',
    CLI_KPI_TREND: 'cli.kpi.trend',
    CLI_KPI_INSIGHTS: 'cli.kpi.insights',
    CLI_KPI_LIST: 'cli.kpi.list',
  },
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  loadSquad: vi.fn(),
  findSquadsDir: vi.fn(),
  listSquads: vi.fn(),
}));

vi.mock('../../src/lib/kpi.js', () => ({
  recordKpiValue: vi.fn(),
  getKpiState: vi.fn(),
  generateKpiInsight: vi.fn(),
  parseKpiDefinitions: vi.fn(),
  getValuesForPeriod: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '', white: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: { success: '✓', error: '✗', warning: '!', progress: '›' },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

import {
  kpiShowCommand,
  kpiRecordCommand,
  kpiTrendCommand,
  kpiInsightsCommand,
  kpiListCommand,
} from '../../src/commands/kpi.js';
import { loadSquad, findSquadsDir, listSquads } from '../../src/lib/squad-parser.js';
import {
  recordKpiValue,
  getKpiState,
  generateKpiInsight,
  parseKpiDefinitions,
  getValuesForPeriod,
} from '../../src/lib/kpi.js';

const mockLoadSquad = vi.mocked(loadSquad);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockListSquads = vi.mocked(listSquads);
const mockRecordKpiValue = vi.mocked(recordKpiValue);
const mockGetKpiState = vi.mocked(getKpiState);
const mockGenerateKpiInsight = vi.mocked(generateKpiInsight);
const mockParseKpiDefinitions = vi.mocked(parseKpiDefinitions);
const mockGetValuesForPeriod = vi.mocked(getValuesForPeriod);

const sampleSquad = {
  name: 'marketing',
  mission: 'Grow audience',
  goals: [],
  context: {},
  agents: [],
  pipelines: [],
  routines: [],
  frontmatter: { kpis: [] },
};

const sampleDefinition = {
  name: 'leads_generated',
  target: 10,
  unit: 'leads',
  period: 'weekly' as const,
  description: 'Number of new leads per week',
};

const sampleKpi = {
  name: 'leads_generated',
  definition: sampleDefinition,
  history: [],
  trend: 'stable' as const,
  lastValue: undefined,
  lastRecordedAt: undefined,
};

describe('kpiShowCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockParseKpiDefinitions.mockReturnValue([sampleDefinition]);
    mockGetKpiState.mockReturnValue(sampleKpi);
    mockGenerateKpiInsight.mockReturnValue(null);
  });

  it('handles squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    await expect(kpiShowCommand('nonexistent')).resolves.toBeUndefined();
  });

  it('handles no KPIs defined', async () => {
    mockParseKpiDefinitions.mockReturnValue([]);
    await expect(kpiShowCommand('marketing')).resolves.toBeUndefined();
  });

  it('shows KPIs with insights', async () => {
    mockGenerateKpiInsight.mockReturnValue('📈 leads_generated: 8/10 leads (80%)');
    await expect(kpiShowCommand('marketing')).resolves.toBeUndefined();
  });

  it('shows KPIs without insights (no data)', async () => {
    mockGenerateKpiInsight.mockReturnValue(null);
    await expect(kpiShowCommand('marketing')).resolves.toBeUndefined();
  });

  it('outputs JSON when requested', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kpiShowCommand('marketing', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('shows KPI with description', async () => {
    mockGetKpiState.mockReturnValue({ ...sampleKpi });
    await expect(kpiShowCommand('marketing')).resolves.toBeUndefined();
  });
});

describe('kpiRecordCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockParseKpiDefinitions.mockReturnValue([sampleDefinition]);
    mockRecordKpiValue.mockReturnValue({
      value: 8,
      recordedAt: new Date().toISOString(),
      note: undefined,
    } as ReturnType<typeof recordKpiValue>);
  });

  it('handles squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    await expect(kpiRecordCommand('nonexistent', 'leads_generated', '8')).resolves.toBeUndefined();
  });

  it('handles KPI not found in squad', async () => {
    await expect(kpiRecordCommand('marketing', 'unknown_kpi', '8')).resolves.toBeUndefined();
    expect(mockRecordKpiValue).not.toHaveBeenCalled();
  });

  it('records a valid KPI value', async () => {
    await expect(kpiRecordCommand('marketing', 'leads_generated', '8')).resolves.toBeUndefined();
    expect(mockRecordKpiValue).toHaveBeenCalledWith('marketing', 'leads_generated', 8, undefined);
  });

  it('records a KPI value with note', async () => {
    await expect(kpiRecordCommand('marketing', 'leads_generated', '8', { note: 'Great week' })).resolves.toBeUndefined();
    expect(mockRecordKpiValue).toHaveBeenCalledWith('marketing', 'leads_generated', 8, 'Great week');
  });

  it('rejects invalid numeric value', async () => {
    await expect(kpiRecordCommand('marketing', 'leads_generated', 'notanumber')).resolves.toBeUndefined();
    expect(mockRecordKpiValue).not.toHaveBeenCalled();
  });

  it('outputs JSON when requested', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kpiRecordCommand('marketing', 'leads_generated', '8', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('shows available KPIs when KPI not found', async () => {
    mockParseKpiDefinitions.mockReturnValue([sampleDefinition, { ...sampleDefinition, name: 'other_kpi' }]);
    await expect(kpiRecordCommand('marketing', 'wrong_kpi', '5')).resolves.toBeUndefined();
    expect(mockRecordKpiValue).not.toHaveBeenCalled();
  });
});

describe('kpiTrendCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockParseKpiDefinitions.mockReturnValue([sampleDefinition]);
    mockGetKpiState.mockReturnValue(sampleKpi);
    mockGetValuesForPeriod.mockReturnValue([]);
  });

  it('handles squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    await expect(kpiTrendCommand('nonexistent', 'leads_generated')).resolves.toBeUndefined();
  });

  it('handles KPI not found', async () => {
    await expect(kpiTrendCommand('marketing', 'unknown_kpi')).resolves.toBeUndefined();
  });

  it('shows trend with no data', async () => {
    await expect(kpiTrendCommand('marketing', 'leads_generated')).resolves.toBeUndefined();
  });

  it('shows trend with data', async () => {
    mockGetValuesForPeriod.mockReturnValue([
      { value: 5, recordedAt: new Date().toISOString() },
      { value: 8, recordedAt: new Date().toISOString() },
    ] as ReturnType<typeof getValuesForPeriod>);
    await expect(kpiTrendCommand('marketing', 'leads_generated')).resolves.toBeUndefined();
  });

  it('outputs JSON when requested', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kpiTrendCommand('marketing', 'leads_generated', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('kpiInsightsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockParseKpiDefinitions.mockReturnValue([sampleDefinition]);
    mockGetKpiState.mockReturnValue(sampleKpi);
    mockGenerateKpiInsight.mockReturnValue(null);
  });

  it('handles squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    await expect(kpiInsightsCommand('nonexistent')).resolves.toBeUndefined();
  });

  it('handles no KPIs defined', async () => {
    mockParseKpiDefinitions.mockReturnValue([]);
    await expect(kpiInsightsCommand('marketing')).resolves.toBeUndefined();
  });

  it('resolves with KPIs but no insights', async () => {
    await expect(kpiInsightsCommand('marketing')).resolves.toBeUndefined();
  });

  it('resolves with insights available', async () => {
    mockGenerateKpiInsight.mockReturnValue('📈 leads_generated on track');
    await expect(kpiInsightsCommand('marketing')).resolves.toBeUndefined();
  });
});

describe('kpiListCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['marketing', 'engineering']);
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockParseKpiDefinitions.mockReturnValue([sampleDefinition]);
    mockGetKpiState.mockReturnValue(sampleKpi);
  });

  it('handles no squads dir', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    await expect(kpiListCommand()).resolves.toBeUndefined();
  });

  it('lists KPIs across all squads', async () => {
    await expect(kpiListCommand()).resolves.toBeUndefined();
  });

  it('handles squads with no KPIs', async () => {
    mockParseKpiDefinitions.mockReturnValue([]);
    await expect(kpiListCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when requested', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await kpiListCommand({ json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
