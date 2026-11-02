// Spawns the stdio MCP server (production build) and plays two moves against the engine.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = process.argv[2] ?? 'http://localhost:8787';
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli/index.js', '--server', server, 'mcp'], stderr: 'inherit' });
const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
await client.connect(transport);
const text = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const created: any = await client.callTool({ name: 'new_game', arguments: { opponent: 'engine', engine_level: 4, my_name: 'stdio smoke' } });
const id = /Created game (\S+)\./.exec(text(created))![1];
for (const move of ['d4', 'c4']) {
  const turn: any = await client.callTool({ name: 'wait_for_turn', arguments: { game_id: id, timeout_seconds: 20 } });
  console.log(text(turn).split('\n')[1], '| image:', turn.content.some((c: any) => c.type === 'image'));
  console.log(text(await client.callTool({ name: 'make_move', arguments: { game_id: id, move } })));
}
await client.close();
