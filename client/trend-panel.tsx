/**
 * A 30-day spend chart, drawn as lines with real axes.
 *
 * Why lines with axes: the question is the shape of the month, and a line shows trend and slope
 * where a column only shows a height. The axes make the reading exact: a labelled cost scale on
 * the left, dated ticks underneath, and a crosshair that names the day you point at.
 *
 * Every element is a `View` positioned absolutely, so the same chart renders on desktop, web and
 * phone without a chart library. Segment rotation is around the segment's own centre, which is the
 * one rotation origin that behaves identically on every React Native renderer.
 */
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = PluginScreenProps["theme"];

export interface TrendSeries {
  id: string;
  label: string;
  color: string;
  /** Cost per day, aligned to the dates array. */
  daily: number[];
}

export interface TrendProps {
  theme: Theme;
  /** ISO dates, oldest first. */
  dates: string[];
  series: TrendSeries[];
  models: Array<{ model: string; cost: number; turns: number }>;
  height?: number;
}

const usd = (value: number) =>
  value >= 1 ? `$${value.toFixed(2)}` : value >= 0.1 ? `$${value.toFixed(2)}` : value > 0 ? `$${value.toFixed(3)}` : "$0";

/** The smallest round number at or above `raw`: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 0.01;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const ratio = raw / base;
  const step = ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10;
  return step * base;
}

/**
 * A cost axis of about four intervals. The step is rounded first and the top is then rounded up to
 * a multiple of it, which is what makes the labels read as money rather than as a peak divided by
 * four.
 */
function costAxis(peak: number): { max: number; ticks: number[] } {
  const step = niceStep(Math.max(peak, 0.01) / 4);
  const top = Math.ceil(Math.max(peak, step) / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toFixed(6)));
  return { max: top, ticks };
}

/** A polyline as one thin, rotated `View` per segment. */
function segmentsOf(points: Array<{ x: number; y: number }>) {
  return points.slice(1).map((point, index) => {
    const from = points[index]!;
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    return {
      left: (from.x + point.x) / 2 - length / 2,
      top: (from.y + point.y) / 2,
      width: Math.max(length, 1),
      angle: Math.atan2(dy, dx),
    };
  });
}

/** The day index under a pointer, from whatever x the event flavour provides. */
function indexFrom(event: unknown, plotWidth: number, count: number): number {
  const native = (event as { nativeEvent?: { locationX?: number; offsetX?: number } }).nativeEvent;
  const x = native?.locationX ?? native?.offsetX ?? 0;
  const index = Math.round((x / Math.max(plotWidth, 1)) * Math.max(count - 1, 0));
  return Math.min(Math.max(index, 0), Math.max(count - 1, 0));
}

const PLOT_LEFT = 46;
const PLOT_RIGHT = 8;
const PLOT_TOP = 8;
const AXIS_HEIGHT = 16;

export function TrendPanel({ theme, dates, series, models, height = 132 }: TrendProps) {
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  const plotWidth = Math.max(width - PLOT_LEFT - PLOT_RIGHT, 0);
  const plotHeight = Math.max(height - PLOT_TOP - AXIS_HEIGHT, 0);

  const geometry = useMemo(() => {
    const peak = Math.max(...series.flatMap((line) => line.daily), 0);
    const { max, ticks } = costAxis(peak);
    const count = dates.length;

    const xAt = (index: number) => PLOT_LEFT + (count <= 1 ? 0 : (index / (count - 1)) * plotWidth);
    // Zero sits on the baseline, the max on the top gridline: a linear cost axis.
    const yAt = (cost: number) => PLOT_TOP + (1 - Math.min(cost / max, 1)) * plotHeight;

    // One gridline per axis tick, drawn from its own value so the label and the line agree.
    const gridlines = ticks.map((value) => ({
      value,
      top: value > 0,
      y: yAt(value),
    }));

    const total = series.reduce((sum, line) => sum + line.daily.reduce((s, value) => s + value, 0), 0);
    // The average day is a reference, not a target: a dashed line across the plot.
    const average = dates.length > 0 ? total / dates.length : 0;

    const lines = series
      .filter((line) => line.daily.some((value) => value > 0))
      .map((line) => ({
        ...line,
        total: line.daily.reduce((sum, value) => sum + value, 0),
        points: line.daily.map((cost, index) => ({ x: xAt(index), y: yAt(cost) })),
        segments: segmentsOf(line.daily.map((cost, index) => ({ x: xAt(index), y: yAt(cost) }))),
      }));

    return { max, count, xAt, yAt, gridlines, lines, plotWidth, average, total };
  }, [dates.length, series, plotWidth, plotHeight]);

  const windowCost = series.reduce((sum, line) => sum + line.daily.reduce((s, value) => s + value, 0), 0);
  const modelCost = models.reduce((sum, model) => sum + model.cost, 0);
  const cursorCost = cursor !== null ? dates.map((_, i) => series.reduce((s, l) => s + (l.daily[i] ?? 0), 0))[cursor] ?? 0 : null;

  return (
    <View
      style={{
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <View style={{ gap: 1 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.4 }}>
            DAILY SPEND · LAST 30 DAYS
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {geometry.lines.length} {geometry.lines.length === 1 ? "account" : "accounts"} with spend
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const }}>
            {usd(windowCost)}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {cursor !== null
              ? `${dates[cursor]?.slice(5)} · ${usd(cursorCost ?? 0)}`
              : `avg ${usd(windowCost / Math.max(dates.length, 1))}/day`}
          </Text>
        </View>
      </View>

      <View
        style={{ height, width: "100%" }}
        onLayout={(event) => {
          const next = Math.round(event.nativeEvent.layout.width);
          if (next > 0 && next !== width) setWidth(next);
        }}
      >
        {width > 0 ? (
          <>
            {/* The plot surface first, so the grid and the lines sit on top of it. */}
            <View
              style={{
                position: "absolute",
                left: PLOT_LEFT,
                top: PLOT_TOP,
                width: geometry.plotWidth,
                height: plotHeight,
                backgroundColor: theme.colors.surface2,
                opacity: 0.5,
                borderRadius: 4,
              }}
            />

            {/* Y axis: a gridline per tick, with the cost it represents on the left. */}
            {geometry.gridlines.map((line) => (
              <View
                key={`g${line.value}`}
                style={{ position: "absolute", left: 0, right: 0, top: line.y, flexDirection: "row", alignItems: "center" }}
              >
                <Text
                  style={{
                    width: PLOT_LEFT - 6,
                    textAlign: "right",
                    color: theme.colors.foregroundMuted,
                    fontSize: 9,
                    opacity: line.top ? 0.75 : 1,
                  }}
                  numberOfLines={1}
                >
                  {usd(line.value)}
                </Text>
                <View
                  style={{
                    flex: 1,
                    height: 1,
                    backgroundColor: theme.colors.border,
                    // The baseline is the axis, so it reads stronger than the grid above it.
                    opacity: line.top ? 0.4 : 0.9,
                  }}
                />
              </View>
            ))}

            {/* The average day: a dashed rule, so the eye can see above or below it at a glance. */}
            {geometry.average > 0 ? (
              <View
                style={{
                  position: "absolute",
                  left: PLOT_LEFT,
                  width: geometry.plotWidth,
                  top: geometry.yAt(geometry.average),
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.foregroundMuted,
                  borderStyle: "dashed" as const,
                  opacity: 0.5,
                }}
              />
            ) : null}

            {/* One line per account, over the gridlines. */}
            {geometry.lines.map((line) => (
              <View key={line.id}>
                {line.segments.map((segment, index) => (
                  <View
                    key={`${line.id}-${index}`}
                    style={{
                      position: "absolute",
                      left: segment.left,
                      top: segment.top - 1,
                      width: segment.width,
                      height: 2,
                      borderRadius: 1,
                      backgroundColor: line.color,
                      opacity: cursor === null ? 0.95 : 0.75,
                      transform: [{ rotate: `${segment.angle}rad` }],
                    }}
                  />
                ))}
                {/* A dot per day, so a single-day spike is still a mark and not only a slope. */}
                {line.points.map((point, index) => (
                  <View
                    key={`${line.id}-p${index}`}
                    style={{
                      position: "absolute",
                      left: point.x - 1.5,
                      top: point.y - 1.5,
                      width: 3,
                      height: 3,
                      borderRadius: 1.5,
                      backgroundColor: line.color,
                      opacity: cursor === null || cursor === index ? 1 : 0.4,
                    }}
                  />
                ))}
              </View>
            ))}

            {/* The crosshair: one vertical line and a dot per series at the day under the pointer. */}
            {cursor !== null ? (
              <>
                <View
                  style={{
                    position: "absolute",
                    left: geometry.xAt(cursor),
                    top: PLOT_TOP,
                    height: plotHeight,
                    width: 1,
                    backgroundColor: theme.colors.foregroundMuted,
                    opacity: 0.5,
                  }}
                />
                {geometry.lines.map((line) => (
                  <View
                    key={`c${line.id}`}
                    style={{
                      position: "absolute",
                      left: geometry.xAt(cursor) - 3,
                      top: geometry.yAt(line.daily[cursor] ?? 0) - 3,
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: line.color,
                      borderWidth: 1,
                      borderColor: theme.colors.surface1,
                    }}
                  />
                ))}
              </>
            ) : null}

            {/* The tooltip: the day's total and each account's share, at the pointer. */}
            {cursor !== null ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: Math.min(
                    Math.max(geometry.xAt(cursor) + 8, PLOT_LEFT),
                    Math.max(width - 150 - PLOT_RIGHT, PLOT_LEFT),
                  ),
                  top: PLOT_TOP + 4,
                  minWidth: 112,
                  paddingVertical: 5,
                  paddingHorizontal: 7,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                  gap: 2,
                }}
              >
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const }}>
                    {dates[cursor]?.slice(5)}
                  </Text>
                  <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" as const }}>
                    {usd(cursorCost ?? 0)}
                  </Text>
                </View>
                {geometry.lines.map((line) => (
                  <View key={`t${line.id}`} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <View style={{ width: 5, height: 2, borderRadius: 1, backgroundColor: line.color }} />
                    <Text
                      style={{ color: theme.colors.foregroundMuted, fontSize: 9, flexShrink: 1 }}
                      numberOfLines={1}
                    >
                      {line.label}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                      {usd(line.daily[cursor] ?? 0)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Tap or hover anywhere on the plot: the day is picked from the pointer's x position. */}
            <Pressable
              accessibilityRole="none"
              style={{ position: "absolute", left: PLOT_LEFT, top: 0, width: plotWidth, height: plotHeight }}
              onPressIn={(event) => setCursor(indexFrom(event, plotWidth, geometry.count))}
              onHoverIn={(event) => setCursor(indexFrom(event, plotWidth, geometry.count))}
              onHoverOut={() => setCursor(null)}
            />

            {/* X axis: five dated ticks, evenly spaced, ends included. */}
            {Array.from({ length: 5 }, (_, step) =>
              Math.round((step / 4) * Math.max(geometry.count - 1, 0)),
            )
              .filter((index, position, all) => all.indexOf(index) === position)
              .map((index) => (
              <Text
                key={`x${index}`}
                style={{
                  position: "absolute",
                  left: Math.min(
                    Math.max(geometry.xAt(index) - 15, PLOT_LEFT - 15),
                    Math.max(width - PLOT_RIGHT - 15, PLOT_LEFT),
                  ),
                  top: PLOT_TOP + plotHeight + 3,
                  width: 30,
                  textAlign: "center",
                  color: theme.colors.foregroundMuted,
                  fontSize: 9,
                }}
              >
                {dates[index]?.slice(5)}
              </Text>
              ))}
          </>
        ) : null}
      </View>

      {/* Which account: the line's colour and its total for the window. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {geometry.lines.map((line) => (
          <View key={line.id} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 7, height: 2, borderRadius: 1, backgroundColor: line.color }} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
              {line.label} · {usd(line.total)}
            </Text>
          </View>
        ))}
        {geometry.average > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View
              style={{
                width: 9,
                borderTopWidth: 1,
                borderTopColor: theme.colors.foregroundMuted,
                borderStyle: "dashed" as const,
                opacity: 0.6,
              }}
            />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              avg {usd(geometry.average)}/day
            </Text>
          </View>
        ) : null}
      </View>

      {models.length > 0 ? (
        <View style={{ gap: 3, paddingTop: 6, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, letterSpacing: 0.4 }}>
            MODELS · {usd(modelCost)} OVER 30 DAYS
          </Text>
          {models.slice(0, 6).map((model) => (
            <View key={model.model} style={{ gap: 2 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 10, flexShrink: 1 }} numberOfLines={1}>
                  {model.model}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                  {usd(model.cost)} · {model.turns} turns
                </Text>
              </View>
              <View
                style={{
                  height: 2,
                  borderRadius: 1,
                  width: `${Math.min((model.cost / Math.max(modelCost, 1e-9)) * 100, 100)}%`,
                  backgroundColor: theme.colors.accent,
                }}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
