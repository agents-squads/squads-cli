import { findSquadsDir, loadSquad, setSquadPauseState, findSimilarSquads, listSquads } from '../lib/squad-parser.js';
import { colors, bold, RESET, gradient, icons, writeLine } from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';

interface PauseOptions {
  reason?: string;
  json?: boolean;
}

interface ResumeOptions {
  json?: boolean;
}

export async function pauseCommand(
  squadName: string,
  options: PauseOptions = {}
): Promise<void> {

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'pause', error: 'No .agents/squads directory found' }, null, 2));
    } else {
      writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
      writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    }
    process.exit(1);
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    const similar = findSimilarSquads(squadName, listSquads(squadsDir));
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'pause', error: `Squad "${squadName}" not found` }, null, 2));
    } else {
      writeLine(`  ${colors.red}Squad "${squadName}" not found.${RESET}`);
      if (similar.length > 0) {
        writeLine(`  ${colors.dim}Did you mean: ${similar.join(', ')}?${RESET}`);
      }
    }
    process.exit(1);
  }

  if (squad.status === 'paused') {
    const since = squad.paused_since ? ` since ${squad.paused_since}` : '';
    const reason = squad.paused_reason ? ` (${squad.paused_reason})` : '';
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'pause', error: `Squad "${squadName}" is already paused${since}${reason}` }, null, 2));
    } else {
      writeLine(`  ${colors.yellow}${icons.warning} Squad "${squadName}" is already paused${since}${reason}.${RESET}`);
    }
    process.exit(1);
  }

  const ok = setSquadPauseState(squadName, true, options.reason);
  if (!ok) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'pause', error: 'Failed to write SQUAD.md' }, null, 2));
    } else {
      writeLine(`  ${colors.red}Failed to write SQUAD.md for "${squadName}".${RESET}`);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      command: 'pause',
      data: { squad: squadName, reason: options.reason || null, paused_since: new Date().toISOString() },
    }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}pause${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();
  writeLine(`  ${colors.yellow}${icons.warning} ${bold}${squadName}${RESET} is now ${colors.yellow}paused${RESET}.`);
  if (options.reason) {
    writeLine(`  ${colors.dim}Reason: ${options.reason}${RESET}`);
  }
  writeLine();
  writeLine(`  ${colors.dim}Enforcement:${RESET}`);
  writeLine(`  ${colors.dim}• \`squads run ${squadName}\` will refuse until resumed${RESET}`);
  writeLine(`  ${colors.dim}• \`squads run --org\` will skip this squad${RESET}`);
  writeLine(`  ${colors.dim}• Scheduled dispatch will skip this squad${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}To resume: squads resume ${squadName}${RESET}`);
  writeLine(`  ${colors.dim}To force-run anyway: squads run ${squadName} --force${RESET}`);
  writeLine();
}

export async function resumeCommand(
  squadName: string,
  options: ResumeOptions = {}
): Promise<void> {

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'resume', error: 'No .agents/squads directory found' }, null, 2));
    } else {
      writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
      writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    }
    process.exit(1);
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    const similar = findSimilarSquads(squadName, listSquads(squadsDir));
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'resume', error: `Squad "${squadName}" not found` }, null, 2));
    } else {
      writeLine(`  ${colors.red}Squad "${squadName}" not found.${RESET}`);
      if (similar.length > 0) {
        writeLine(`  ${colors.dim}Did you mean: ${similar.join(', ')}?${RESET}`);
      }
    }
    process.exit(1);
  }

  if (squad.status !== 'paused') {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, command: 'resume', action: 'noop', message: `Squad "${squadName}" is already active` }, null, 2));
    } else {
      writeLine(`  ${colors.yellow}${icons.warning} Squad "${squadName}" is not paused — nothing to do.${RESET}`);
    }
    return;
  }

  const ok = setSquadPauseState(squadName, false);
  if (!ok) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'resume', error: 'Failed to write SQUAD.md' }, null, 2));
    } else {
      writeLine(`  ${colors.red}Failed to write SQUAD.md for "${squadName}".${RESET}`);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: true, command: 'resume', data: { squad: squadName } }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}resume${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();
  writeLine(`  ${colors.green}${icons.success} ${bold}${squadName}${RESET} is now ${colors.green}active${RESET}.`);
  writeLine();
  writeLine(`  ${colors.dim}Run: squads run ${squadName}${RESET}`);
  writeLine();
}
