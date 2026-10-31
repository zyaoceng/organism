import { t } from '../lib/i18n';

export interface LinePoint {
  x: number;
  y: number | null;
  label?: string;
}
export interface LineSeries {
  name: string;
  color: string;
  points: LinePoint[];
  dashed?: boolean;
  step?: boolean;
}

/** Minimal dependency-free SVG line chart for estimate evolution. */
export function LineChart({
  series,
  height = 230,
  yFormat = (v) => v.toFixed(2),
  xFormat = (x) => new Date(x).toISOString().slice(0, 10),
  hLines = [],
}: {
  series: LineSeries[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (x: number) => string;
  hLines?: { y: number; label: string; color: string }[];
}) {
  const W = 900;
  const H = height;
  const L = 64;
  const R = 110;
  const T = 14;
  const B = 28;
  const pts = series.flatMap((s) => s.points.filter((p) => p.y !== null));
  const ys = [...pts.map((p) => p.y as number), ...hLines.map((h) => h.y)];
  if (!pts.length) return <div className="empty">{t('No values yet for this selection.')}</div>;
  const xs = pts.map((p) => p.x);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x0 === x1) {
    x0 -= 86400000 * 5;
    x1 += 86400000 * 5;
  }
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.12 || Math.abs(y1) * 0.1 || 1;
  y0 -= pad;
  y1 += pad;
  const sx = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  const xticks = [...new Set(xs)].sort((a, b) => a - b);
  const xtickShown = xticks.filter((_, i) => xticks.length <= 8 || i % Math.ceil(xticks.length / 8) === 0);
  return (
    <svg className="svgchart" viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W * 1.25, display: 'block' }} role="img">
      {ticks.map((tk, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={sy(tk)} y2={sy(tk)} stroke="#eceff2" />
          <text x={L - 6} y={sy(tk) + 3} textAnchor="end">
            {yFormat(tk)}
          </text>
        </g>
      ))}
      {xtickShown.map((x) => (
        <text key={x} x={sx(x)} y={H - 8} textAnchor="middle">
          {xFormat(x)}
        </text>
      ))}
      {hLines.map((h, i) => (
        <g key={i}>
          <line x1={L} x2={W - R} y1={sy(h.y)} y2={sy(h.y)} stroke={h.color} strokeDasharray="5 4" />
          <text x={W - R + 4} y={sy(h.y) + 3} style={{ fill: h.color }}>
            {h.label}
          </text>
        </g>
      ))}
      {series.map((s) => {
        const ps = s.points.filter((p) => p.y !== null).sort((a, b) => a.x - b.x);
        if (!ps.length) return null;
        let d = '';
        ps.forEach((p, i) => {
          const X = sx(p.x);
          const Y = sy(p.y as number);
          if (i === 0) d += `M${X},${Y}`;
          else if (s.step) d += `H${X}V${Y}`;
          else d += `L${X},${Y}`;
        });
        const last = ps[ps.length - 1];
        return (
          <g key={s.name}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '4 3' : undefined} />
            {ps.map((p, i) => (
              <circle key={i} cx={sx(p.x)} cy={sy(p.y as number)} r={3.2} fill={s.color}>
                <title>{`${s.name} ${xFormat(p.x)}: ${yFormat(p.y as number)}${p.label ? `\n${p.label}` : ''}`}</title>
              </circle>
            ))}
            <text x={sx(last.x) + 6} y={sy(last.y as number) + 3} style={{ fill: s.color, fontWeight: 600 }}>
              {s.name} {yFormat(last.y as number)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
