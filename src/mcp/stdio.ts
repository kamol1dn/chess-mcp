import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChessClient } from '../client/http-client.js';
import { createMcpServer } from './tools.js';

export interface StdioOptions {
  serverUrl: string;
  apiKey?: string;
  images: boolean;
  /** Start an in-process chess server when none is reachable at a localhost URL. */
  autoStart: boolean;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Runs the MCP server over stdio, talking to a chess server over HTTP. */
export async function runStdioMcp(opts: StdioOptions): Promise<void> {
  let serverUrl = opts.serverUrl.replace(/\/+$/, '');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(serverUrl);
  if (opts.autoStart && local && !(await reachable(serverUrl))) {
    // Lazy import keeps the plain MCP proxy lightweight.
    const { startServer } = await import('../server/index.js');
    const port = Number(new URL(serverUrl).port || 80);
    const server = await startServer({ port, host: '127.0.0.1', logToStderr: true, logLevel: process.env.LOG_LEVEL ?? 'warn' });
    serverUrl = server.url;
    process.stderr.write(`chess-mcp: started an embedded chess server at ${serverUrl} (web UI: ${server.config.publicUrl})\n`);
    const stop = () => void server.close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  const backend = new ChessClient(serverUrl, opts.apiKey);
  const server = createMcpServer(backend, { images: opts.images });
  const transport = new StdioServerTransport();
  transport.onclose = () => process.exit(0);
  await server.connect(transport);
}
