/**
 * Pure utility functions for session parsing and analysis.
 * Extracted from index.js for testability.
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Parse JSONL text content into an array of objects.
 * Lines that fail to parse are silently dropped.
 * @param {string} content - raw JSONL text
 * @returns {Array<object>}
 */
export function parseJsonlLines(content) {
  if (!content || typeof content !== 'string') return [];
  const lines = content.trim().split('\n').filter(l => l.trim());
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Extract tool calls from an array of parsed JSONL messages.
 * @param {Array<object>} messages
 * @returns {Array<{tool: string, id: string, input: any, timestamp: string}>}
 */
export function extractToolCallsFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const toolCalls = [];

  for (const msg of messages) {
    if (msg && msg.type === 'assistant' && msg.message?.content) {
      for (const item of msg.message.content) {
        if (item.type === 'tool_use') {
          toolCalls.push({
            tool: item.name,
            id: item.id,
            input: item.input,
            timestamp: msg.timestamp
          });
        }
      }
    }
  }

  return toolCalls;
}

/**
 * Estimate the number of tokens in a text string.
 * Uses the rough heuristic of 1 token ≈ 4 characters.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Calculate a similarity score between two sessions based on tool overlap
 * and prompt word overlap.
 *
 * @param {Set<string>} refTools - tools from the reference session
 * @param {Set<string>} refWords - lowercase words from the reference prompt
 * @param {Set<string>} compTools - tools from the comparison session
 * @param {Set<string>} compWords - lowercase words from the comparison prompt
 * @returns {number} score in [0, 1]
 */
export function calculateSimilarityScore(refTools, refWords, compTools, compWords) {
  const toolOverlap = [...refTools].filter(t => compTools.has(t)).length;
  const toolSimilarity = toolOverlap / Math.max(refTools.size, compTools.size, 1);

  const wordOverlap = [...refWords].filter(w => compWords.has(w)).length;
  const promptSimilarity = wordOverlap / Math.max(refWords.size, compWords.size, 1);

  return (toolSimilarity * 0.6) + (promptSimilarity * 0.4);
}

/**
 * Classify a user message text into a task type.
 * @param {string} text - lowercase message text
 * @returns {'codeReview'|'bugFix'|'newFeature'|'research'|'other'}
 */
export function classifyTaskType(text) {
  if (typeof text !== 'string') return 'other';
  const lower = text.toLowerCase();
  if (lower.includes('review') || lower.includes('check')) return 'codeReview';
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) return 'bugFix';
  if (lower.includes('add') || lower.includes('create') || lower.includes('implement')) return 'newFeature';
  if (lower.includes('find') || lower.includes('search') || lower.includes('what')) return 'research';
  return 'other';
}

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Validate that a date string matches YYYY-MM-DD format to prevent path traversal
 * via the `date` parameter in save_daily_report.
 * @param {string} date
 * @returns {boolean}
 */
export function validateReportDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}
