/**
 * squads approval - Manage approval requests for agent actions
 *
 * Commands:
 *   squads approval send <type>       Send approval request to Slack
 *   squads approval list              List pending approvals
 *   squads approval check <id>        Check approval status
 *   squads approval cancel <id>       Cancel pending approval
 */

import { Command } from "commander";
import chalk from "chalk";

const API_URL =
  process.env.SQUADS_API_URL ||
  process.env.SCHEDULER_URL ||
  "http://localhost:8090";

type ApprovalType = "issue" | "pr" | "content" | "run" | "brief";

interface Approval {
  approval_id: string;
  type: ApprovalType;
  squad: string;
  agent?: string;
  title: string;
  description?: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  decided_by?: string;
  decided_at?: string;
  created_at: string;
  expires_at: string;
}

function generateApprovalId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `appr_${timestamp}_${random}`;
}

function parseExpiresIn(expiresIn: string): Date {
  const expiresAt = new Date();
  const match = expiresIn.match(/(\d+)(h|m|d)/);
  if (match) {
    const [, num, unit] = match;
    const hours =
      unit === "d"
        ? parseInt(num) * 24
        : unit === "h"
          ? parseInt(num)
          : parseInt(num) / 60;
    expiresAt.setHours(expiresAt.getHours() + hours);
  } else {
    // Default to 24 hours
    expiresAt.setHours(expiresAt.getHours() + 24);
  }
  return expiresAt;
}

async function sendApproval(
  type: string,
  options: {
    title?: string;
    description?: string;
    squad?: string;
    agent?: string;
    priority?: string;
    expiresIn?: string;
    json?: string;
  }
): Promise<void> {
  const approvalId = generateApprovalId();

  let payload: Record<string, unknown> = {};

  // Parse JSON payload if provided
  if (options.json) {
    try {
      if (options.json === "-") {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString());
      } else {
        payload = JSON.parse(options.json);
      }
    } catch {
      console.error(chalk.red("Invalid JSON payload"));
      process.exit(1);
    }
  }

  const expiresAt = parseExpiresIn(options.expiresIn || "24h");

  const approval = {
    approval_id: approvalId,
    type,
    title: options.title || payload.title || `Approval needed: ${type}`,
    description: options.description || (payload.description as string),
    squad: options.squad || process.env.SQUADS_SQUAD || "unknown",
    agent: options.agent || process.env.SQUADS_AGENT,
    priority: parseInt(options.priority || "5"),
    expires_at: expiresAt.toISOString(),
    payload,
  };

  try {
    const response = await fetch(`${API_URL}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(approval),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }

    const result = (await response.json()) as {
      success: boolean;
      approval_id: string;
    };

    console.log(chalk.green(`\nApproval sent: ${result.approval_id}`));
    console.log(chalk.dim(`  Expires: ${expiresAt.toISOString()}`));
    console.log();

    // Output for agent consumption
    if (process.env.SQUADS_AGENT) {
      console.log(`APPROVAL_ID=${approvalId}`);
    }
  } catch (error) {
    console.error(chalk.red(`Failed to send approval: ${error}`));
    process.exit(1);
  }
}

async function listApprovals(options: {
  pending?: boolean;
  squad?: string;
  json?: boolean;
}): Promise<void> {
  const status = options.pending ? "pending" : "";
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (options.squad) params.set("squad", options.squad);

  try {
    const response = await fetch(
      `${API_URL}/approvals?${params.toString()}`
    );
    if (!response.ok) throw new Error(await response.text());

    const approvals = (await response.json()) as Approval[];

    if (options.json) {
      console.log(JSON.stringify(approvals, null, 2));
      return;
    }

    if (approvals.length === 0) {
      console.log(chalk.gray("\nNo pending approvals\n"));
      return;
    }

    console.log(chalk.bold("\nPending Approvals\n"));

    for (const a of approvals) {
      const typeColors: Record<ApprovalType, typeof chalk.green> = {
        issue: chalk.green,
        pr: chalk.magenta,
        content: chalk.blue,
        run: chalk.yellow,
        brief: chalk.cyan,
      };
      const color = typeColors[a.type] || chalk.white;

      console.log(
        `  ${color(`[${a.type}]`)} ${chalk.bold(a.title)} ${chalk.dim(`(${a.approval_id})`)}`
      );
      console.log(
        chalk.dim(
          `    Squad: ${a.squad}${a.agent ? "/" + a.agent : ""} | Created: ${new Date(a.created_at).toLocaleString()}`
        )
      );
      console.log();
    }
  } catch (error) {
    console.error(chalk.red(`Failed to list approvals: ${error}`));
    process.exit(1);
  }
}

async function checkApproval(
  approvalId: string,
  options: { wait?: boolean; timeout?: string }
): Promise<void> {
  const timeoutMs = parseInt(options.timeout || "60") * 60 * 1000;
  const startTime = Date.now();

  async function check(): Promise<Approval | null> {
    try {
      const response = await fetch(
        `${API_URL}/approvals/${approvalId}`
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as Approval;
    } catch (error) {
      console.error(chalk.red(`Failed to check approval: ${error}`));
      return null;
    }
  }

  const approval = await check();

  if (!approval) {
    console.error(chalk.red(`Approval not found: ${approvalId}`));
    process.exit(1);
  }

  if (approval.status !== "pending" || !options.wait) {
    // Output current status
    const statusColors: Record<string, typeof chalk.green> = {
      pending: chalk.yellow,
      approved: chalk.green,
      rejected: chalk.red,
      expired: chalk.gray,
      cancelled: chalk.gray,
    };
    const color = statusColors[approval.status] || chalk.white;

    console.log(`\nApproval: ${approvalId}`);
    console.log(`  Status: ${color(approval.status)}`);
    if (approval.decided_by) {
      console.log(`  Decided by: ${approval.decided_by}`);
      console.log(`  Decided at: ${approval.decided_at}`);
    }
    console.log();

    // Exit with appropriate code
    if (approval.status === "approved") {
      process.exit(0);
    } else if (approval.status === "rejected") {
      process.exit(1);
    } else if (approval.status === "pending") {
      process.exit(2);
    } else {
      process.exit(3);
    }
  }

  // Wait mode
  console.log(chalk.dim(`Waiting for decision on ${approvalId}...`));

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Poll every 5s

    const updated = await check();
    if (!updated) {
      console.error(chalk.red("Approval disappeared"));
      process.exit(1);
    }

    if (updated.status !== "pending") {
      const color =
        updated.status === "approved" ? chalk.green : chalk.red;
      console.log(color(`\nDecision: ${updated.status}`));
      if (updated.decided_by) {
        console.log(chalk.dim(`  By: ${updated.decided_by}`));
      }
      process.exit(updated.status === "approved" ? 0 : 1);
    }
  }

  console.error(chalk.red("Timeout waiting for approval"));
  process.exit(2);
}

async function cancelApproval(approvalId: string): Promise<void> {
  console.log(chalk.yellow(`Cancel not yet implemented for: ${approvalId}`));
  // TODO: Implement cancel endpoint
}

export function registerApprovalCommand(program: Command): void {
  const approval = program
    .command("approval")
    .description("Manage approval requests for agent actions")
    .action(() => { approval.outputHelp(); });

  approval
    .command("send <type>")
    .description("Send approval request to Slack")
    .option("-t, --title <title>", "Approval title")
    .option("-d, --description <desc>", "Detailed description")
    .option("-s, --squad <squad>", "Squad name")
    .option("-a, --agent <agent>", "Agent name")
    .option("-p, --priority <n>", "Priority 1-10 (1=urgent)", "5")
    .option("-e, --expires-in <time>", "Expiration time (24h, 1h, 30m)", "24h")
    .option("-j, --json <json>", "Full payload as JSON (use - for stdin)")
    .addHelpText(
      "after",
      `
Types: issue, pr, content, run, brief

Examples:
  $ squads approval send pr --title "Merge feature X" --json '{"repo":"agents-squads/hq","number":123}'
  $ squads approval send content -t "LinkedIn post" -d "New blog announcement"
  $ echo '{"title":"Run overnight"}' | squads approval send run --json -
`
    )
    .action(sendApproval);

  approval
    .command("list")
    .description("List approvals")
    .option("--pending", "Only show pending approvals", true)
    .option("-s, --squad <squad>", "Filter by squad")
    .option("-j, --json", "Output as JSON")
    .action(listApprovals);

  approval
    .command("check <id>")
    .description("Check approval status")
    .option("-w, --wait", "Wait for decision (polls every 5s)")
    .option("-t, --timeout <minutes>", "Wait timeout in minutes", "60")
    .action(checkApproval);

  approval
    .command("cancel <id>")
    .description("Cancel pending approval")
    .action(cancelApproval);
}
