#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Create data directory
const DATA_DIR = path.join(os.homedir(), '.mcp-tool-tracker');

// In-memory tracking
const sequences = [];
let currentSequence = {
  id: `seq_${Date.now()}`,
  tools: [],
  startTime: Date.now()
};
const toolStats = {};
const patterns = {};

const server = new Server(
  {
    name: 'mcp-tool-tracker',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper functions
function evaluateHasResults(toolName, result) {
  if (!result) return false;
  
  // Try to parse result if it's a string
  let parsed = result;
  if (typeof result === 'string') {
    try {
      // Check for common "no results" messages
      if (result.includes('No matches found') || 
          result.includes('0 matching memories') ||
          result.includes('not found')) {
        return false;
      }
      return result.length > 50; // Assume short responses are failures
    } catch (e) {
      return !!result;
    }
  }
  
  // For objects/arrays
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'object') return Object.keys(result).length > 0;
  return !!result;
}

function analyzeSequence(seq) {
  // Pattern: Multiple searches in a row
  let consecutiveSearches = 0;
  let searchFailures = 0;
  
  for (let i = 0; i < seq.tools.length; i++) {
    const tool = seq.tools[i];
    
    if (tool.tool.includes('search') || tool.tool.includes('recall')) {
      consecutiveSearches++;
      if (!tool.hasResults) searchFailures++;
    } else {
      if (consecutiveSearches > 2 && searchFailures > 1) {
        recordPattern('multiple_failed_searches', { count: consecutiveSearches, failures: searchFailures });
      }
      consecutiveSearches = 0;
      searchFailures = 0;
    }
    
    // Pattern: Search then brain (wrong order)
    if (i > 0 && 
        seq.tools[i-1].tool.includes('search') && 
        tool.tool.includes('brain') && 
        tool.hasResults) {
      recordPattern('search_before_brain');
    }
  }
}

function recordPattern(patternType, detail = null) {
  if (!patterns[patternType]) {
    patterns[patternType] = { count: 0, details: [] };
  }
  patterns[patternType].count++;
  if (detail) {
    patterns[patternType].details.push(detail);
  }
}

function calculateSuccessScore(stats) {
  if (!stats || stats.calls === 0) return 0;
  
  const successRate = (stats.calls - stats.emptyResults) / stats.calls;
  const usageRate = stats.resultsUsed / Math.max(1, stats.calls - stats.emptyResults);
  
  return successRate * 0.6 + usageRate * 0.4;
}

// Initialize data directory
async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error('Failed to create data directory:', e);
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'track_tool_call',
        description: 'Record a tool call for pattern analysis',
        inputSchema: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              description: 'Tool name that was called',
            },
            params: {
              type: 'object',
              description: 'Parameters passed to the tool',
            },
            result: {
              type: 'string',
              description: 'Result from the tool (stringified)',
            },
            resultUsed: {
              type: 'boolean',
              description: 'Whether the result was used in response',
            }
          },
          required: ['tool'],
        },
      },
      {
        name: 'track_sequence_end',
        description: 'Mark end of a tool sequence and analyze patterns',
        inputSchema: {
          type: 'object',
          properties: {
            satisfied: {
              type: 'boolean',
              description: 'Whether the user seemed satisfied with results',
            }
          },
        },
      },
      {
        name: 'track_get_insights',
        description: 'Get insights from tracked patterns',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'track_get_recommendations',
        description: 'Get protocol update recommendations',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'track_reset',
        description: 'Reset tracking data',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'track_help',
        description: 'Get help on using the tool tracker',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case 'track_tool_call': {
      const { tool, params, result, resultUsed = false } = args;
      
      // Record the tool call
      const toolCall = {
        tool,
        params,
        timestamp: Date.now(),
        hasResults: evaluateHasResults(tool, result),
        resultUsed
      };
      
      currentSequence.tools.push(toolCall);
      
      // Update stats
      if (!toolStats[tool]) {
        toolStats[tool] = {
          calls: 0,
          emptyResults: 0,
          resultsUsed: 0
        };
      }
      
      toolStats[tool].calls++;
      if (!toolCall.hasResults) {
        toolStats[tool].emptyResults++;
      }
      if (resultUsed) {
        toolStats[tool].resultsUsed++;
      }
      
      return {
        content: [{
          type: 'text',
          text: `Tracked ${tool} call. Sequence length: ${currentSequence.tools.length}`
        }]
      };
    }
    
    case 'track_sequence_end': {
      const { satisfied } = args;
      
      currentSequence.endTime = Date.now();
      currentSequence.duration = currentSequence.endTime - currentSequence.startTime;
      currentSequence.satisfied = satisfied;
      
      // Analyze the sequence
      analyzeSequence(currentSequence);
      
      // Store and reset
      sequences.push(currentSequence);
      const seqLength = currentSequence.tools.length;
      
      currentSequence = {
        id: `seq_${Date.now()}`,
        tools: [],
        startTime: Date.now()
      };
      
      return {
        content: [{
          type: 'text',
          text: `Sequence analyzed. Length: ${seqLength} tools, Duration: ${(sequences[sequences.length-1].duration / 1000).toFixed(1)}s`
        }]
      };
    }
    
    case 'track_get_insights': {
      const insights = [];
      
      // Analyze patterns
      if (patterns.multiple_failed_searches?.count > 2) {
        insights.push(`⚠️ Pattern: Multiple failed searches detected ${patterns.multiple_failed_searches.count} times. Consider checking brain_recall first.`);
      }
      
      if (patterns.search_before_brain?.count > 1) {
        insights.push(`📊 Pattern: Searching files before checking brain ${patterns.search_before_brain.count} times. Brain often has the answer already.`);
      }
      
      // Analyze tool success rates
      const toolAnalysis = [];
      for (const [tool, stats] of Object.entries(toolStats)) {
        const score = calculateSuccessScore(stats);
        const emptyRate = ((stats.emptyResults / stats.calls) * 100).toFixed(0);
        
        if (score < 0.3) {
          toolAnalysis.push(`❌ ${tool}: ${emptyRate}% empty results (${stats.calls} calls)`);
        } else if (score < 0.6) {
          toolAnalysis.push(`⚠️ ${tool}: ${emptyRate}% empty results (${stats.calls} calls)`);
        }
      }
      
      const response = [
        '# Tool Usage Insights\n',
        `Sequences analyzed: ${sequences.length}`,
        `Total tool calls: ${Object.values(toolStats).reduce((sum, s) => sum + s.calls, 0)}`,
        '',
        '## Patterns Detected:',
        ...insights,
        '',
        '## Tool Performance:',
        ...toolAnalysis
      ].join('\n');
      
      return {
        content: [{
          type: 'text',
          text: response
        }]
      };
    }
    
    case 'track_get_recommendations': {
      const recommendations = [];
      
      // Check for low-performing tools
      for (const [tool, stats] of Object.entries(toolStats)) {
        const score = calculateSuccessScore(stats);
        
        if (score < 0.3 && stats.calls > 2) {
          recommendations.push({
            tool,
            issue: `Very low success rate (${(score * 100).toFixed(0)}%)`,
            recommendation: `Consider alternatives to ${tool} or verify it's being used correctly`,
            protocol: `Before using ${tool}:\n1. Check if brain_recall has the info\n2. Ask user if they specifically want this tool\n3. Warn about low success rate`
          });
        }
      }
      
      // Check for patterns
      if (patterns.search_before_brain?.count > 2) {
        recommendations.push({
          pattern: 'search_before_brain',
          issue: 'Inefficient tool order',
          recommendation: 'Check brain before searching files',
          protocol: 'Tool Priority Order:\n1. brain_recall (fastest)\n2. working memory\n3. file search (only if needed)\n4. web search (external only)'
        });
      }
      
      if (recommendations.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No recommendations yet. Need more data to identify patterns.'
          }]
        };
      }
      
      const response = recommendations.map(rec => 
        `## ${rec.tool || rec.pattern}\n**Issue**: ${rec.issue}\n**Recommendation**: ${rec.recommendation}\n\n**Suggested Protocol**:\n${rec.protocol}`
      ).join('\n\n---\n\n');
      
      return {
        content: [{
          type: 'text',
          text: `# Protocol Update Recommendations\n\n${response}`
        }]
      };
    }
    
    case 'track_reset': {
      sequences.length = 0;
      currentSequence = {
        id: `seq_${Date.now()}`,
        tools: [],
        startTime: Date.now()
      };
      Object.keys(toolStats).forEach(key => delete toolStats[key]);
      Object.keys(patterns).forEach(key => delete patterns[key]);
      
      return {
        content: [{
          type: 'text',
          text: 'Tracking data reset successfully.'
        }]
      };
    }
    
    case 'track_help': {
      return {
        content: [{
          type: 'text',
          text: `# Tool Tracker Help

This tool tracks patterns in tool usage to identify inefficiencies and suggest protocol improvements.

## How it works:
1. Each tool call is tracked with track_tool_call
2. Sequences are analyzed with track_sequence_end
3. Patterns emerge over time
4. Get insights and recommendations to improve

## Usage:
1. After each tool call:
   track_tool_call({ tool: "tool_name", result: "result_text", resultUsed: true/false })

2. At end of task sequence:
   track_sequence_end({ satisfied: true/false })

3. Check insights periodically:
   track_get_insights()
   track_get_recommendations()

## What it tracks:
- Tool success/failure rates
- Common sequences (e.g., multiple failed searches)
- Whether results are actually used
- Time patterns

## Goal:
Identify which tools work well and which waste time, then update protocols accordingly.`
        }]
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Initialize
initDataDir();

// Start the server
const transport = new StdioServerTransport();
server.connect(transport);
console.error('mcp-tool-tracker MCP server running on stdio');
