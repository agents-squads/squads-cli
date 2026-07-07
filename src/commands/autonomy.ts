import {
  colors,
  RESET,
  gradient,
  icons,
  writeLine,
  bold,
} from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';
import { getEnv } from '../lib/env-config.js';

interface AutonomyOptions {
  squad?: string;
  period?: 'today' | 'week' | 'month';
  json?: boolean;
}

interface AutonomyScore {
  overall_score: number;
  confidence_level: string;
  period: string;
  squad: string | null;
  components: {
    quota_compliance: number;
    cooldown_compliance: number;
    quality_score: number;
    success_rate: number;
    learning_utilization: number;
  };
  execution_stats: {
    total_tasks: number;
    successful_tasks: number;
    monthly_used: number;
    monthly_quota: number;
    quota_pct: number;
    learning_count: number;
  };
  error?: string;
}

/**
 * Display autonomy score and confidence metrics.
 * Shows how ready the system is for autonomous operation.
 */
export async function autonomyCommand(options: AutonomyOptions = {}): Promise<void> {
  const bridgeUrl = getEnv().bridge_url;
  const period = options.period || 'today';


  try {
    const params = new URLSearchParams({ period });
    if (options.squad) params.append('squad', options.squad);

    const response = await fetch(`${bridgeUrl}/api/autonomy/score?${params}`);
    const data = await response.json() as AutonomyScore;

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    writeLine();
    writeLine(`  ${gradient('squads')} ${colors.dim}autonomy${RESET}`);
    writeLine();

    // Overall score with visual indicator
    const score = data.overall_score;
    const confidence = data.confidence_level;
    const scoreColor = score >= 75 ? colors.green : score >= 50 ? colors.yellow : colors.red;
    const confidenceIcon = confidence === 'high' ? icons.success : confidence === 'medium' ? icons.warning : icons.error;

    writeLine(`  ${bold}Overall Score${RESET}  ${scoreColor}${score}%${RESET}  ${confidenceIcon} ${confidence} confidence`);
    writeLine();

    // Progress bar
    const barWidth = 40;
    const filled = Math.round((score / 100) * barWidth);
    const bar = `${scoreColor}${'█'.repeat(filled)}${colors.dim}${'░'.repeat(barWidth - filled)}${RESET}`;
    writeLine(`  ${bar}`);
    writeLine();

    // Component scores
    writeLine(`  ${bold}Components${RESET}`);
    writeLine();

    const components = [
      { name: 'Quota Compliance', score: data.components.quota_compliance, weight: '25%' },
      { name: 'Success Rate', score: data.components.success_rate, weight: '25%' },
      { name: 'Quality Score', score: data.components.quality_score, weight: '20%' },
      { name: 'Cooldown Compliance', score: data.components.cooldown_compliance, weight: '15%' },
      { name: 'Learning Utilization', score: data.components.learning_utilization, weight: '15%' },
    ];

    for (const comp of components) {
      const compColor = comp.score >= 75 ? colors.green : comp.score >= 50 ? colors.yellow : colors.red;
      const compBar = `${compColor}${'█'.repeat(Math.round(comp.score / 5))}${colors.dim}${'░'.repeat(20 - Math.round(comp.score / 5))}${RESET}`;
      writeLine(`  ${comp.name.padEnd(22)} ${compBar} ${compColor}${comp.score}%${RESET} ${colors.dim}(${comp.weight})${RESET}`);
    }

    writeLine();

    // Execution stats
    writeLine(`  ${bold}Stats${RESET} ${colors.dim}(${period})${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Tasks:${RESET}     ${data.execution_stats.successful_tasks}/${data.execution_stats.total_tasks} successful`);
    writeLine(`  ${colors.dim}Quota:${RESET}     $${data.execution_stats.monthly_used}/$${data.execution_stats.monthly_quota}/mo (${data.execution_stats.quota_pct}%)`);
    writeLine(`  ${colors.dim}Learnings:${RESET} ${data.execution_stats.learning_count} captured`);

    if (options.squad) {
      writeLine(`  ${colors.dim}Squad:${RESET}     ${options.squad}`);
    }

    writeLine();

    // Recommendations
    if (score < 75) {
      writeLine(`  ${bold}Recommendations${RESET}`);
      writeLine();

      if (data.components.learning_utilization < 50) {
        writeLine(`  ${icons.empty} Capture more learnings: ${colors.dim}squads learn "..."${RESET}`);
      }
      if (data.components.quality_score < 70) {
        writeLine(`  ${icons.empty} Add feedback after runs: ${colors.dim}squads feedback add <squad> <1-5>${RESET}`);
      }
      if (data.components.quota_compliance < 80) {
        writeLine(`  ${icons.empty} Approaching monthly quota limit - consider upgrading plan`);
      }
      if (data.execution_stats.total_tasks === 0) {
        writeLine(`  ${icons.empty} Run some agents: ${colors.dim}squads run <squad> --execute${RESET}`);
      }

      writeLine();
    }

    // Next steps
    writeLine(`  ${colors.dim}$${RESET} squads autonomy --period=week   ${colors.dim}Weekly view${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads memory sync --dimensions  ${colors.dim}Sync to Postgres${RESET}`);
    writeLine();

  } catch (error) {
    writeLine();
    writeLine(`  ${gradient('squads')} ${colors.dim}autonomy${RESET}`);
    writeLine();
    writeLine(`  ${icons.error} ${colors.red}Failed to fetch autonomy score${RESET}`);
    writeLine(`  ${colors.dim}${error}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}API unavailable. Run \`squads login\` to connect.${RESET}`);
    writeLine();
  }
}
