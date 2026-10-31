import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { atr, sma, type Bar, type Series } from '../../domain/market/indicators';

export interface ChartMarker {
  time: string;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text: string;
}

export interface ChartPriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export interface Overlay {
  name: string;
  color: string;
  values: Series;
  dashed?: boolean;
}

const MA_COLORS = ['#e08a00', '#6a4fc4', '#1f8a9e', '#a0522d'];

/**
 * Candlesticks + volume + moving averages, ATR in a second pane, markers and price lines.
 * Indicators are pure functions from the domain module, so new ones (e.g. volume profile as a
 * series primitive) can be added without touching data loading.
 */
export function PriceChart(props: { bars: Bar[]; maPeriods: number[]; atrPeriod: number; markers?: ChartMarker[]; priceLines?: ChartPriceLine[]; overlays?: Overlay[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const refs = useRef<{
    candles?: ISeriesApi<'Candlestick'>;
    volume?: ISeriesApi<'Histogram'>;
    atr?: ISeriesApi<'Line'>;
    lines: ISeriesApi<'Line'>[];
    markers?: ISeriesMarkersPluginApi<Time>;
    priceLines: IPriceLine[];
  }>({ lines: [], priceLines: [] });

  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#667281', fontSize: 11 },
      grid: { vertLines: { color: '#f1f3f5' }, horzLines: { color: '#f1f3f5' } },
      rightPriceScale: { borderColor: '#e2e5e9' },
      timeScale: { borderColor: '#e2e5e9' },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    const r = refs.current;
    r.candles = chart.addSeries(CandlestickSeries, { upColor: '#2f7d4f', downColor: '#b5473a', borderVisible: false, wickUpColor: '#2f7d4f', wickDownColor: '#b5473a' });
    r.volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
    r.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    r.atr = chart.addSeries(LineSeries, { color: '#8a5cc2', lineWidth: 1, priceLineVisible: false, title: 'ATR' }, 1);
    r.markers = createSeriesMarkers(r.candles, []);
    const panes = chart.panes();
    if (panes[1]) panes[1].setHeight(110);
    return () => {
      chart.remove();
      chartRef.current = null;
      refs.current = { lines: [], priceLines: [] };
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const r = refs.current;
    if (!chart || !r.candles || !r.volume || !r.atr) return;
    const bars = props.bars;
    r.candles.setData(bars.map((b) => ({ time: b.date as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    r.volume.setData(bars.map((b) => ({ time: b.date as Time, value: b.volume, color: b.close >= b.open ? 'rgba(47,125,79,.35)' : 'rgba(181,71,58,.35)' })));
    const a = atr(bars, props.atrPeriod);
    r.atr.setData(bars.flatMap((b, i) => (a[i] === null ? [] : [{ time: b.date as Time, value: a[i] as number }])));
    r.atr.applyOptions({ title: `ATR ${props.atrPeriod}` });
    for (const l of r.lines) chart.removeSeries(l);
    r.lines = [];
    const closes = bars.map((b) => b.close);
    props.maPeriods.forEach((n, k) => {
      const s = chart.addSeries(LineSeries, { color: MA_COLORS[k % MA_COLORS.length], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: `MA${n}` });
      const m = sma(closes, n);
      s.setData(bars.flatMap((b, i) => (m[i] === null ? [] : [{ time: b.date as Time, value: m[i] as number }])));
      r.lines.push(s);
    });
    for (const o of props.overlays ?? []) {
      const s = chart.addSeries(LineSeries, { color: o.color, lineWidth: 1, lineStyle: o.dashed ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, title: o.name });
      s.setData(bars.flatMap((b, i) => (o.values[i] === null || o.values[i] === undefined ? [] : [{ time: b.date as Time, value: o.values[i] as number }])));
      r.lines.push(s);
    }
    chart.timeScale().fitContent();
  }, [props.bars, props.maPeriods, props.atrPeriod, props.overlays]);

  useEffect(() => {
    const r = refs.current;
    if (!r.candles || !r.markers) return;
    const first = props.bars[0]?.date;
    const last = props.bars.at(-1)?.date;
    const ms: SeriesMarker<Time>[] = (props.markers ?? [])
      .filter((m) => first && last && m.time >= first && m.time <= last)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((m) => ({ time: snapToBar(props.bars, m.time) as Time, position: m.position, color: m.color, shape: m.shape, text: m.text }));
    r.markers.setMarkers(ms);
    for (const pl of r.priceLines) r.candles.removePriceLine(pl);
    r.priceLines = (props.priceLines ?? [])
      .filter((p) => Number.isFinite(p.price))
      .map((p) => r.candles!.createPriceLine({ price: p.price, color: p.color, lineWidth: 1, lineStyle: p.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: p.title }));
  }, [props.markers, props.priceLines, props.bars]);

  return <div ref={el} style={{ width: '100%', height: props.height ?? 520 }} data-testid="price-chart" />;
}

/** Markers must sit on a bar's time: move non-trading days to the next bar. */
function snapToBar(bars: Bar[], date: string): string {
  for (const b of bars) if (b.date >= date) return b.date;
  return bars.at(-1)?.date ?? date;
}
