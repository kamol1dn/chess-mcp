// Connects to a running server's /mcp endpoint and plays a few moves against the engine.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://localhost:8787';
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const show = (r: any) => r.content.map((c: any) => (c.type === 'text' ? c.text.split('\n').slice(0, 3).join(' | ') : `[${c.type} ${c.mimeType} ${c.data.length}b64]`)).join(' || ');
const created: any = await client.callTool({ name: 'new_game', arguments: { my_side: 'white', opponent: 'engine', engine_level: 2, my_name: 'MCP smoke' } });
console.log(show(created));
const id = /Created game (\S+)\./.exec(created.content[0].text)![1];
for (const move of ['e4', 'Nf3', 'Bc4']) {
  const turn: any = await client.callTool({ name: 'wait_for_turn', arguments: { game_id: id, timeout_seconds: 20 } });
  console.log('wait:', show(turn).slice(0, 200));
  const r: any = await client.callTool({ name: 'make_move', arguments: { game_id: id, move, comment: 'smoke test' } });
  console.log('move:', show(r));
}
const bad: any = await client.callTool({ name: 'make_move', arguments: { game_id: id, move: 'Qxh7' } });
console.log('illegal:', bad.isError, show(bad).slice(0, 120));
await client.close();
