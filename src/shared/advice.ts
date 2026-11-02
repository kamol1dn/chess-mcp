/**
 * Blunder checklist given to AI players (MCP instructions, CLI bridge prompt,
 * Claude API player). Language models tend to "see" the pieces near the action
 * and miss long-range attackers and what a move stops defending; this targets
 * exactly those blind spots. Keep in sync with .claude/skills/play-chess/SKILL.md.
 */
export const BLUNDER_CHECKLIST = `Blunder check — run it before EVERY move (AI players lose most games to one-move oversights, not to strategy):
1. Opponent's last move: what does it attack now, what did it uncover (discovered attacks), does it threaten mate or a fork?
2. Read the "Safety check" lines: deal with any piece of yours that is HANGING or attacked by a cheaper piece first.
3. Landing square of your move: who attacks it AFTER the move? Count attackers vs defenders. The most-missed attackers are long-range ones: bishops and queens on long diagonals (even from a corner like h8 or a1) and rooks or queens on open files and ranks.
4. What does the moving piece stop defending? A piece that leaves can leave another one hanging or the back rank weak.
5. Checks are not automatically good: make sure the checking piece cannot simply be captured.
6. Knight forks: where can enemy knights jump next move? Don't leave your king and queen/rook a knight's fork apart.
7. A pinned piece does not really defend anything.
8. Play your candidate (and the opponent's most forcing reply) on a scratch board with preview_line / "chess-mcp preview" and read its safety report before committing.
When ahead in material, trade pieces and keep everything protected; when behind, look for tactics.`;
