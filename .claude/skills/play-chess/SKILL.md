---
name: play-chess
description: Play a game of chess on a chess-mcp server (join a game, wait for the opponent, look at the board image, check candidate moves on a scratch board, make moves). Use when the user asks you to play chess, join a chess game, or play against another agent/engine.
---

# Playing chess on chess-mcp

The chess server (default `http://localhost:8787`) hosts games where each side is a human, the built-in engine, a Claude model, or an AI agent like you. On every turn you get the position in three forms, and you should use all of them:

- **Text:** FEN, an ASCII board, a piece list, the move history and every legal move.
- **Image:** a PNG of the board from your side.
- **Safety check:** facts about which pieces are hanging, attacked by a cheaper piece, or pinned.

## You will blunder unless you check

Language-model players rarely lose to strategy. They lose to **one-move oversights**: a piece moved onto a square that a far-away bishop, queen or rook covers, or a defender walked away from its job. Real examples from a Claude-vs-Claude game:

- **23. Na5??** The knight jumped to a5, where the rook on the a-file could just take it. Nothing defended a5.
- **46. Rh8+??** The check looked forcing, but the bishop sitting on the long diagonal took the rook: 46...Bxh8. A check is worthless if the checking piece can be captured.

Your blind spots are predictable, so check them deliberately:

1. **The opponent's last move:** what does it attack now? What line did it open (a discovered attack)? Does it threaten mate or a fork?
2. **The Safety check lines:** fix anything of yours that is HANGING or attacked by a cheaper piece first, unless you have something stronger, such as a mate or winning the queen.
3. **The landing square:** who attacks it after you move? Count attackers against defenders. Look along every diagonal, file and rank to the edge of the board. Long-range pieces in corners and on the back ranks are the ones you miss.
4. **What the moving piece stops defending:** your back rank, another piece, a key square.
5. **Checks:** can the checking piece simply be captured? Can the king step away and leave your piece loose?
6. **Knight forks:** where can enemy knights land next move? Keep the king and queen (or the king and a rook) off a fork pattern.
7. **Pins:** a pinned piece does not defend.
8. **Preview before committing.** Run your candidate and the opponent's most forcing reply through `preview_line` or `chess-mcp preview`. Then read the safety report and the list of the opponent's captures and checks.

With a material advantage, trade pieces and keep everything protected. When behind, look for tactics and keep pieces on the board.

## Option A: MCP tools (if the `chess` MCP server is connected)

1. Call `join_game(game_id, side?)` for an existing game, or `new_game(my_side, opponent, ...)` to start one.
2. Loop:
   1. `wait_for_turn(game_id)`. It blocks until the opponent moves; if it says "still waiting", call it again.
   2. Study the text, the image and the safety check.
   3. `preview_line(game_id, moves=["<candidate>", "<their best reply>"])`.
   4. `make_move(game_id, move, comment)`.
3. Stop when a result says **GAME OVER**.

## Option B: CLI (works from any shell)

From the repo root, or use `chess-mcp` if it is installed globally:

```bash
node dist/cli/index.js join <game> --side white --name "Claude"
node dist/cli/index.js wait <game> --side white --timeout 540     # blocks until your move
node dist/cli/index.js preview <game> Na5 Rxa5 --side white        # scratch board; nothing is played
node dist/cli/index.js move <game> Nf3 --side white --comment "develop and control e5"
```

- **`wait` exit codes:** `0` your move, `2` still waiting (run it again), `3` game over.
- **Images:** `wait` and `preview` print a PNG path. Open it with the Read tool to see the board.
- **Background waiting:** in Claude Code you can run `wait` in the background. You are notified when it exits, which means the opponent has moved.
- **Seat tokens:** if you were given one, pass it as `CHESS_SEAT_TOKEN=<token>` together with `--side`.

## Rules of engagement

- Only play moves from the legal list. SAN (`Nf3`, `O-O`, `exd5`, `e8=Q`) and UCI (`g1f3`) both work.
- Don't use a chess engine (including `chess-mcp analyze`) unless the user explicitly allows it. The preview tool is fine: it only shows positions and facts, not evaluations.
- Keep the `comment` to one short sentence; spectators see it.
