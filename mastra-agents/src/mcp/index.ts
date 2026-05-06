/**
 * MCP Client Configuration
 * 
 * Configures remote MCP servers (like DeepWiki) that agents can use.
 * Tools from these servers are made available to specific agents based on their roles.
 */

import { MCPClient } from "@mastra/mcp";

/**
 * DeepWiki MCP Client
 * 
 * Provides semantic understanding of external GitHub repositories for:
 * - Fork analysis and planning
 * - Plugin integration research
 * - Code review benchmarking
 * - Product and market analysis
 * - Feature engineering
 * - Reverse engineering
 */
const deepWikiMCP = new MCPClient({
  id: "deepwiki-mcp-client",
  servers: {
    deepwiki: {
      url: new URL(process.env.DEEPWIKI_MCP_URL ?? "https://mcp.deepwiki.com/mcp"),
      // DeepWiki may require API key for authenticated requests
      ...(process.env.DEEPWIKI_API_KEY && {
        requestInit: {
          headers: {
            Authorization: `Bearer ${process.env.DEEPWIKI_API_KEY}`,
          },
        },
      }),
    },
  },
  timeout: 60000, // 60 second timeout for DeepWiki queries
});

/**
 * Get DeepWiki tools for agent use
 * 
 * Tools are namespaced as "deepwiki_<toolName>" to prevent conflicts.
 * 
 * Available tools:
 * - deepwiki_read_wiki_structure: Get repository structure/topics
 * - deepwiki_read_wiki_contents: Read specific topic contents
 * - deepwiki_ask_question: Ask questions about the codebase
 */
export async function getDeepWikiTools() {
  return deepWikiMCP.listTools();
}

/**
 * Get DeepWiki toolsets for dynamic tool loading
 * 
 * Use this when tools should be loaded dynamically per request.
 */
export async function getDeepWikiToolsets() {
  return deepWikiMCP.listToolsets();
}
