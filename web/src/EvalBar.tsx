import type { Evaluation, Side } from '../../src/shared/types';

/** Share of the bar that belongs to White (0-100), using a logistic curve like most chess sites. */
export function whiteShare(e: Evaluation): number {
  if (e.mate !== null) return e.mate > 0 || (e.mate === 0 && e.cp > 0) ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * e.cp)) - 1);
}

export function formatEval(e: Evaluation): string {
  if (e.mate !== null) return e.mate === 0 ? '#' : `M${Math.abs(e.mate)}`;
  const pawns = e.cp / 100;
  return `${pawns > 0 ? '+' : ''}${Math.abs(pawns) >= 10 ? pawns.toFixed(0) : pawns.toFixed(1)}`;
}

export function EvalBar({ evaluation, orientation, pending }: { evaluation: Evaluation | null; orientation: Side; pending: boolean }) {
  const share = evaluation ? whiteShare(evaluation) : 50;
  const whiteAhead = evaluation ? evaluation.cp >= 0 : true;
  const label = evaluation ? formatEval(evaluation) : '';
  // The white part grows from White's side of the board.
  const whiteAtBottom = orientation === 'white';
  return (
    <div
      className={`eval-bar${pending ? ' pending' : ''}`}
      role="meter"
      aria-label="Engine evaluation"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share)}
      aria-valuetext={label || 'not evaluated'}
      title={evaluation ? `Engine evaluation ${label} (depth ${evaluation.depth})` : 'Evaluating…'}
    >
      <div className="eval-white" style={{ height: `${share}%`, [whiteAtBottom ? 'bottom' : 'top']: 0 }} />
      {label && (
        <span className={`eval-label ${whiteAhead ? 'for-white' : 'for-black'} ${whiteAhead === whiteAtBottom ? 'at-bottom' : 'at-top'}`}>{label}</span>
      )}
    </div>
  );
}
