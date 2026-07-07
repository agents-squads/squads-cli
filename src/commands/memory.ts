import {
  findMemoryDir,
  searchMemory,
  getSquadState,
  appendToMemory,
  listMemoryEntries
} from '../lib/memory.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { checkServiceAvailable, showServiceSetupGuide } from '../lib/services.js';
import { track, Events } from '../lib/telemetry.js';
import { getEnv } from '../lib/env-config.js';

function getBridgeUrl(): string {
  return getEnv().bridge_url;
}

function getMem0Url(): string {
  return process.env.MEM0_API_URL || '';
}

interface MemoryOptions {
  squad?: string;
  agent?: string;
  type?: string;
}

export async function memoryQueryCommand(
  query: string,
  options: MemoryOptions
): Promise<void> {
  await track(Events.CLI_MEMORY_QUERY, { squad: options.squad, agent: options.agent });
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory query${RESET} "${colors.cyan}${query}${RESET}"`);
  writeLine();

  const results = searchMemory(query, memoryDir);

  if (results.length === 0) {
    writeLine(`  ${colors.yellow}No results found.${RESET}`);
    writeLine();
    return;
  }

  // Filter by squad/agent if specified
  let filtered = results;
  if (options.squad) {
    filtered = filtered.filter(r => r.entry.squad === options.squad);
  }
  if (options.agent) {
    filtered = filtered.filter(r => r.entry.agent === options.agent);
  }

  writeLine(`  ${colors.green}${filtered.length}${RESET} results found`);
  writeLine();

  // Table
  const w = { location: 28, type: 10, score: 8 };
  const tableWidth = w.location + w.type + w.score + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('LOCATION', w.location)}${RESET}` +
    `${bold}${padEnd('TYPE', w.type)}${RESET}` +
    `${bold}SCORE${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const result of filtered.slice(0, 8)) {
    const { entry, score } = result;
    const location = `${entry.squad}/${entry.agent}`;
    const scoreColor = score > 5 ? colors.green : score > 2 ? colors.yellow : colors.dim;

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(location, w.location)}${RESET}` +
      `${colors.dim}${padEnd(entry.type, w.type)}${RESET}` +
      `${scoreColor}${padEnd(score.toFixed(1), w.score)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Show matches
  writeLine(`  ${bold}Matches${RESET}`);
  writeLine();

  for (const result of filtered.slice(0, 5)) {
    const { entry, matches } = result;

    for (const match of matches.slice(0, 2)) {
      const highlighted = match.replace(
        new RegExp(query, 'gi'),
        (m) => `${colors.yellow}${m}${RESET}`
      );
      writeLine(`  ${icons.empty} ${truncate(highlighted, 60)}`);
      writeLine(`    ${colors.dim}└ ${entry.squad}/${entry.agent}${RESET}`);
    }
  }

  if (filtered.length > 5) {
    writeLine(`  ${colors.dim}  +${filtered.length - 5} more results${RESET}`);
  }
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}<squad>${RESET}   ${colors.dim}View full memory${RESET}`);
  writeLine();
}

export async function memoryShowCommand(
  squadName: string,
  _options: MemoryOptions
): Promise<void> {
  await track(Events.CLI_MEMORY_SHOW, { squad: squadName });
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    process.exit(1);
  }

  const states = getSquadState(squadName);

  if (states.length === 0) {
    writeLine(`  ${colors.yellow}No memory found for squad: ${squadName}${RESET}`);
    const entries = listMemoryEntries(memoryDir!);
    const squads = [...new Set(entries.map(e => e.squad))].sort();
    if (squads.length > 0) {
      writeLine(`  ${colors.dim}Available squads: ${squads.join(', ')}${RESET}`);
    }
    process.exit(1);
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  writeLine(`  ${colors.dim}${states.length} entries${RESET}`);
  writeLine();

  for (const state of states) {
    writeLine(`  ${icons.progress} ${colors.white}${state.agent}${RESET} ${colors.dim}(${state.type || 'state'})${RESET}`);
    writeLine(`  ${colors.dim}${box.horizontal.repeat(40)}${RESET}`);

    // Show preview
    const lines = state.content.split('\n').slice(0, 12);
    for (const line of lines) {
      writeLine(`  ${colors.dim}${truncate(line, 70)}${RESET}`);
    }

    if (state.content.split('\n').length > 12) {
      writeLine(`  ${colors.dim}... (more content)${RESET}`);
    }
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory query ${colors.cyan}"<term>"${RESET}   ${colors.dim}Search memory${RESET}`);
  writeLine();
}

export async function memoryUpdateCommand(
  squadName: string,
  content: string,
  options: MemoryOptions
): Promise<void> {
  await track(Events.CLI_MEMORY_UPDATE, { squad: squadName, agent: options.agent, type: options.type });
  const agentName = options.agent || `${squadName}-lead`;
  const type = (options.type || 'learnings') as 'state' | 'output' | 'learnings' | 'feedback';

  writeLine();

  try {
    await appendToMemory(squadName, agentName, type, content);
    writeLine(`  ${icons.success} Updated ${colors.cyan}${type}${RESET} for ${colors.white}${squadName}/${agentName}${RESET}`);
  } catch (error) {
    writeLine(`  ${icons.error} ${colors.red}Failed to update memory: ${error}${RESET}`);
    process.exit(1);
  }

  writeLine();
}

export async function memoryListCommand(): Promise<void> {
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    process.exit(1);
  }

  const entries = listMemoryEntries(memoryDir);

  // Group by squad
  const bySquad: Record<string, typeof entries> = {};
  for (const entry of entries) {
    if (!bySquad[entry.squad]) {
      bySquad[entry.squad] = [];
    }
    bySquad[entry.squad].push(entry);
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory list${RESET}`);
  writeLine();

  const squadNames = Object.keys(bySquad);
  writeLine(`  ${colors.cyan}${entries.length}${RESET} entries across ${squadNames.length} squads`);
  writeLine();

  // Table
  const w = { squad: 16, agents: 8, types: 28 };
  const tableWidth = w.squad + w.agents + w.types + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
    `${bold}${padEnd('AGENTS', w.agents)}${RESET}` +
    `${bold}TYPES${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const [squad, squadEntries] of Object.entries(bySquad)) {
    const agents = new Set(squadEntries.map(e => e.agent));
    const types = [...new Set(squadEntries.map(e => e.type))].join(', ');
    const typesDisplay = truncate(types, w.types - 2);

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad, w.squad)}${RESET}` +
      `${padEnd(String(agents.size), w.agents)}` +
      `${colors.dim}${padEnd(typesDisplay, w.types)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}<squad>${RESET}     ${colors.dim}View squad memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads memory query ${colors.cyan}"<term>"${RESET}   ${colors.dim}Search all memory${RESET}`);
  writeLine();
}

interface ConversationResult {
  id: number;
  session_id: string;
  role: string;
  content: string;
  type: string;  // message_type in the API response
  importance: string;
  created_at: string;
  rank: number;
}

export async function memorySearchCommand(
  query: string,
  options: { limit?: number; role?: string; importance?: string } = {}
): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory search${RESET} "${colors.cyan}${query}${RESET}"`);
  writeLine();

  const limit = options.limit || 10;
  const params = new URLSearchParams({ q: query, limit: String(limit) });

  if (options.role) {
    params.append('role', options.role);
  }
  if (options.importance) {
    params.append('importance', options.importance);
  }

  try {
    const bridgeUrl = getBridgeUrl();
    if (!bridgeUrl) {
      writeLine(`  ${colors.yellow}API service unavailable${RESET}`);
      writeLine(`  ${colors.dim}Conversation search requires authentication. Run \`squads login\` to connect.${RESET}`);
      writeLine(`  ${colors.dim}For local memory search, use: squads memory query "${query}"${RESET}`);
      writeLine();
      return;
    }

    const response = await fetch(`${bridgeUrl}/api/conversations/search?${params}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      if (response.status === 503) {
        writeLine(`  ${colors.yellow}API service unavailable. Run \`squads login\` to connect.${RESET}`);
        writeLine(`  ${colors.dim}For local memory search, use: squads memory query "${query}"${RESET}`);
        writeLine();
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as { results: ConversationResult[]; count: number };
    const conversations = data.results;
    const total = data.count;

    if (conversations.length === 0) {
      writeLine(`  ${colors.yellow}No conversations found for "${query}"${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Conversations are captured via hooks. Make sure:${RESET}`);
      writeLine(`  ${colors.dim}  1. You are authenticated (squads login)${RESET}`);
      writeLine(`  ${colors.dim}  2. Telemetry hooks are configured in Claude settings${RESET}`);
      writeLine();
      return;
    }

    writeLine(`  ${colors.green}${conversations.length}${RESET} of ${total} results`);
    writeLine();

    // Table
    const w = { time: 12, role: 10, type: 10, content: 50 };
    const tableWidth = w.time + w.role + w.type + w.content + 6;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

    const header = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('TIME', w.time)}${RESET}` +
      `${bold}${padEnd('ROLE', w.role)}${RESET}` +
      `${bold}${padEnd('TYPE', w.type)}${RESET}` +
      `${bold}${padEnd('CONTENT', w.content)}${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;
    writeLine(header);

    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const conv of conversations) {
      const time = new Date(conv.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const roleColor = conv.role === 'user' ? colors.cyan : conv.role === 'thinking' ? colors.yellow : colors.green;
      const importanceIcon = conv.importance === 'high' ? icons.success : '';

      // Highlight search term in content
      const contentPreview = truncate((conv.content || '').replace(/\n/g, ' '), w.content - 2);
      const highlighted = contentPreview.replace(
        new RegExp(query, 'gi'),
        (m) => `${colors.yellow}${m}${RESET}${colors.dim}`
      );

      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.dim}${padEnd(time, w.time)}${RESET}` +
        `${roleColor}${padEnd(conv.role || '', w.role)}${RESET}` +
        `${colors.dim}${padEnd(conv.type || 'message', w.type)}${RESET}` +
        `${colors.dim}${padEnd(highlighted + importanceIcon, w.content)}${RESET}` +
        ` ${colors.purple}${box.vertical}${RESET}`;

      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();

    // Expanded view of top results
    writeLine(`  ${bold}Top Matches${RESET}`);
    writeLine();

    for (const conv of conversations.slice(0, 3)) {
      const time = new Date(conv.created_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const roleIcon = conv.role === 'user' ? '👤' : conv.role === 'thinking' ? '💭' : '🤖';

      writeLine(`  ${roleIcon} ${colors.dim}${time}${RESET} ${conv.importance === 'high' ? colors.yellow + '[high]' + RESET : ''}`);

      // Show first 200 chars with highlighted search term
      const content = conv.content || '';
      const preview = content.substring(0, 200).replace(/\n/g, ' ');
      const highlighted = preview.replace(
        new RegExp(query, 'gi'),
        (m) => `${colors.yellow}${m}${RESET}`
      );
      writeLine(`    ${highlighted}${content.length > 200 ? '...' : ''}`);
      writeLine();
    }

    // Commands
    writeLine(`  ${colors.dim}$${RESET} squads memory search ${colors.cyan}"<term>"${RESET} --role user     ${colors.dim}Filter by role${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads memory search ${colors.cyan}"<term>"${RESET} --importance high   ${colors.dim}Filter by importance${RESET}`);
    writeLine();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
      showServiceSetupGuide('bridge', 'not responding');
    } else {
      writeLine(`  ${colors.red}Error searching conversations: ${errorMessage}${RESET}`);
      writeLine();
    }
  }
}

interface ExtractOptions {
  session?: string;
  hours?: number;
  dryRun?: boolean;
}

/**
 * Extract memories from recent conversations and store in Engram
 */
export async function memoryExtractCommand(
  options: ExtractOptions = {}
): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory extract${RESET}`);
  writeLine();

  const hours = options.hours || 24;

  try {
    // 1. Fetch recent conversations from API
    writeLine(`  ${colors.dim}Fetching conversations from last ${hours}h...${RESET}`);

    const bridgeUrl = getBridgeUrl();
    if (!bridgeUrl) {
      writeLine(`  ${colors.yellow}API service unavailable. Run \`squads login\` to connect.${RESET}`);
      writeLine();
      return;
    }

    const bridgeResponse = await fetch(`${bridgeUrl}/api/conversations/recent`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!bridgeResponse.ok) {
      throw new Error(`API error: ${bridgeResponse.status}`);
    }

    const { conversations, count } = await bridgeResponse.json() as {
      conversations: Array<{
        id: number;
        session_id: string;
        role: string;
        content: string;
        squad?: string;
        agent?: string;
        created_at: string;
      }>;
      count: number;
    };

    if (count === 0) {
      writeLine(`  ${colors.yellow}No recent conversations to extract${RESET}`);
      writeLine();
      return;
    }

    writeLine(`  ${colors.green}${count}${RESET} conversations found`);
    writeLine();

    // 2. Group conversations by session
    const sessions = new Map<string, typeof conversations>();
    for (const conv of conversations) {
      const sessionId = conv.session_id || 'unknown';
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, []);
      }
      sessions.get(sessionId)!.push(conv);
    }

    writeLine(`  ${colors.cyan}${sessions.size}${RESET} sessions to process`);
    writeLine();

    if (options.dryRun) {
      writeLine(`  ${colors.yellow}Dry run - not sending to Engram${RESET}`);
      writeLine();
      for (const [sessionId, convs] of sessions) {
        const squad = convs[0]?.squad || 'unknown';
        const agent = convs[0]?.agent || 'unknown';
        writeLine(`  ${icons.progress} ${colors.dim}${sessionId.slice(0, 8)}${RESET} ${colors.cyan}${squad}/${agent}${RESET} ${colors.dim}(${convs.length} messages)${RESET}`);
      }
      writeLine();
      return;
    }

    // 3. Send each session to mem0 for extraction
    let extracted = 0;
    let failed = 0;

    for (const [sessionId, convs] of sessions) {
      const squad = convs[0]?.squad || 'hq';
      const agent = convs[0]?.agent || 'unknown';

      // Format messages for mem0
      const messages = convs.map(c => ({
        role: c.role === 'assistant' ? 'assistant' : c.role === 'user' ? 'user' : 'system',
        content: c.content
      }));

      try {
        const mem0Url = getMem0Url();
        if (!mem0Url) {
          writeLine(`  ${colors.yellow}Memory service not configured. Run \`squads login\` to connect.${RESET}`);
          writeLine();
          return;
        }
        const mem0Response = await fetch(`${mem0Url}/memories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            user_id: squad,
            agent_id: agent,
            run_id: sessionId,
            metadata: {
              source: 'squads-cli',
              extracted_at: new Date().toISOString()
            }
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (mem0Response.ok) {
          const result = await mem0Response.json() as { results?: Array<unknown> };
          const memCount = result.results?.length || 0;
          writeLine(`  ${colors.green}${icons.success}${RESET} ${colors.dim}${sessionId.slice(0, 8)}${RESET} ${colors.cyan}${squad}/${agent}${RESET} → ${colors.green}${memCount}${RESET} memories`);
          extracted++;
        } else {
          writeLine(`  ${colors.red}${icons.error}${RESET} ${colors.dim}${sessionId.slice(0, 8)}${RESET} ${colors.red}Failed: ${mem0Response.status}${RESET}`);
          failed++;
        }
      } catch (err) {
        writeLine(`  ${colors.red}${icons.error}${RESET} ${colors.dim}${sessionId.slice(0, 8)}${RESET} ${colors.red}Error: ${err}${RESET}`);
        failed++;
      }
    }

    writeLine();
    if (failed === 0) {
      writeLine(`  ${colors.green}${icons.success}${RESET} Extracted memories from ${extracted} sessions`);
    } else {
      writeLine(`  ${colors.yellow}${icons.warning}${RESET} Extracted: ${extracted}, Failed: ${failed}`);
    }
    writeLine();

    // Show next steps
    writeLine(`  ${colors.dim}$${RESET} squads memory query ${colors.cyan}"<term>"${RESET}    ${colors.dim}Search extracted memories${RESET}`);
    writeLine();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
      // Check which service is down
      const bridgeOk = await checkServiceAvailable('bridge', false);
      const mem0Ok = await checkServiceAvailable('mem0', false);

      if (!bridgeOk) {
        showServiceSetupGuide('bridge', 'not responding');
      } else if (!mem0Ok) {
        showServiceSetupGuide('mem0', 'not responding');
      } else {
        writeLine(`  ${colors.red}Error: ${errorMessage}${RESET}`);
        writeLine();
      }
    } else {
      writeLine(`  ${colors.red}Error: ${errorMessage}${RESET}`);
      writeLine();
    }
  }
}
