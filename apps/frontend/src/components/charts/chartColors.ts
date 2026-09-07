/* The chart series palette. Literals by necessity (Recharts takes colours as props) and the
   ONE place they live, so the bar chart, the donut and the breakdown bars — the last of which
   has no Recharts in it — cannot drift from each other. Each mirrors a token in tokens.css and
   must be updated by hand when that file moves: brand-500 / -400 / -200, then the four status
   tones. tokens.test.ts does not see these, so a stale value here is invisible to the build —
   which is how -200 sat at #EBCDD3 for a release after the token became #E6D0D1. */
export const CHART_COLORS = [
  '#7A1028', // --brand-500
  '#D4708A', // --brand-400
  '#E6D0D1', // --brand-200
  '#2563EB', // --info-500
  '#059669', // --success-500
  '#F59E0B', // --warning-500
  '#EF4444', // --danger-500
] as const
