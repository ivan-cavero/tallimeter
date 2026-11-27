/**
 * A spend projection chart, drawn as a line rather than columns.
 *
 * Why a line: the question is "when do I run out", and a line answers it with a slope. Columns
 * answer "how much on which day", which is a different question and much harder to read at 40px.
 *
 * What it draws, all in view coordinates and with no chart library:
 *
 *   1. the budget ceiling, as a dashed reference line, when a budget exists
 *   2. actual spend so far, as a solid line to "today"
 *   3. projected spend to the end of the cycle, as a dotted line continuing the same slope
 *   4. the crossing point, when that projection reaches the ceiling, marked with a dot and
 *   5. the reset, as a vertical marker at the cycle end
 *
 * It is pure `View` geometry so it renders identically on desktop, web and phones.
 */
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";

type Theme = PluginScreenProps["theme"];

export interface ProjectionPoint {
  /** Milliseconds at which this reading was taken. */
  at: number;
  /** Cumulative spend in USD at that instant. */
  spent: number;
}

export interface ProjectionProps {
  theme: Theme;
  points: ProjectionPoint[];
  /** Cycle start and end, in milliseconds. */
  periodStart: number;
  periodEnd: number;
  /** Budget for the cycle, when the user set one. */
  budgetUsd: number | null;
  /** Current spend, used to keep the projection honest when the points are sparse. */
  spentUsd: number;
  /** Projected total at the cycle end. */
  projectedUsd: number;
  /**
   * Spend per day that would use the budget evenly to the cycle end. Drawn as a dashed reference
   * so the user can see, without arithmetic, whether today is on track or over.
   */
  recommendedPerDayUsd?: number | null;
  width?: number;
  height?: number;
}

const usd = (value: number) => (value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`);

export function ProjectionChart({
  theme,
  points,
  periodStart,
  periodEnd,
  budgetUsd,
  spentUsd,
  projectedUsd,
  recommendedPerDayUsd,
  width: fixedWidth,
  height = 92,
}: ProjectionProps) {
  const [measured, setMeasured] = useState<number | null>(null);
  const width = fixedWidth ?? measured ?? 0;

  const geometry = useMemo(() => {
    const span = Math.max(periodEnd - periodStart, 1);
    const now = Date.now();
    const todayX = Math.min(Math.max((now - periodStart) / span, 0), 1);

    // The value axis is the budget when there is one, otherwise the larger of spend or
    // projection, so the line always has a meaningful top.
    const top = Math.max(budgetUsd ?? 0, spentUsd, projectedUsd, 0.01);
    const toXY = (fraction: number, value: number) => ({
      x: Math.min(Math.max(fraction, 0), 1) * width,
      y: height - Math.min(value / top, 1) * height,
    });

    const actual = points
      .filter((point) => point.at <= now)
      .map((point) => toXY((point.at - periodStart) / span, point.spent));

    // Always end the actual line at today, using the freshest number available.
    const today = toXY(todayX, spentUsd);
    if (actual.length === 0 || actual[actual.length - 1]!.x < today.x - 1) actual.push(today);

    const end = toXY(1, projectedUsd);

    // The recommended pace: the straight line from the cycle start to (end, budget). Spending on
    // it uses the budget exactly by the reset, which is the answer to "how much per day".
    const evenPace =
      recommendedPerDayUsd !== null && recommendedPerDayUsd !== undefined && budgetUsd !== null
        ? [toXY(0, 0), toXY(1, budgetUsd)]
        : null;

    // When the projection meets the ceiling: interpolate against the ceiling line.
    let crossing: { x: number; y: number } | null = null;
    if (budgetUsd !== null && budgetUsd > 0 && spentUsd < budgetUsd && projectedUsd > budgetUsd) {
      const fraction = (budgetUsd - spentUsd) / Math.max(projectedUsd - spentUsd, 1e-9);
      crossing = toXY(todayX + fraction * (1 - todayX), budgetUsd);
    }

    const ceiling = budgetUsd !== null && budgetUsd > 0 ? height - Math.min(budgetUsd / top, 1) * height : null;

    // A polyline is one thin View per segment, placed at the segment's midpoint and rotated
    // around its own centre: no `transformOrigin`, so it renders the same everywhere.
    const segments = (path: Array<{ x: number; y: number }>) =>
      path.slice(1).map((point, index) => {
        const from = path[index]!;
        const dx = point.x - from.x;
        const dy = point.y - from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        return {
          left: (from.x + point.x) / 2 - length / 2,
          top: (from.y + point.y) / 2,
          width: Math.max(length, 1),
          angle,
          // The dash phase needs the slope's sign, not just its angle.
          rise: dy / Math.max(Math.abs(dx), 1e-9),
        };
      });

    if (width <= 0)
      return {
        actualSegments: [],
        projectedSegments: [],
        evenPaceSegments: [],
        crossing: null,
        ceiling: null,
        todayX: 0,
        endX: 0,
        top: 0,
      };

    return {
      actualSegments: segments(actual),
      projectedSegments: segments([today, end]),
      crossing,
      ceiling,
      evenPaceSegments: evenPace ? segments(evenPace) : [],
      todayX: today.x,
      endX: width,
      top,
    };
    // `points` is rebuilt on every card render, so keying on it would rebuild this geometry every
    // frame. The last point and the current spend are what the geometry actually reads.
  }, [
    points.length,
    points.at(-1)?.at,
    points.at(-1)?.spent,
    periodStart,
    periodEnd,
    budgetUsd,
    spentUsd,
    projectedUsd,
    recommendedPerDayUsd,
    width,
    height,
  ]);

  const cycleLabel = new Date(periodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const crossing = geometry.crossing;
  const crossingLabel =
    crossing !== null && width > 0
      ? new Date(periodStart + (crossing.x / width) * (periodEnd - periodStart)).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : null;

  return (
    <View
      style={{ gap: 6 }}
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.width);
        if (next > 0 && next !== measured) setMeasured(next);
      }}
    >
      <View style={{ width, height, backgroundColor: theme.colors.surface0, borderRadius: 8, overflow: "hidden" }}>
        {/* The budget ceiling: a dashed reference, so it never reads as data. */}
        {geometry.ceiling !== null ? (
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: geometry.ceiling,
              height: 1,
              backgroundColor: theme.colors.foregroundMuted,
              opacity: 0.45,
            }}
          />
        ) : null}

        {/* The recommended pace, drawn under the data and always grey: a reference, not a metric. */}
        {geometry.evenPaceSegments.map((segment, index) => {
          const count = Math.max(Math.floor(segment.width / 9), 1);
          const step = segment.width / count;
          return Array.from({ length: count }, (_, dash) => (
            <View
              key={`e${index}-${dash}`}
              style={{
                position: "absolute",
                left: segment.left + dash * step,
                top: segment.top + segment.rise * (dash * step - segment.width / 2),
                width: 4,
                height: 1,
                borderRadius: 0.5,
                backgroundColor: theme.colors.foregroundMuted,
                opacity: 0.55,
                transform: [{ rotate: `${segment.angle}rad` }],
              }}
            />
          ));
        })}

        {/* Actual spend, solid. */}
        {geometry.actualSegments.map((segment, index) => (
          <View
            key={`a${index}`}
            style={{
              position: "absolute",
              left: segment.left,
              top: segment.top,
              width: segment.width,
              height: 2,
              borderRadius: 1,
              backgroundColor: theme.colors.accent,
              transform: [{ rotate: `${segment.angle}rad` }],
            }}
          />
        ))}

        {/* Projection, dotted by drawing short dashes along the same slope. */}
        {geometry.projectedSegments.flatMap((segment, index) => {
          // Walk the segment from its left end, since the midpoint sits in the middle.
          const count = Math.max(Math.floor(segment.width / 8), 1);
          const step = segment.width / count;
          return Array.from({ length: count }, (_, dash) => (
            <View
              key={`p${index}-${dash}`}
              style={{
                position: "absolute",
                left: segment.left + dash * step,
                top: segment.top + segment.rise * (dash * step - segment.width / 2),
                width: 5,
                height: 2,
                borderRadius: 1,
                backgroundColor: theme.colors.statusWarning,
                transform: [{ rotate: `${segment.angle}rad` }],
              }}
            />
          ));
        })}

        {/* Today. */}
        <View
          style={{
            position: "absolute",
            left: geometry.todayX - 1,
            top: 0,
            bottom: 0,
            width: 1,
            backgroundColor: theme.colors.foregroundMuted,
            opacity: 0.5,
          }}
        />

        {/* Where the projection meets the ceiling. */}
        {geometry.crossing !== null ? (
          <View
            style={{
              position: "absolute",
              left: geometry.crossing.x - 3.5,
              top: geometry.crossing.y - 3.5,
              width: 7,
              height: 7,
              borderRadius: 3.5,
              backgroundColor: theme.colors.statusDanger,
              borderWidth: 1,
              borderColor: theme.colors.surface0,
            }}
          />
        ) : null}

        {/* The reset. */}
        <View
          style={{
            position: "absolute",
            left: geometry.endX - 1,
            top: 0,
            bottom: 0,
            width: 2,
            backgroundColor: theme.colors.statusSuccess,
            opacity: 0.8,
          }}
        />
      </View>

      {/* A legend in words, because a two-colour line needs one. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Legend theme={theme} color={theme.colors.accent} label="spent" />
        <Legend theme={theme} color={theme.colors.statusWarning} label="projected" />
        {budgetUsd !== null ? <Legend theme={theme} color={theme.colors.foregroundMuted} label="budget" /> : null}
        {recommendedPerDayUsd !== null && recommendedPerDayUsd !== undefined ? (
          <Legend theme={theme} color={theme.colors.foregroundMuted} label={`recommended ${usd(recommendedPerDayUsd)}/day`} />
        ) : null}
        {crossingLabel ? (
          <Legend theme={theme} color={theme.colors.statusDanger} label={`hits budget ${crossingLabel}`} />
        ) : null}
        <Legend theme={theme} color={theme.colors.statusSuccess} label={`resets ${cycleLabel}`} />
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          today {usd(spentUsd)}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          projected {usd(projectedUsd)}
          {budgetUsd !== null ? ` of ${usd(budgetUsd)}` : ""}
        </Text>
      </View>
    </View>
  );
}

function Legend({ theme, color, label }: { theme: Theme; color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 8, height: 2, borderRadius: 1, backgroundColor: color }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{label}</Text>
    </View>
  );
}
