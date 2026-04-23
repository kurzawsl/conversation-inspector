#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import { createReadStream, existsSync, watchFile, unwatchFile } from 'fs';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import {
  formatDuration,
  parseJsonlLines,
  extractToolCallsFromMessages,
  estimateTokens as estimateTokensFn,
  calculateSimilarityScore,
  classifyTaskType,
} from './lib/session-utils.js';

const execAsync = promisify(exec);

// Surface process-level errors so they land in Claude Code logs instead of silently
// killing the stdio transport.
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({ type: 'uncaughtException', error: err?.stack || String(err), ts: new Date().toISOString() }));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ type: 'unhandledRejection', reason: reason instanceof Error ? reason.stack : String(reason), ts: new Date().toISOString() }));
  process.exit(1);
});

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const STATS_DIR = path.join(os.homedir(), '.claude', 'stats');
const CLAUDE_PATH = path.join(os.homedir(), '.claude', 'local', 'claude');
const MCP_CONFIG = path.join(os.homedir(), '.claude', '.mcp.json');

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS TRACKING - In-memory storage for spawned processes
// ═══════════════════════════════════════════════════════════════════════════════
const runningProcesses = new Map();
const processHistory = [];
const MAX_HISTORY = 100;

class ClaudeProcess {
  constructor(id, prompt, options = {}) {
    this.id = id;
    this.prompt = prompt;
    this.startTime = Date.now();
    this.status = 'starting';
    this.pid = null;
    this.process = null;
    this.sessionFile = null;
    this.sessionId = null;
    this.output = '';
    this.error = null;
    this.exitCode = null;
    this.toolCalls = [];
    this.turns = 0;
    this.lastUpdate = Date.now();
    this.options = options;
    this.fileWatcher = null;
    this.messageCount = 0;
  }

  toJSON() {
    return {
      id: this.id,
      prompt: this.prompt.substring(0, 200),
      status: this.status,
      pid: this.pid,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      startTime: new Date(this.startTime).toISOString(),
      durationMs: Date.now() - this.startTime,
      durationFormatted: formatDuration(Date.now() - this.startTime),
      turns: this.turns,
      toolCalls: this.toolCalls.length,
      lastUpdate: new Date(this.lastUpdate).toISOString(),
      exitCode: this.exitCode,
      error: this.error,
      outputPreview: this.output.substring(0, 500)
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// formatDuration is imported from ./lib/session-utils.js

function generateProcessId() {
  return `cp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
}

async function findRecentSessionFile(afterTime) {
  // Find JSONL file modified after the given time
  const projects = await fs.readdir(PROJECTS_DIR);
  let mostRecent = null;
  let mostRecentTime = 0;

  for (const project of projects) {
    const projectPath = path.join(PROJECTS_DIR, project);
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) continue;

    const files = await fs.readdir(projectPath);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      if (file.startsWith('agent-')) continue;

      const filePath = path.join(projectPath, file);
      const fileStat = await fs.stat(filePath);

      if (fileStat.mtimeMs > afterTime && fileStat.mtimeMs > mostRecentTime) {
        mostRecent = filePath;
        mostRecentTime = fileStat.mtimeMs;
      }
    }
  }

  return mostRecent;
}

async function parseJsonlFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseJsonlLines(content);
}

async function getToolCallsFromSession(filePath) {
  const messages = await parseJsonlFile(filePath);
  return extractToolCallsFromMessages(messages);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VISUALIZATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function createProgressBar(percent, width = 30) {
  const filled = Math.round(width * percent / 100);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}%`;
}

function createProcessTable(processes) {
  const header = `
╔════════════════════════════════════════════════════════════════════════════════╗
║                         CLAUDE PROCESS MONITOR                                  ║
╠════════════════════════════════════════════════════════════════════════════════╣`;

  let rows = '';
  for (const proc of processes) {
    const statusIcon = {
      'starting': '🔄',
      'running': '▶️',
      'completed': '✅',
      'failed': '❌',
      'killed': '🛑'
    }[proc.status] || '❓';

    const duration = formatDuration(Date.now() - proc.startTime);
    const prompt = proc.prompt.substring(0, 50).padEnd(50);

    rows += `
║ ${statusIcon} ${proc.id.padEnd(20)} │ ${proc.status.padEnd(10)} │ ${duration.padEnd(12)} │ T:${proc.turns.toString().padStart(3)} ║`;
  }

  const footer = `
╠════════════════════════════════════════════════════════════════════════════════╣
║ Total: ${processes.length.toString().padEnd(3)} │ Running: ${processes.filter(p => p.status === 'running').length.toString().padEnd(3)} │ Completed: ${processes.filter(p => p.status === 'completed').length.toString().padEnd(3)}                                ║
╚════════════════════════════════════════════════════════════════════════════════╝`;

  return header + rows + footer;
}

function createSessionVisualization(session) {
  const { toolCalls, messages, durationMs, turns } = session;

  // Tool usage chart
  const toolCounts = {};
  for (const tc of toolCalls) {
    toolCounts[tc.tool] = (toolCounts[tc.tool] || 0) + 1;
  }

  const maxCount = Math.max(...Object.values(toolCounts), 1);
  const toolChart = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, count]) => {
      const barWidth = Math.round((count / maxCount) * 20);
      return `  ${tool.padEnd(25)} ${'█'.repeat(barWidth)}${'░'.repeat(20 - barWidth)} ${count}`;
    })
    .join('\n');

  // Timeline
  const timeline = messages
    .filter(m => m.type === 'assistant' || m.type === 'user')
    .slice(-20)
    .map((m, i) => {
      const icon = m.type === 'user' ? '👤' : '🤖';
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '??:??:??';

      let content = '';
      if (m.type === 'user') {
        const text = typeof m.message?.content === 'string' ?
          m.message.content :
          m.message?.content?.[0]?.text || '';
        content = text.substring(0, 60);
      } else {
        const items = m.message?.content || [];
        const tools = items.filter(i => i.type === 'tool_use').map(i => i.name);
        if (tools.length > 0) {
          content = `Tools: ${tools.join(', ')}`;
        } else {
          const text = items.find(i => i.type === 'text')?.text || '';
          content = text.substring(0, 60);
        }
      }

      return `  ${time} ${icon} ${content.substring(0, 60)}`;
    })
    .join('\n');

  return `
╔══════════════════════════════════════════════════════════════════════════════════╗
║                           SESSION VISUALIZATION                                   ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║ Duration: ${formatDuration(durationMs).padEnd(15)} │ Turns: ${turns.toString().padEnd(5)} │ Tool Calls: ${toolCalls.length.toString().padEnd(5)}                ║
╠══════════════════════════════════════════════════════════════════════════════════╣
║ TOOL USAGE:                                                                       ║
${toolChart.split('\n').map(l => '║' + l.padEnd(83) + '║').join('\n')}
╠══════════════════════════════════════════════════════════════════════════════════╣
║ TIMELINE (last 20 messages):                                                      ║
${timeline.split('\n').map(l => '║' + l.padEnd(83) + '║').join('\n')}
╚══════════════════════════════════════════════════════════════════════════════════╝`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

class ConversationInspectorServer {
  constructor() {
    this.server = new Server(
      {
        name: 'mcp-conversation-inspector',
        version: '3.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // ═══════════════════════════════════════════════════════════════════════
        // PROCESS SPAWNING & MONITORING TOOLS (NEW!)
        // ═══════════════════════════════════════════════════════════════════════
        {
          name: 'spawn_claude_process',
          description: `Spawn a new claude -p process in background. Returns immediately with process ID.

          This is your POWER TOOL for parallel work! Spawn multiple claude instances to:
          - Run analyses in parallel
          - Test different approaches simultaneously
          - Execute long-running tasks without blocking

          Use 'watch_processes' to monitor all running processes.
          Use 'get_process_progress' to get detailed status of a specific process.`,
          inputSchema: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'The prompt to send to claude -p' },
              maxTurns: { type: 'number', description: 'Maximum agentic turns (default: 10)', default: 10 },
              systemPrompt: { type: 'string', description: 'Optional system prompt to append' },
              workingDirectory: { type: 'string', description: 'Working directory for execution' },
              name: { type: 'string', description: 'Optional friendly name for this process' },
              dangerouslySkipPermissions: { type: 'boolean', description: 'Pass --dangerously-skip-permissions to claude (opt-in, default: false)' }
            },
            required: ['prompt']
          }
        },
        {
          name: 'watch_processes',
          description: `Get status of ALL running claude -p processes with rich visualization.

          Returns a beautiful ASCII table showing:
          - Process ID, status, duration
          - Number of turns completed
          - Tool calls made
          - Live progress from JSONL files

          Perfect for monitoring parallel work!`,
          inputSchema: {
            type: 'object',
            properties: {
              includeCompleted: { type: 'boolean', description: 'Include completed processes', default: false },
              detailed: { type: 'boolean', description: 'Include detailed info per process', default: false }
            }
          }
        },
        {
          name: 'get_process_progress',
          description: `Get detailed real-time progress of a specific claude -p process.

          Shows:
          - Current status and duration
          - All tool calls made so far
          - Recent messages/turns
          - Output preview
          - Session file location`,
          inputSchema: {
            type: 'object',
            properties: {
              processId: { type: 'string', description: 'Process ID (from spawn_claude_process)' }
            },
            required: ['processId']
          }
        },
        {
          name: 'kill_process',
          description: 'Kill a running claude -p process.',
          inputSchema: {
            type: 'object',
            properties: {
              processId: { type: 'string', description: 'Process ID to kill' }
            },
            required: ['processId']
          }
        },
        {
          name: 'get_process_output',
          description: 'Get the full output of a completed claude -p process.',
          inputSchema: {
            type: 'object',
            properties: {
              processId: { type: 'string', description: 'Process ID' }
            },
            required: ['processId']
          }
        },
        {
          name: 'list_all_processes',
          description: 'List all processes (running and completed) with history.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max processes to return', default: 20 },
              status: { type: 'string', description: 'Filter by status: running, completed, failed, killed' }
            }
          }
        },
        // ═══════════════════════════════════════════════════════════════════════
        // VISUALIZATION TOOLS (NEW!)
        // ═══════════════════════════════════════════════════════════════════════
        {
          name: 'visualize_session',
          description: `Create a rich ASCII visualization of a conversation session.

          Shows:
          - Tool usage chart with bar graph
          - Message timeline
          - Duration and statistics
          - Key decisions and outputs`,
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID to visualize' }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'analyze_thinking_patterns',
          description: `Analyze thinking patterns in a session - what tools were used, in what order, any retries.

          Great for understanding how Claude approaches problems!`,
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID to analyze' }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'get_session_timeline',
          description: 'Get a detailed timeline of all actions in a session with timestamps.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              format: { type: 'string', description: 'Output format: text, json, or chart', default: 'text' }
            },
            required: ['sessionId']
          }
        },
        // ═══════════════════════════════════════════════════════════════════════
        // DEEP ANALYSIS TOOLS (NEW!)
        // ═══════════════════════════════════════════════════════════════════════
        {
          name: 'analyze_tool_effectiveness',
          description: `Analyze how effectively tools were used across sessions.

          Shows:
          - Success/failure rates per tool
          - Average execution time
          - Common error patterns
          - Retry frequency`,
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'Analyze sessions from last N hours', default: 24 }
            }
          }
        },
        {
          name: 'find_similar_sessions',
          description: 'Find sessions similar to a given session based on prompts and tools used.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Reference session ID' },
              limit: { type: 'number', description: 'Max similar sessions to return', default: 5 }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'get_conversation_insights',
          description: `Deep insights from conversation patterns:
          - Most productive times of day
          - Average session length by project
          - Most common task types
          - Workflow bottlenecks`,
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'Analyze from last N hours', default: 168 }
            }
          }
        },
        // ═══════════════════════════════════════════════════════════════════════
        // ORIGINAL TOOLS (existing)
        // ═══════════════════════════════════════════════════════════════════════
        {
          name: 'list_sessions',
          description: 'List recent Claude conversation sessions. Shows session ID, project, timestamp, and turn count.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Maximum number of sessions to return', default: 20 },
              project: { type: 'string', description: 'Filter by project path pattern (e.g., "gmail-manager")' },
              hoursAgo: { type: 'number', description: 'Only show sessions from last N hours', default: 24 }
            }
          }
        },
        {
          name: 'get_session_summary',
          description: 'Get detailed summary of a conversation session: tools used, turns, duration, key decisions.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID (UUID from list_sessions)' }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'get_session_tools',
          description: 'Get all tools used in a session with their inputs and outputs.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              toolFilter: { type: 'string', description: 'Filter by tool name (e.g., "Bash", "Read")' }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'get_session_messages',
          description: 'Get all messages (user prompts and assistant responses) from a session.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              includeToolResults: { type: 'boolean', description: 'Include tool call results', default: false }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'search_sessions',
          description: 'Search across all sessions for specific content (tool names, text, errors).',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (searches in messages and tool calls)' },
              hoursAgo: { type: 'number', description: 'Only search sessions from last N hours', default: 48 },
              limit: { type: 'number', description: 'Maximum results', default: 10 }
            },
            required: ['query']
          }
        },
        {
          name: 'get_claude_p_executions',
          description: 'Get recent claude -p (programmatic) executions. These are non-interactive sessions spawned by other Claude instances.',
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'Only show executions from last N hours', default: 4 },
              limit: { type: 'number', description: 'Maximum results', default: 10 }
            }
          }
        },
        {
          name: 'analyze_session_errors',
          description: 'Find errors, failures, and issues in a session.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' }
            },
            required: ['sessionId']
          }
        },
        {
          name: 'compare_sessions',
          description: 'Compare two sessions to see differences in approach, tools used, and outcomes.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId1: { type: 'string', description: 'First session ID' },
              sessionId2: { type: 'string', description: 'Second session ID' }
            },
            required: ['sessionId1', 'sessionId2']
          }
        },
        {
          name: 'get_daily_statistics',
          description: 'Get comprehensive statistics for a day: total sessions, tool usage, tokens, prompts. Perfect for daily reports.',
          inputSchema: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
              includePrompts: { type: 'boolean', description: 'Include list of all prompts', default: true }
            }
          }
        },
        {
          name: 'get_tool_usage_stats',
          description: 'Get aggregated tool usage statistics across all sessions. Shows most used tools, patterns, and efficiency metrics.',
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'Analyze sessions from last N hours', default: 24 },
              groupBy: { type: 'string', description: 'Group by: tool, project, hour', default: 'tool' }
            }
          }
        },
        {
          name: 'get_all_prompts',
          description: 'Extract ALL user prompts from sessions. Great for understanding work patterns.',
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'From last N hours', default: 24 },
              minLength: { type: 'number', description: 'Minimum prompt length to include', default: 10 }
            }
          }
        },
        {
          name: 'estimate_token_usage',
          description: 'Estimate token usage across sessions. Helps track API consumption.',
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'From last N hours', default: 24 },
              detailed: { type: 'boolean', description: 'Include per-session breakdown', default: false }
            }
          }
        },
        {
          name: 'generate_work_summary',
          description: 'Generate a human-readable summary of all work done. Perfect for daily standup or EOD report.',
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'From last N hours', default: 24 }
            }
          }
        },
        {
          name: 'identify_automation_opportunities',
          description: 'Analyze patterns to identify repetitive tasks that could be automated.',
          inputSchema: {
            type: 'object',
            properties: {
              hoursAgo: { type: 'number', description: 'Analyze sessions from last N hours', default: 168 }
            }
          }
        },
        {
          name: 'save_daily_report',
          description: 'Save aggregated daily statistics to a JSON file for historical tracking.',
          inputSchema: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' }
            }
          }
        }
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        // Process management
        case 'spawn_claude_process': return await this.spawnClaudeProcess(args);
        case 'watch_processes': return await this.watchProcesses(args);
        case 'get_process_progress': return await this.getProcessProgress(args);
        case 'kill_process': return await this.killProcess(args);
        case 'get_process_output': return await this.getProcessOutput(args);
        case 'list_all_processes': return await this.listAllProcesses(args);

        // Visualization
        case 'visualize_session': return await this.visualizeSession(args);
        case 'analyze_thinking_patterns': return await this.analyzeThinkingPatterns(args);
        case 'get_session_timeline': return await this.getSessionTimeline(args);

        // Deep analysis
        case 'analyze_tool_effectiveness': return await this.analyzeToolEffectiveness(args);
        case 'find_similar_sessions': return await this.findSimilarSessions(args);
        case 'get_conversation_insights': return await this.getConversationInsights(args);

        // Original tools
        case 'list_sessions': return await this.listSessions(args);
        case 'get_session_summary': return await this.getSessionSummary(args);
        case 'get_session_tools': return await this.getSessionTools(args);
        case 'get_session_messages': return await this.getSessionMessages(args);
        case 'search_sessions': return await this.searchSessions(args);
        case 'get_claude_p_executions': return await this.getClaudePExecutions(args);
        case 'analyze_session_errors': return await this.analyzeSessionErrors(args);
        case 'compare_sessions': return await this.compareSessions(args);
        case 'get_daily_statistics': return await this.getDailyStatistics(args);
        case 'get_tool_usage_stats': return await this.getToolUsageStats(args);
        case 'get_all_prompts': return await this.getAllPrompts(args);
        case 'estimate_token_usage': return await this.estimateTokenUsage(args);
        case 'generate_work_summary': return await this.generateWorkSummary(args);
        case 'identify_automation_opportunities': return await this.identifyAutomationOpportunities(args);
        case 'save_daily_report': return await this.saveDailyReport(args);
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PROCESS SPAWNING & MONITORING (NEW!)
  // ═══════════════════════════════════════════════════════════════════════════════

  async spawnClaudeProcess(args) {
    const { prompt, maxTurns = 10, systemPrompt, workingDirectory, name, dangerouslySkipPermissions = false } = args;

    if (!prompt) {
      throw new Error('Missing required parameter: prompt');
    }

    const processId = name || generateProcessId();
    const claudeProcess = new ClaudeProcess(processId, prompt, { maxTurns, systemPrompt, workingDirectory });

    // Build command
    const cmdArgs = [];
    if (dangerouslySkipPermissions) {
      cmdArgs.push('--dangerously-skip-permissions');
    }
    cmdArgs.push('--mcp-config', MCP_CONFIG, '--max-turns', maxTurns.toString());

    if (systemPrompt) {
      cmdArgs.push('--append-system-prompt', systemPrompt);
    }

    cmdArgs.push('-p', prompt);

    const spawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.dirname(CLAUDE_PATH)}:${process.env.PATH}` }
    };

    if (workingDirectory) {
      spawnOptions.cwd = workingDirectory;
    }

    // Spawn the process
    const child = spawn(CLAUDE_PATH, cmdArgs, spawnOptions);

    claudeProcess.process = child;
    claudeProcess.pid = child.pid;
    claudeProcess.status = 'running';

    // Capture output
    child.stdout.on('data', (data) => {
      claudeProcess.output += data.toString();
      claudeProcess.lastUpdate = Date.now();
    });

    child.stderr.on('data', (data) => {
      claudeProcess.error = (claudeProcess.error || '') + data.toString();
      claudeProcess.lastUpdate = Date.now();
    });

    child.on('close', async (code) => {
      claudeProcess.exitCode = code;
      claudeProcess.status = code === 0 ? 'completed' : 'failed';
      claudeProcess.lastUpdate = Date.now();

      // Find and link session file
      const sessionFile = await findRecentSessionFile(claudeProcess.startTime);
      if (sessionFile) {
        claudeProcess.sessionFile = sessionFile;
        claudeProcess.sessionId = path.basename(sessionFile, '.jsonl');

        // Get final tool calls count
        try {
          const toolCalls = await getToolCallsFromSession(sessionFile);
          claudeProcess.toolCalls = toolCalls;
          claudeProcess.turns = (await parseJsonlFile(sessionFile))
            .filter(m => m.type === 'assistant').length;
        } catch (e) {
          // Ignore
        }
      }

      // Move to history
      processHistory.unshift(claudeProcess);
      if (processHistory.length > MAX_HISTORY) {
        processHistory.pop();
      }
      runningProcesses.delete(processId);
    });

    // Store process
    runningProcesses.set(processId, claudeProcess);

    // Start monitoring for session file
    setTimeout(async () => {
      if (claudeProcess.status === 'running' && !claudeProcess.sessionFile) {
        const sessionFile = await findRecentSessionFile(claudeProcess.startTime);
        if (sessionFile) {
          claudeProcess.sessionFile = sessionFile;
          claudeProcess.sessionId = path.basename(sessionFile, '.jsonl');
        }
      }
    }, 3000);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          processId,
          pid: child.pid,
          status: 'running',
          prompt: prompt.substring(0, 200),
          message: `Process started! Use watch_processes or get_process_progress("${processId}") to monitor.`,
          tip: 'You can spawn multiple processes in parallel!'
        }, null, 2)
      }]
    };
  }

  async watchProcesses(args) {
    const { includeCompleted = false, detailed = false } = args;

    // Get all running processes
    const running = Array.from(runningProcesses.values());

    // Update tool calls for running processes
    for (const proc of running) {
      if (proc.sessionFile) {
        try {
          const toolCalls = await getToolCallsFromSession(proc.sessionFile);
          proc.toolCalls = toolCalls;
          const messages = await parseJsonlFile(proc.sessionFile);
          proc.turns = messages.filter(m => m.type === 'assistant').length;
        } catch (e) {
          // Ignore
        }
      }
    }

    let processes = running;
    if (includeCompleted) {
      processes = [...running, ...processHistory.slice(0, 10)];
    }

    // Create visualization
    const visualization = createProcessTable(processes.map(p => p.toJSON ? p.toJSON() : p));

    const result = {
      timestamp: new Date().toISOString(),
      visualization,
      runningCount: running.length,
      completedCount: processHistory.filter(p => p.status === 'completed').length,
      failedCount: processHistory.filter(p => p.status === 'failed').length,
      processes: processes.map(p => p.toJSON ? p.toJSON() : p)
    };

    if (detailed) {
      result.detailedProcesses = processes.map(p => ({
        ...p.toJSON(),
        recentToolCalls: p.toolCalls.slice(-5).map(tc => ({
          tool: tc.tool,
          timestamp: tc.timestamp
        })),
        outputPreview: p.output.substring(0, 1000)
      }));
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  async getProcessProgress(args) {
    const { processId } = args;

    let proc = runningProcesses.get(processId);
    if (!proc) {
      proc = processHistory.find(p => p.id === processId);
    }

    if (!proc) {
      throw new Error(`Process not found: ${processId}`);
    }

    // Update tool calls if session file exists
    if (proc.sessionFile) {
      try {
        proc.toolCalls = await getToolCallsFromSession(proc.sessionFile);
        const messages = await parseJsonlFile(proc.sessionFile);
        proc.turns = messages.filter(m => m.type === 'assistant').length;
        proc.messageCount = messages.length;
      } catch (e) {
        // Ignore
      }
    }

    const result = {
      ...proc.toJSON(),
      fullStatus: {
        isRunning: proc.status === 'running',
        canKill: proc.status === 'running',
        hasOutput: proc.output.length > 0,
        hasError: !!proc.error,
        hasSessionFile: !!proc.sessionFile
      },
      toolCallDetails: proc.toolCalls.map(tc => ({
        tool: tc.tool,
        timestamp: tc.timestamp,
        inputPreview: JSON.stringify(tc.input).substring(0, 100)
      })),
      output: proc.output,
      error: proc.error
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  async killProcess(args) {
    const { processId } = args;

    const proc = runningProcesses.get(processId);
    if (!proc) {
      throw new Error(`Process not found or already completed: ${processId}`);
    }

    if (proc.process && !proc.process.killed) {
      proc.process.kill('SIGTERM');
      setTimeout(() => {
        if (proc.process && !proc.process.killed) {
          proc.process.kill('SIGKILL');
        }
      }, 5000);
    }

    proc.status = 'killed';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          processId,
          status: 'killed',
          message: 'Process termination signal sent'
        }, null, 2)
      }]
    };
  }

  async getProcessOutput(args) {
    const { processId } = args;

    let proc = runningProcesses.get(processId);
    if (!proc) {
      proc = processHistory.find(p => p.id === processId);
    }

    if (!proc) {
      throw new Error(`Process not found: ${processId}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          processId,
          status: proc.status,
          output: proc.output,
          error: proc.error,
          exitCode: proc.exitCode
        }, null, 2)
      }]
    };
  }

  async listAllProcesses(args) {
    const { limit = 20, status } = args;

    const all = [...Array.from(runningProcesses.values()), ...processHistory];

    let filtered = all;
    if (status) {
      filtered = all.filter(p => p.status === status);
    }

    const sorted = filtered.sort((a, b) => b.startTime - a.startTime).slice(0, limit);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: all.length,
          running: runningProcesses.size,
          showing: sorted.length,
          processes: sorted.map(p => p.toJSON ? p.toJSON() : p)
        }, null, 2)
      }]
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // VISUALIZATION TOOLS (NEW!)
  // ═══════════════════════════════════════════════════════════════════════════════

  async visualizeSession(args) {
    const { sessionId } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);
    const toolCalls = await getToolCallsFromSession(sessionInfo.path);

    const timestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp));
    const startTime = timestamps.length > 0 ? Math.min(...timestamps) : 0;
    const endTime = timestamps.length > 0 ? Math.max(...timestamps) : 0;

    const visualization = createSessionVisualization({
      toolCalls,
      messages,
      durationMs: endTime - startTime,
      turns: messages.filter(m => m.type === 'assistant').length
    });

    return {
      content: [{
        type: 'text',
        text: visualization + '\n\n' + JSON.stringify({
          sessionId,
          project: sessionInfo.project,
          durationMs: endTime - startTime,
          turns: messages.filter(m => m.type === 'assistant').length,
          toolCallCount: toolCalls.length,
          messageCount: messages.length
        }, null, 2)
      }]
    };
  }

  async analyzeThinkingPatterns(args) {
    const { sessionId } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);
    const toolCalls = await getToolCallsFromSession(sessionInfo.path);

    // Analyze patterns
    const patterns = {
      toolSequences: [],
      retries: [],
      errorRecoveries: [],
      decisionPoints: []
    };

    // Track tool sequences
    for (let i = 0; i < toolCalls.length - 1; i++) {
      patterns.toolSequences.push({
        from: toolCalls[i].tool,
        to: toolCalls[i + 1].tool,
        gap: toolCalls[i + 1].timestamp && toolCalls[i].timestamp ?
          new Date(toolCalls[i + 1].timestamp) - new Date(toolCalls[i].timestamp) : 0
      });
    }

    // Count tool usage patterns
    const toolCounts = {};
    for (const tc of toolCalls) {
      toolCounts[tc.tool] = (toolCounts[tc.tool] || 0) + 1;
    }

    // Find consecutive same-tool calls (potential retries)
    for (let i = 0; i < toolCalls.length - 1; i++) {
      if (toolCalls[i].tool === toolCalls[i + 1].tool) {
        patterns.retries.push({
          tool: toolCalls[i].tool,
          index: i
        });
      }
    }

    // Analyze message flow for decision points
    let lastUserPrompt = '';
    for (const msg of messages) {
      if (msg.type === 'user') {
        const content = msg.message?.content;
        lastUserPrompt = typeof content === 'string' ? content :
          (content?.[0]?.text || '');
      } else if (msg.type === 'assistant') {
        const textItems = msg.message?.content?.filter(c => c.type === 'text') || [];
        for (const item of textItems) {
          if (item.text?.includes('I will') || item.text?.includes('Let me') ||
              item.text?.includes('First,') || item.text?.includes('Next,')) {
            patterns.decisionPoints.push({
              text: item.text.substring(0, 200),
              timestamp: msg.timestamp
            });
          }
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          analysis: {
            totalToolCalls: toolCalls.length,
            uniqueTools: Object.keys(toolCounts).length,
            toolUsage: toolCounts,
            retryCount: patterns.retries.length,
            decisionPoints: patterns.decisionPoints.length,
            commonSequences: patterns.toolSequences
              .reduce((acc, seq) => {
                const key = `${seq.from} → ${seq.to}`;
                acc[key] = (acc[key] || 0) + 1;
                return acc;
              }, {}),
            patterns
          }
        }, null, 2)
      }]
    };
  }

  async getSessionTimeline(args) {
    const { sessionId, format = 'text' } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);

    const timeline = [];
    let turnNumber = 0;

    for (const msg of messages) {
      if (msg.type === 'summary') continue;

      const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '??:??:??';

      if (msg.type === 'user') {
        const content = msg.message?.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          const textItem = content.find(c => c.type === 'text');
          text = textItem?.text || '';
        }

        if (text && !text.startsWith('<system-reminder>')) {
          timeline.push({
            time: timestamp,
            type: 'user',
            content: text.substring(0, 200)
          });
        }
      } else if (msg.type === 'assistant') {
        turnNumber++;
        const items = msg.message?.content || [];

        const tools = items.filter(i => i.type === 'tool_use').map(i => i.name);
        const text = items.find(i => i.type === 'text')?.text || '';

        timeline.push({
          time: timestamp,
          type: 'assistant',
          turn: turnNumber,
          tools: tools,
          textPreview: text.substring(0, 200)
        });
      }
    }

    if (format === 'text') {
      const textTimeline = timeline.map(t => {
        const icon = t.type === 'user' ? '👤' : '🤖';
        const turnStr = t.turn ? `[Turn ${t.turn}] ` : '';
        const toolStr = t.tools?.length > 0 ? `Tools: ${t.tools.join(', ')}` : '';
        const content = t.content || t.textPreview || toolStr || '';
        return `${t.time} ${icon} ${turnStr}${content.substring(0, 80)}`;
      }).join('\n');

      return {
        content: [{
          type: 'text',
          text: `SESSION TIMELINE: ${sessionId}\n${'='.repeat(60)}\n${textTimeline}`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ sessionId, timeline }, null, 2)
      }]
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEEP ANALYSIS TOOLS (NEW!)
  // ═══════════════════════════════════════════════════════════════════════════════

  async analyzeToolEffectiveness(args) {
    const { hoursAgo = 24 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);

    const toolStats = {};

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);

          let currentToolCall = null;

          for (const msg of messages) {
            if (msg.type === 'assistant' && msg.message?.content) {
              for (const item of msg.message.content) {
                if (item.type === 'tool_use') {
                  currentToolCall = { tool: item.name, id: item.id };
                  if (!toolStats[item.name]) {
                    toolStats[item.name] = { total: 0, success: 0, error: 0, durations: [] };
                  }
                  toolStats[item.name].total++;
                }
              }
            } else if (msg.type === 'user' && msg.message?.content && currentToolCall) {
              for (const item of msg.message.content) {
                if (item.type === 'tool_result' && item.tool_use_id === currentToolCall.id) {
                  const resultStr = typeof item.content === 'string' ?
                    item.content : JSON.stringify(item.content);

                  if (resultStr.toLowerCase().includes('error') ||
                      resultStr.toLowerCase().includes('failed') ||
                      resultStr.toLowerCase().includes('exception')) {
                    toolStats[currentToolCall.tool].error++;
                  } else {
                    toolStats[currentToolCall.tool].success++;
                  }
                  currentToolCall = null;
                }
              }
            }
          }
        } catch (e) {
          // Skip
        }
      }
    }

    // Calculate effectiveness metrics
    const effectiveness = Object.entries(toolStats)
      .map(([tool, stats]) => ({
        tool,
        totalCalls: stats.total,
        successCount: stats.success,
        errorCount: stats.error,
        successRate: stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) + '%' : 'N/A',
        errorRate: stats.total > 0 ? ((stats.error / stats.total) * 100).toFixed(1) + '%' : 'N/A'
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hoursAgo,
          totalToolCalls: effectiveness.reduce((sum, e) => sum + e.totalCalls, 0),
          toolEffectiveness: effectiveness.slice(0, 20),
          highestErrorRateTools: effectiveness
            .filter(e => e.errorCount > 2)
            .sort((a, b) => parseFloat(b.errorRate) - parseFloat(a.errorRate))
            .slice(0, 5)
        }, null, 2)
      }]
    };
  }

  async findSimilarSessions(args) {
    const { sessionId, limit = 5 } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const refMessages = await parseJsonlFile(sessionInfo.path);
    const refToolCalls = await getToolCallsFromSession(sessionInfo.path);

    // Get reference session characteristics
    const refTools = new Set(refToolCalls.map(tc => tc.tool));
    const refUserMsgs = refMessages.filter(m => m.type === 'user');
    const refPrompt = refUserMsgs[0]?.message?.content;
    const refPromptText = typeof refPrompt === 'string' ? refPrompt :
      (refPrompt?.[0]?.text || '').toLowerCase();

    const similar = [];

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const compSessionId = file.replace('.jsonl', '');
        if (compSessionId === sessionId) continue;

        const filePath = path.join(projectPath, file);

        try {
          const messages = await parseJsonlFile(filePath);
          const toolCalls = await getToolCallsFromSession(filePath);

          // Calculate similarity score
          const compTools = new Set(toolCalls.map(tc => tc.tool));

          const userMsgs = messages.filter(m => m.type === 'user');
          const prompt = userMsgs[0]?.message?.content;
          const promptText = typeof prompt === 'string' ? prompt :
            (prompt?.[0]?.text || '').toLowerCase();

          const refWords = new Set(refPromptText.split(/\s+/));
          const compWords = new Set(promptText.split(/\s+/));

          const score = calculateSimilarityScore(refTools, refWords, compTools, compWords);
          const toolSimilarity = [...refTools].filter(t => compTools.has(t)).length / Math.max(refTools.size, compTools.size, 1);
          const promptSimilarity = [...refWords].filter(w => compWords.has(w)).length / Math.max(refWords.size, compWords.size, 1);

          if (score > 0.2) {
            similar.push({
              sessionId: compSessionId,
              project: project.replace(/-/g, '/'),
              score: (score * 100).toFixed(1) + '%',
              toolSimilarity: (toolSimilarity * 100).toFixed(1) + '%',
              promptSimilarity: (promptSimilarity * 100).toFixed(1) + '%',
              promptPreview: promptText.substring(0, 100)
            });
          }
        } catch (e) {
          // Skip
        }
      }
    }

    similar.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          referenceSession: sessionId,
          similarSessions: similar.slice(0, limit)
        }, null, 2)
      }]
    };
  }

  async getConversationInsights(args) {
    const { hoursAgo = 168 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);

    const insights = {
      hourlyActivity: {},
      projectStats: {},
      avgSessionLength: { totalMs: 0, count: 0 },
      taskTypes: { codeReview: 0, bugFix: 0, newFeature: 0, research: 0, other: 0 }
    };

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const projectName = project.replace(/-/g, '/');
      if (!insights.projectStats[projectName]) {
        insights.projectStats[projectName] = { sessions: 0, turns: 0, toolCalls: 0 };
      }

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);

          insights.projectStats[projectName].sessions++;

          const timestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp));
          if (timestamps.length > 0) {
            const hour = timestamps[0].getHours();
            insights.hourlyActivity[hour] = (insights.hourlyActivity[hour] || 0) + 1;

            const duration = Math.max(...timestamps) - Math.min(...timestamps);
            insights.avgSessionLength.totalMs += duration;
            insights.avgSessionLength.count++;
          }

          let turns = 0;
          let toolCalls = 0;

          for (const msg of messages) {
            if (msg.type === 'assistant') {
              turns++;
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'tool_use') {
                  toolCalls++;
                }
              }
            } else if (msg.type === 'user') {
              const content = msg.message?.content;
              const text = typeof content === 'string' ? content.toLowerCase() :
                (content?.[0]?.text || '').toLowerCase();

              insights.taskTypes[classifyTaskType(text)]++;
            }
          }

          insights.projectStats[projectName].turns += turns;
          insights.projectStats[projectName].toolCalls += toolCalls;

        } catch (e) {
          // Skip
        }
      }
    }

    // Calculate averages
    insights.avgSessionLength = insights.avgSessionLength.count > 0 ?
      formatDuration(insights.avgSessionLength.totalMs / insights.avgSessionLength.count) : 'N/A';

    // Sort hourly activity
    const sortedHours = Object.entries(insights.hourlyActivity)
      .sort((a, b) => b[1] - a[1]);

    insights.mostProductiveHours = sortedHours.slice(0, 3).map(([h, c]) => ({
      hour: `${h}:00 - ${parseInt(h) + 1}:00`,
      sessions: c
    }));

    // Sort projects by activity
    insights.mostActiveProjects = Object.entries(insights.projectStats)
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .slice(0, 5)
      .map(([name, stats]) => ({ name, ...stats }));

    delete insights.hourlyActivity;
    delete insights.projectStats;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          analysisWindow: `${hoursAgo} hours`,
          insights
        }, null, 2)
      }]
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ORIGINAL METHODS (kept for compatibility)
  // ═══════════════════════════════════════════════════════════════════════════════

  estimateTokens(text) {
    return estimateTokensFn(text);
  }

  async findSessionFile(sessionId) {
    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);
      const sessionFile = files.find(f => f.includes(sessionId) && f.endsWith('.jsonl'));

      if (sessionFile) {
        return {
          path: path.join(projectPath, sessionFile),
          project: project
        };
      }
    }

    return null;
  }

  async listSessions(args) {
    const { limit = 20, project: projectFilter, hoursAgo = 24 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);
    const sessions = [];

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      if (projectFilter && !project.toLowerCase().includes(projectFilter.toLowerCase())) {
        continue;
      }

      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);

        if (fileStat.mtimeMs < cutoffTime) continue;

        const sessionId = file.replace('.jsonl', '');

        try {
          const messages = await parseJsonlFile(filePath);
          const userMessages = messages.filter(m => m.type === 'user');
          const assistantMessages = messages.filter(m => m.type === 'assistant');

          const firstUserMsg = userMessages[0];
          const prompt = firstUserMsg?.message?.content || 'N/A';
          const promptText = typeof prompt === 'string' ? prompt :
                            (prompt[0]?.text || JSON.stringify(prompt).substring(0, 100));

          sessions.push({
            sessionId,
            project: project.replace(/-/g, '/').replace(/^\//, ''),
            timestamp: fileStat.mtime.toISOString(),
            turns: assistantMessages.length,
            promptPreview: promptText.substring(0, 80) + (promptText.length > 80 ? '...' : ''),
            fileSize: fileStat.size
          });
        } catch (e) {
          // Skip
        }
      }
    }

    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessions: sessions.slice(0, limit),
          total: sessions.length,
          showing: Math.min(limit, sessions.length)
        }, null, 2)
      }]
    };
  }

  async getSessionSummary(args) {
    const { sessionId } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);

    const userMessages = messages.filter(m => m.type === 'user');
    const assistantMessages = messages.filter(m => m.type === 'assistant');

    const toolsUsed = {};
    for (const msg of assistantMessages) {
      const content = msg.message?.content || [];
      for (const item of content) {
        if (item.type === 'tool_use') {
          toolsUsed[item.name] = (toolsUsed[item.name] || 0) + 1;
        }
      }
    }

    const timestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp));
    const startTime = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const endTime = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const durationMs = startTime && endTime ? endTime - startTime : 0;

    const firstPrompt = userMessages[0]?.message?.content || 'N/A';
    const promptText = typeof firstPrompt === 'string' ? firstPrompt :
                      (firstPrompt[0]?.text || JSON.stringify(firstPrompt));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          project: sessionInfo.project,
          startTime: startTime ? new Date(startTime).toISOString() : 'N/A',
          endTime: endTime ? new Date(endTime).toISOString() : 'N/A',
          durationSeconds: Math.round(durationMs / 1000),
          turns: assistantMessages.length,
          toolsUsed,
          totalToolCalls: Object.values(toolsUsed).reduce((a, b) => a + b, 0),
          initialPrompt: promptText.substring(0, 500)
        }, null, 2)
      }]
    };
  }

  async getSessionTools(args) {
    const { sessionId, toolFilter } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);
    const toolCalls = [];

    for (const msg of messages) {
      if (msg.type === 'assistant') {
        const content = msg.message?.content || [];
        for (const item of content) {
          if (item.type === 'tool_use') {
            if (toolFilter && !item.name.toLowerCase().includes(toolFilter.toLowerCase())) {
              continue;
            }
            toolCalls.push({
              tool: item.name,
              input: item.input,
              timestamp: msg.timestamp
            });
          }
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          toolCalls,
          totalCalls: toolCalls.length
        }, null, 2)
      }]
    };
  }

  async getSessionMessages(args) {
    const { sessionId, includeToolResults = false } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);
    const conversation = [];

    for (const msg of messages) {
      if (msg.type === 'user') {
        const content = msg.message?.content;
        if (typeof content === 'string') {
          conversation.push({ role: 'user', content, timestamp: msg.timestamp });
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text') {
              conversation.push({ role: 'user', content: item.text, timestamp: msg.timestamp });
            }
          }
        }
      } else if (msg.type === 'assistant') {
        const content = msg.message?.content || [];
        for (const item of content) {
          if (item.type === 'text') {
            conversation.push({ role: 'assistant', content: item.text, timestamp: msg.timestamp });
          } else if (item.type === 'tool_use') {
            conversation.push({
              role: 'tool_call',
              tool: item.name,
              input: item.input,
              timestamp: msg.timestamp
            });
          }
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          conversation,
          messageCount: conversation.length
        }, null, 2)
      }]
    };
  }

  async searchSessions(args) {
    const { query, hoursAgo = 48, limit = 10 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);
    const results = [];
    const queryLower = query.toLowerCase();

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);

        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const content = await fs.readFile(filePath, 'utf-8');

          if (content.toLowerCase().includes(queryLower)) {
            results.push({
              sessionId: file.replace('.jsonl', ''),
              project: project.replace(/-/g, '/'),
              timestamp: fileStat.mtime.toISOString()
            });
          }
        } catch (e) {
          // Skip
        }
      }
    }

    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query,
          results: results.slice(0, limit),
          totalMatches: results.length
        }, null, 2)
      }]
    };
  }

  async getClaudePExecutions(args) {
    const { hoursAgo = 4, limit = 10 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);
    const executions = [];

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        if (file.startsWith('agent-')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);

        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);

          const userMessages = messages.filter(m => m.type === 'user');
          const assistantMessages = messages.filter(m => m.type === 'assistant');

          if (userMessages.length === 1 && assistantMessages.length <= 15) {
            const firstUser = userMessages[0];
            const prompt = firstUser?.message?.content;
            const promptText = typeof prompt === 'string' ? prompt :
                              (prompt?.[0]?.text || '');

            executions.push({
              sessionId: file.replace('.jsonl', ''),
              project: project.replace(/-/g, '/'),
              timestamp: fileStat.mtime.toISOString(),
              prompt: promptText.substring(0, 150),
              turns: assistantMessages.length
            });
          }
        } catch (e) {
          // Skip
        }
      }
    }

    executions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          executions: executions.slice(0, limit),
          total: executions.length,
          hoursAgo
        }, null, 2)
      }]
    };
  }

  async analyzeSessionErrors(args) {
    const { sessionId } = args;

    const sessionInfo = await this.findSessionFile(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = await parseJsonlFile(sessionInfo.path);
    const errors = [];

    for (const msg of messages) {
      const msgStr = JSON.stringify(msg).toLowerCase();

      if (msgStr.includes('error') || msgStr.includes('failed') ||
          msgStr.includes('exception')) {
        errors.push({
          type: msg.type,
          timestamp: msg.timestamp,
          preview: msgStr.substring(0, 200)
        });
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId,
          errorCount: errors.length,
          errors: errors.slice(0, 10)
        }, null, 2)
      }]
    };
  }

  async compareSessions(args) {
    const { sessionId1, sessionId2 } = args;

    const session1Info = await this.findSessionFile(sessionId1);
    const session2Info = await this.findSessionFile(sessionId2);

    if (!session1Info) throw new Error(`Session 1 not found: ${sessionId1}`);
    if (!session2Info) throw new Error(`Session 2 not found: ${sessionId2}`);

    const messages1 = await parseJsonlFile(session1Info.path);
    const messages2 = await parseJsonlFile(session2Info.path);

    const getStats = (messages) => {
      const tools = {};
      let turns = 0;

      for (const msg of messages) {
        if (msg.type === 'assistant') {
          turns++;
          const content = msg.message?.content || [];
          for (const item of content) {
            if (item.type === 'tool_use') {
              tools[item.name] = (tools[item.name] || 0) + 1;
            }
          }
        }
      }

      return { turns, tools, totalToolCalls: Object.values(tools).reduce((a, b) => a + b, 0) };
    };

    const stats1 = getStats(messages1);
    const stats2 = getStats(messages2);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session1: { id: sessionId1, ...stats1 },
          session2: { id: sessionId2, ...stats2 },
          differences: {
            turnsDiff: stats2.turns - stats1.turns,
            toolCallsDiff: stats2.totalToolCalls - stats1.totalToolCalls
          }
        }, null, 2)
      }]
    };
  }

  async getDailyStatistics(args) {
    const { date, includePrompts = true } = args;
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const stats = {
      date: targetDate.toISOString().split('T')[0],
      totalSessions: 0,
      totalTurns: 0,
      totalToolCalls: 0,
      toolUsage: {}
    };

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);

        if (fileStat.mtime < startOfDay || fileStat.mtime > endOfDay) continue;

        try {
          const messages = await parseJsonlFile(filePath);
          stats.totalSessions++;

          for (const msg of messages) {
            if (msg.type === 'assistant') {
              stats.totalTurns++;
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'tool_use') {
                  stats.totalToolCalls++;
                  stats.toolUsage[item.name] = (stats.toolUsage[item.name] || 0) + 1;
                }
              }
            }
          }
        } catch (e) {
          // Skip
        }
      }
    }

    stats.toolUsage = Object.fromEntries(
      Object.entries(stats.toolUsage).sort((a, b) => b[1] - a[1])
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(stats, null, 2)
      }]
    };
  }

  async getToolUsageStats(args) {
    const { hoursAgo = 24 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);

    const toolStats = {};

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);

          for (const msg of messages) {
            if (msg.type === 'assistant') {
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'tool_use') {
                  toolStats[item.name] = (toolStats[item.name] || 0) + 1;
                }
              }
            }
          }
        } catch (e) {
          // Skip
        }
      }
    }

    const sorted = Object.entries(toolStats).sort((a, b) => b[1] - a[1]);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hoursAgo,
          totalToolCalls: sorted.reduce((sum, [, c]) => sum + c, 0),
          topTools: sorted.slice(0, 20).map(([name, count]) => ({ name, count }))
        }, null, 2)
      }]
    };
  }

  async getAllPrompts(args) {
    const { hoursAgo = 24, minLength = 10 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);
    const prompts = [];

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);
          const sessionId = file.replace('.jsonl', '');

          for (const msg of messages) {
            if (msg.type === 'user') {
              const content = msg.message?.content;
              let text = typeof content === 'string' ? content :
                (content?.[0]?.text || '');

              if (text.length >= minLength && !text.startsWith('<system-reminder>')) {
                prompts.push({
                  sessionId,
                  project: project.replace(/-/g, '/'),
                  prompt: text.substring(0, 500),
                  timestamp: msg.timestamp
                });
              }
            }
          }
        } catch (e) {
          // Skip
        }
      }
    }

    prompts.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hoursAgo,
          totalPrompts: prompts.length,
          prompts
        }, null, 2)
      }]
    };
  }

  async estimateTokenUsage(args) {
    const { hoursAgo = 24 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);

    let totalInput = 0;
    let totalOutput = 0;
    let sessions = 0;

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);
          sessions++;

          for (const msg of messages) {
            if (msg.type === 'user') {
              const content = msg.message?.content;
              const text = typeof content === 'string' ? content : JSON.stringify(content);
              totalInput += this.estimateTokens(text);
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'text') {
                  totalOutput += this.estimateTokens(item.text);
                }
              }
            }
          }
        } catch (e) {
          // Skip
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hoursAgo,
          sessions,
          estimatedInputTokens: totalInput,
          estimatedOutputTokens: totalOutput,
          totalTokens: totalInput + totalOutput,
          estimatedCostUSD: ((totalInput * 3 + totalOutput * 15) / 1000000).toFixed(4)
        }, null, 2)
      }]
    };
  }

  async generateWorkSummary(args) {
    const { hoursAgo = 24 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);

    const summary = {
      period: `Last ${hoursAgo} hours`,
      projects: new Set(),
      totalSessions: 0,
      totalTurns: 0,
      topTools: {}
    };

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);
          summary.projects.add(project.replace(/-/g, '/'));
          summary.totalSessions++;

          for (const msg of messages) {
            if (msg.type === 'assistant') {
              summary.totalTurns++;
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'tool_use') {
                  summary.topTools[item.name] = (summary.topTools[item.name] || 0) + 1;
                }
              }
            }
          }
        } catch (e) {
          // Skip
        }
      }
    }

    summary.projects = Array.from(summary.projects);
    summary.topTools = Object.entries(summary.topTools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(summary, null, 2)
      }]
    };
  }

  async identifyAutomationOpportunities(args) {
    const { hoursAgo = 168 } = args;
    const cutoffTime = Date.now() - (hoursAgo * 60 * 60 * 1000);

    const patterns = { prompts: {}, sequences: {} };

    const projects = await fs.readdir(PROJECTS_DIR);

    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stat = await fs.stat(projectPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(projectPath);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;

        const filePath = path.join(projectPath, file);
        const fileStat = await fs.stat(filePath);
        if (fileStat.mtimeMs < cutoffTime) continue;

        try {
          const messages = await parseJsonlFile(filePath);
          const tools = [];

          for (const msg of messages) {
            if (msg.type === 'user') {
              const content = msg.message?.content;
              let text = typeof content === 'string' ? content :
                (content?.[0]?.text || '');
              const normalized = text.toLowerCase().replace(/\s+/g, ' ').substring(0, 100);
              if (normalized.length > 20) {
                patterns.prompts[normalized] = (patterns.prompts[normalized] || 0) + 1;
              }
            } else if (msg.type === 'assistant') {
              const content = msg.message?.content || [];
              for (const item of content) {
                if (item.type === 'tool_use') {
                  tools.push(item.name);
                }
              }
            }
          }

          for (let i = 0; i < tools.length - 1; i++) {
            const seq = `${tools[i]} → ${tools[i + 1]}`;
            patterns.sequences[seq] = (patterns.sequences[seq] || 0) + 1;
          }
        } catch (e) {
          // Skip
        }
      }
    }

    const opportunities = [];

    const repeatedPrompts = Object.entries(patterns.prompts)
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (repeatedPrompts.length > 0) {
      opportunities.push({
        type: 'REPEATED_PROMPTS',
        items: repeatedPrompts.map(([p, c]) => ({ pattern: p, occurrences: c }))
      });
    }

    const commonSequences = Object.entries(patterns.sequences)
      .filter(([, c]) => c >= 5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (commonSequences.length > 0) {
      opportunities.push({
        type: 'TOOL_SEQUENCES',
        items: commonSequences.map(([s, c]) => ({ sequence: s, occurrences: c }))
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          analysisWindow: `${hoursAgo} hours`,
          opportunities
        }, null, 2)
      }]
    };
  }

  async saveDailyReport(args) {
    const { date } = args;
    const targetDate = date || new Date().toISOString().split('T')[0];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: 'Invalid date: must match YYYY-MM-DD' }, null, 2)
        }]
      };
    }

    const statsResult = await this.getDailyStatistics({ date: targetDate });
    const stats = JSON.parse(statsResult.content[0].text);

    await fs.mkdir(STATS_DIR, { recursive: true });

    const filename = `daily-report-${targetDate}.json`;
    const filePath = path.join(STATS_DIR, filename);

    await fs.writeFile(filePath, JSON.stringify(stats, null, 2));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          savedTo: filePath,
          date: targetDate
        }, null, 2)
      }]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Conversation Inspector MCP server v3.0.0 running on stdio');
    console.error('NEW: spawn_claude_process, watch_processes, visualize_session, and more!');
  }
}

const server = new ConversationInspectorServer();
server.run().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
