import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  Icon,
  Loading,
  SettingsAction,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { AccountStat, QuotaWindow, ProviderBrand } from "../shared/contracts";
import { ProjectionChart } from "./projection-chart";
import { TrendPanel } from "./trend-panel";
import {
  accountRpc,
  brandsRpc,
  credentialsRpc,
  snapshotRpc,
  usageSettings,
  type UsageSettings,
} from "../shared/contracts";

/* -------------------------------- formatting ------------------------------ */

const usd = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
};

const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
};

const pct = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${Math.round(value)}%`;

const countdown = (iso: string | null): string => {
  if (!iso) return "no reset reported";
  const delta = Math.max(Date.parse(iso) - Date.now(), 0);
  if (delta === 0) return "now";
  const days = Math.floor(delta / 86_400_000);
  const hours = Math.floor((delta % 86_400_000) / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

/**
 * Draws a brand mark. A monochrome glyph is painted white on its tile; a multi-colour mark (Pi,
 * OpenDesign, OpenCode) carries its own fills and only needs the size. The SVG is self-contained
 * geometry, so nothing here depends on the theme.
 */
function BrandMark({
  mark,
  size,
  color,
  mono,
}: {
  mark: string;
  size: number;
  color: string;
  mono: boolean;
}) {
  return <Icon icon={{ svg: mark }} size={size} color={mono ? color : undefined} />;
}

type Theme = PluginScreenProps["theme"];
type Layout = PluginScreenProps["layout"];

/** A window's colour follows the share consumed, not the vendor, so limits read the same. */
const toneFor = (theme: Theme, used: number): string =>
  used >= 90 ? theme.colors.statusDanger : used >= 70 ? theme.colors.statusWarning : theme.colors.statusSuccess;

/**
 * A meter with three touch points: a plain track, a glossed fill, and a tick marking where usage
 * "should" be if it were spread evenly across a period. Without the tick a full-looking bar says
 * nothing about whether you are ahead or behind, which is the question these meters exist for.
 */
function Meter({
  theme,
  used,
  color,
  height = 8,
  evenAt,
  paceDots = [],
}: {
  theme: Theme;
  used: number;
  color: string;
  height?: number;
  /** Percentage of the window that has already elapsed, drawn as a tick. */
  evenAt?: number | null;
  /**
   * Fractions (0..1) marking where an even pace should have reached by each day of the window.
   * Several small dots beat one tick when the question is "how much per day".
   */
  paceDots?: number[];
}) {
  const ratio = Math.min(Math.max(used / 100, 0), 1);
  const tick = evenAt === null || evenAt === undefined ? null : Math.min(Math.max(evenAt / 100, 0), 1);

  return (
    <View style={{ gap: 3 }}>
      <View
        style={{
          height,
          borderRadius: height / 2,
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            backgroundColor: color,
            borderRadius: height / 2,
            minWidth: ratio > 0 ? height : 0,
          }}
        >
          {/* A gloss strip: the bar picks up light like a real gauge instead of a flat block. */}
          <View
            style={{
              position: "absolute",
              left: 1,
              right: 1,
              top: 1,
              height: Math.max(Math.round(height * 0.45), 2),
              borderRadius: height / 2,
              backgroundColor: "#FFFFFF",
              opacity: 0.22,
            }}
          />
        </View>
        {paceDots.map((fraction, index) => (
          <View
            key={`dot${index}`}
            style={{
              position: "absolute",
              left: `${Math.min(Math.max(fraction, 0), 1) * 100}%`,
              top: Math.max((height - 5) / 2, 0),
              width: 5,
              height: 5,
              borderRadius: 2.5,
              marginLeft: -2.5,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: theme.colors.foregroundMuted,
            }}
          />
        ))}
        {tick !== null ? (
          <View
            style={{
              position: "absolute",
              left: `${tick * 100}%`,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: theme.colors.foreground,
              opacity: 0.5,
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

/** How much of a window has elapsed, from its reset time and its length. */
function elapsedPct(quotaWindow: QuotaWindow): number | null {
  if (!quotaWindow.resetsAt || !quotaWindow.durationSeconds) return null;
  const resetsAt = Date.parse(quotaWindow.resetsAt);
  if (!Number.isFinite(resetsAt)) return null;
  const leftMs = Math.max(resetsAt - Date.now(), 0);
  const leftPct = (leftMs / (quotaWindow.durationSeconds * 1000)) * 100;
  return Math.max(0, Math.min(100 - leftPct, 100));
}

/** Cumulative spend at each day, so a card can draw its own projection. */
function cumulative(account: AccountStat): Array<{ at: number; spent: number }> {
  let running = 0;
  return account.daily.map((day) => {
    running += day.cost;
    return { at: Date.parse(`${day.date}T12:00:00Z`), spent: running };
  });
}

/* --------------------------------- the card -------------------------------- */

/**
 * One quota window, on one line where space is tight.
 *
 * The label carries the window length, the number is the share used, and the note underneath says
 * how much is left and when it comes back. There is no "561t" anywhere: a number whose unit is not
 * spelled out is the thing this card was failing at.
 */
/**
 * One quota window, with a recommended pace.
 *
 * Windows report a percentage used and a reset time, never an absolute limit, so the only honest
 * pace is in points per day: "keep it under 18 pts a day and it lasts to the reset". That number is
 * what the user actually needs, and it needs no arithmetic on their side.
 */
function QuotaLine({ theme, quotaWindow }: { theme: Theme; quotaWindow: QuotaWindow }) {
  const used = quotaWindow.usedPct;
  const color = toneFor(theme, used);
  const elapsed = elapsedPct(quotaWindow);
  const daysLeft = quotaWindow.resetsAt
    ? Math.max((Date.parse(quotaWindow.resetsAt) - Date.now()) / 86_400_000, 0)
    : null;

  // Points per day that would consume exactly the remainder by the reset.
  const recommendedPerDay = daysLeft !== null && daysLeft > 0.05 ? (100 - used) / daysLeft : null;
  const windowDays =
    quotaWindow.durationSeconds !== undefined ? quotaWindow.durationSeconds / 86_400 : null;

  // Pace is only meaningful on a window of a day or more; a five-hour window is too short.
  const showPace = recommendedPerDay !== null && windowDays !== null && windowDays >= 0.9;

  // One dot per day of the window: where an even spend of the whole allowance would sit.
  const paceDots = showPace && windowDays !== null
    ? Array.from({ length: Math.max(Math.floor(windowDays) - 1, 0) }, (_, index) => (index + 1) / windowDays)
    : [];

  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
          {quotaWindow.label}
        </Text>
        <Text style={{ color, fontSize: 12, fontWeight: "700" as const }}>
          {pct(used)} used{showPace ? "" : ` · ${pct(100 - used)} left`}
        </Text>
      </View>
      <Meter theme={theme} used={used} color={color} height={7} evenAt={showPace ? null : elapsed} paceDots={paceDots} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
          {showPace
            ? `${pct(recommendedPerDay)}/day keeps it to the reset`
            : `${pct(100 - used)} left`}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
          resets in {countdown(quotaWindow.resetsAt)}
        </Text>
      </View>
    </View>
  );
}

function AccountCard({
  theme,
  layout,
  account,
  expanded,
  onToggle,
  cardWidth,
  selfTotal,
}: {
  theme: Theme;
  layout: Layout;
  account: AccountStat;
  expanded: boolean;
  onToggle: () => void;
  /** Card width in dp; computed from the measured row so the grid reflows on resize. */
  cardWidth: number;
  /** Total spend of every card, for the "share of the cycle" figure. */
  selfTotal: number;
}) {
  const brand = account.brand;
  const empty = account.totals.turns === 0 && !account.quota;
  const tokens = account.totals.input + account.totals.output;


  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${brand.label}, ${usd(account.totals.cost)} spent this cycle`}
      onPress={onToggle}
      style={{
        width: cardWidth,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: expanded ? `${brand.color}66` : theme.colors.border,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden",
      }}
    >
      <View
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, backgroundColor: brand.color }}
      />
      <View style={{ padding: layout.compact ? 9 : 11, paddingLeft: (layout.compact ? 9 : 11) + 3, gap: 7 }}>
        {/* Header: mark, name, spend. One line, so five cards fit where two did. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <View
            style={{
              width: 22,
              height: 22,
              // A bleed mark draws its own rounded tile, so its radius must not be clipped again
              // by a different one: that mismatch is what showed up as a pale border.
              borderRadius: brand.bleed ? 0 : 6,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: brand.bleed ? "transparent" : brand.tile ?? brand.color,
            }}
          >
            {brand.mark ? (
              <BrandMark
                mark={brand.mark}
                size={brand.bleed ? 22 : 15}
                color="#FFFFFF"
                mono={brand.mono && !brand.bleed}
              />
            ) : (
              <Icon name={brand.icon} size={13} color="#FFFFFF" />
            )}
          </View>
          <Text
            style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 }}
            numberOfLines={1}
          >
            {account.label}
          </Text>
          <View style={{ flex: 1 }} />
          {empty ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>no spend</Text>
          ) : (
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const }}>
              {usd(account.totals.cost)}
            </Text>
          )}
        </View>

        {/* The plainest possible summary: what it cost, how much of it, and how efficient. */}
        {empty ? null : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={1}>
            {account.totals.turns} turns · {compact(tokens)} tokens
            {account.cacheHitPct !== null ? ` · ${pct(account.cacheHitPct)} cached` : ""}
          </Text>
        )}

        {account.quota?.windows.length ? (
          <View style={{ gap: 6 }}>
            {account.quota.windows.slice(0, 3).map((quotaWindow) => (
              <QuotaLine key={quotaWindow.id} theme={theme} quotaWindow={quotaWindow} />
            ))}
          </View>
        ) : null}

        {account.quota?.balanceUsd !== null && account.quota ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {account.quota.source === "opendesign" ? "Wallet balance" : "Credit balance"}{" "}
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" as const }}>
              {usd(account.quota.balanceUsd)}
            </Text>
            {account.quota.note ? ` · ${account.quota.note}` : ""}
          </Text>
        ) : null}

        {/* The facts that used to need a hover, always shown. Compact chips, one row. */}
        {empty ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            <Fact theme={theme} label="share" value={`${Math.round((account.totals.cost / Math.max(selfTotal, 1e-9)) * 100)}% of cycle`} />
            <Fact theme={theme} label="actual" value={`${usd(account.costPerDay)}/day`} />
            {account.budgetUsd && account.daysLeft > 0.05 ? (
              <Fact
                theme={theme}
                label="recommended"
                value={`${usd((account.budgetUsd - account.totals.cost) / account.daysLeft)}/day`}
              />
            ) : null}
            <Fact theme={theme} label="cycle" value={countdown(account.periodEnd)} />
          </View>
        )}

        {empty ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }} numberOfLines={2}>
            {brand.quotaHint}
          </Text>
        ) : null}

        {expanded && !empty ? (
          <View style={{ gap: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
            {/* The chart answers "when do I run out", which is the question a spend number implies. */}
            <ProjectionChart
              theme={theme}
              points={cumulative(account)}
              periodStart={Date.parse(account.periodStart)}
              periodEnd={Date.parse(account.periodEnd)}
              budgetUsd={account.budgetUsd}
              spentUsd={account.totals.cost}
              projectedUsd={account.projectedUsd ?? account.totals.cost}
              recommendedPerDayUsd={
                account.budgetUsd && account.daysLeft > 0.05
                  ? (account.budgetUsd - account.totals.cost) / account.daysLeft
                  : account.budgetUsd && account.daysLeft <= 0.05
                    ? account.budgetUsd
                    : null
              }
              height={84}
            />

            {/* The figures the chips cannot carry: throughput, and days of work when a rate is set. */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {account.tokensPerHour !== null ? (
                <Fact theme={theme} label="Tokens per hour" value={compact(account.tokensPerHour)} />
              ) : null}
              {account.workdaysSpent !== null ? (
                <Fact theme={theme} label="Days of work" value={account.workdaysSpent.toFixed(1)} />
              ) : null}
            </View>

            {/* Per model, with the unit written out and the share of the card's spend drawn. */}
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.4 }}>
                BY MODEL
              </Text>
              {account.byModel.slice(0, 4).map((model) => (
                <View key={model.model} style={{ gap: 2 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 11, flexShrink: 1 }} numberOfLines={1}>
                      {model.model}
                    </Text>
                    <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
                      {usd(model.cost)} · {model.turns} turns
                    </Text>
                  </View>
                  <Meter
                    theme={theme}
                    height={3}
                    used={(model.cost / Math.max(account.totals.cost, 1e-9)) * 100}
                    color={brand.color}
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * A figure with its label. The number is the loud part and the label is quiet, which is what makes
 * a row of three readable without punctuation doing the work.
 */
function Stat({ theme, label, value, tone }: { theme: Theme; label: string; value: string; tone: string }) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: 5,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        gap: 1,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.3 }}>
        {label.toUpperCase()}
      </Text>
      <Text style={{ color: tone, fontSize: 13, fontWeight: "600" as const }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** One labelled number, sized like a chip so several fit on a line. */
function Fact({ theme, label, value }: { theme: Theme; label: string; value: string }) {
  return (
    <View
      style={{
        paddingVertical: 4,
        paddingHorizontal: 7,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        gap: 1,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" as const }}>{value}</Text>
    </View>
  );
}

/* --------------------------------- the screen ------------------------------ */

export function UsageScreen({ theme, layout, host }: PluginScreenProps) {
  const snapshot = useRpc(snapshotRpc);
  const [refreshQuota, setRefreshQuota] = useState(true);
  // A Set, so more than one card can be open. Each stays in its column.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rowWidth, setRowWidth] = useState(0);

  const query = useQuery({
    queryKey: ["usage", "snapshot", refreshQuota, host.id],
    queryFn: () => snapshot({ refreshQuota }),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 14 : 20, gap: layout.compact ? 12 : 16 },
      label: { color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.6 },
      total: { color: theme.colors.foreground, fontSize: layout.compact ? 26 : 32, fontWeight: "600" as const },
      sub: { color: theme.colors.foregroundMuted, fontSize: 12 },
      action: {
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      actionText: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, layout.compact],
  );

  // Two columns on a normal window, three when there is room. Each card needs ~300dp to stay
  // readable, so the count is a floor of what fits, capped at three.
  const gap = layout.compact ? 8 : 12;
  const columns = layout.compact ? 1 : Math.min(Math.max(Math.floor((rowWidth + gap) / (300 + gap)), 1), 3);
  const columnWidth = columns > 1 ? (rowWidth - gap * (columns - 1)) / columns : rowWidth;

  if (query.isPending) {
    return (
      <View style={styles.screen}>
        <Loading />
      </View>
    );
  }

  if (query.isError) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          {query.error instanceof Error ? query.error.message : "Could not read usage"}
        </Text>
      </View>
    );
  }

  const data = query.data;

  // The trend panel needs one array per account, aligned to the same dates.
  const trendSeries = data.accounts
    .filter((account) => account.totals.turns > 0)
    .map((account) => ({
      id: account.id,
      label: account.label,
      color: account.brand.color,
      daily: data.history.map((day) => day.byAccount.find((entry) => entry.id === account.id)?.cost ?? 0),
    }))
    .filter((account) => account.daily.some((value) => value > 0));

  const trendModels = new Map<string, { model: string; cost: number; turns: number }>();
  for (const day of data.history) {
    for (const model of day.models) {
      const entry = trendModels.get(model.model) ?? { model: model.model, cost: 0, turns: 0 };
      entry.cost += model.cost;
      entry.turns += model.turns;
      trendModels.set(model.model, entry);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View
        style={{
          padding: layout.compact ? 12 : 14,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
          <View style={{ gap: 1 }}>
            <Text style={styles.label}>SPENT THIS CYCLE</Text>
            <Text style={styles.total}>{usd(data.totals.cost)}</Text>
          </View>
          <View style={{ alignItems: "flex-end", gap: 1 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {data.totals.turns} turns · {data.accounts.length} accounts
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
              updated {new Date(data.generatedAt).toLocaleTimeString()}
            </Text>
          </View>
        </View>
        {/* Three figures with their labels, rather than one line of numbers to parse. */}
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Stat theme={theme} label="input" value={compact(data.totals.input)} tone={theme.colors.foregroundMuted} />
          <Stat theme={theme} label="output" value={compact(data.totals.output)} tone={theme.colors.foregroundMuted} />
          <Stat theme={theme} label="cache read" value={compact(data.totals.cacheRead)} tone={theme.colors.statusSuccess} />
        </View>
      </View>

      {data.history.length > 0 ? (
        <TrendPanel
          theme={theme}
          dates={data.history.map((day) => day.date)}
          series={trendSeries}
          models={[...trendModels.values()].sort((a, b) => b.cost - a.cost)}
        />
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={styles.label}>ACCOUNTS</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Re-read quotas"
          onPress={() => setRefreshQuota((value) => !value)}
          style={styles.action}
        >
          <Text style={styles.actionText}>Re-read quotas</Text>
        </Pressable>
      </View>

      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap, width: "100%", alignItems: "flex-start" }}
        onLayout={(event) => {
          const next = Math.round(event.nativeEvent.layout.width);
          if (next > 0 && next !== rowWidth) setRowWidth(next);
        }}
      >
      {data.accounts.flatMap((account) => [
          <AccountCard
            key={account.id}
            theme={theme}
            layout={layout}
            account={account}
            expanded={expanded.has(account.id)}
            onToggle={() =>
              setExpanded((current) => {
                const next = new Set(current);
                if (next.has(account.id)) next.delete(account.id);
                else next.add(account.id);
                return next;
              })
            }
            cardWidth={columnWidth}
            selfTotal={data.totals.cost}
          />,
        ])}
      </View>

      {data.warnings.map((warning) => (
        <Text key={warning} style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
          {warning}
        </Text>
      ))}
    </ScrollView>
  );
}

/* ------------------------------- settings --------------------------------- */

const FAMILIES = [
  { label: "Claude", value: "claude" },
  { label: "OpenCode Go", value: "opencode" },
  { label: "OpenDesign", value: "opendesign" },
  { label: "Pi", value: "pi" },
] as const;

type Family = (typeof FAMILIES)[number]["value"];

function AccountsSection({ theme }: { theme: Theme }) {
  const accounts = useRpc(accountRpc);
  const queryClient = useQueryClient();
  const [family, setFamily] = useState<Family>("claude");
  /** Draft for the "add account" label. */
  const [label, setLabel] = useState("");
  /** Draft for a rename, kept apart so the two fields never share a value. */
  const [renameDraft, setRenameDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  // Renaming is an inline field, one account at a time: a per-row input would put a keyboard in
  // every row of a long list.
  const [renaming, setRenaming] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["usage", "accounts"], queryFn: () => accounts({ action: "list" }) });

  const run = async (action: "add" | "remove" | "rename", payload: Record<string, unknown>) => {
    try {
      const result = await accounts({ action, ...payload } as never);
      setStatus(result.message);
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SettingsSection
      title="Accounts"
      info="Each account is a provider entry with its own login directory. Its spend appears on the Usage screen."
    >
      {(list.data?.accounts ?? []).map((entry) => (
        <SettingsRow
          key={entry.id}
          label={entry.label}
          hint={`${entry.id} · ${entry.extends} · ${entry.hasKey ? "key set" : "no key"}`}
        >
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={renaming === entry.id ? `Cancel renaming ${entry.label}` : `Rename ${entry.label}`}
              onPress={() => {
                // Seed the field with the current name, so opening the editor and pressing save
                // without typing keeps the name instead of failing on an empty draft.
                setRenameDraft(entry.label);
                setRenaming(renaming === entry.id ? null : entry.id);
              }}
              style={{ paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {renaming === entry.id ? "Cancel" : "Rename"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${entry.label}`}
              onPress={() => void run("remove", { id: entry.id })}
              style={{ paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
            >
              <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>Remove</Text>
            </Pressable>
          </View>
        </SettingsRow>
      ))}

      {renaming ? (
        <SettingsInput
          // Keyed by id so switching the edited account remounts the field with its own value.
          key={`rename-${renaming}`}
          label="New name"
          hint="Shown in Paseo's provider picker and on the Usage card."
          initialValue={(list.data?.accounts ?? []).find((entry) => entry.id === renaming)?.label ?? ""}
          placeholder="Account name"
          // The button below commits; typing only tracks the draft, because saving on every
          // keystroke would rewrite Paseo's config once per character.
          onChangeText={setRenameDraft}
        />
      ) : null}
      {renaming ? (
        <SettingsAction
          label={`Rename ${renaming}`}
          actionLabel="Save name"
          onPress={() => {
            const trimmed = renameDraft.trim();
            if (!trimmed) return;
            void run("rename", { id: renaming, label: trimmed });
            setRenaming(null);
            setRenameDraft("");
          }}
        />
      ) : null}

      <SettingsRow label="New account type" hint="Which provider the new entry extends, and so which login it uses.">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
          {FAMILIES.map((option) => {
            const active = option.value === family;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityLabel={`Create a ${option.label} account`}
                onPress={() => setFamily(option.value)}
                style={{
                  paddingVertical: 4,
                  paddingHorizontal: 9,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : theme.colors.border,
                  backgroundColor: active ? `${theme.colors.accent}22` : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontWeight: active ? ("600" as const) : ("400" as const),
                  }}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SettingsRow>
      <SettingsInput
        label="Label"
        hint="Optional. Shown in the provider picker and on the Usage card."
        initialValue=""
        placeholder={family === "claude" ? "Claude work" : "Account name"}
        onChangeText={setLabel}
      />
      <SettingsAction
        label="Add account"
        actionLabel="Add"
        onPress={() => {
          void run("add", { family, label, apiKey: "", controlKey: "", workspaceId: "" });
          setLabel("");
        }}
      />
      {status ? <SettingsRow label="Last action" hint={status} /> : null}
    </SettingsSection>
  );
}

/** Credentials: one row per stored entry, with the vendor colour and no value ever shown. */
function CredentialsSection({ theme, brands }: { theme: Theme; brands: ProviderBrand[] }) {
  const credentials = useRpc(credentialsRpc);
  const queryClient = useQueryClient();
  const [vendor, setVendor] = useState(brands[0]?.id ?? "opendesign");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["usage", "credentials"], queryFn: () => credentials({ action: "list" }) });
  const brand = brands.find((candidate) => candidate.id === vendor) ?? brands[0];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  const call = async (input: Parameters<typeof credentials>[0]) => {
    try {
      const result = await credentials(input);
      setStatus(result.message);
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SettingsSection
      title="Credentials"
      info="Stored on this machine in a file only you can read, and never shown again after saving. Copy that file to another machine to move them."
    >
      {(list.data?.credentials ?? []).map((entry) => (
        <SettingsRow
          key={entry.id}
          label={entry.label ? `${entry.label} · ${entry.id}` : entry.id}
          hint={`${entry.kind ?? "credential"} ${entry.preview}${entry.workspaceId ? ` · ${entry.workspaceId}` : ""}`}
        >
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Verify ${entry.id}`}
              onPress={() => void call({ action: "verify", id: entry.id })}
              style={{ paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Verify</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${entry.id}`}
              onPress={() => void call({ action: "remove", id: entry.id })}
              style={{ paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
            >
              <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>Remove</Text>
            </Pressable>
          </View>
        </SettingsRow>
      ))}

      <SettingsRow label="Vendor" hint={brand?.quotaHint ?? ""}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
          {brands.map((candidate) => {
            const active = candidate.id === vendor;
            return (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                accessibilityLabel={`Select ${candidate.label} as the vendor`}
                onPress={() => setVendor(candidate.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingVertical: 4,
                  paddingHorizontal: 8,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? candidate.color : theme.colors.border,
                  backgroundColor: active ? `${candidate.color}22` : theme.colors.surface2,
                }}
              >
                {candidate.mark ? (
                  <View
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: candidate.bleed ? "transparent" : candidate.tile ?? candidate.color,
                      borderWidth: candidate.bleed ? 0 : 1,
                      borderColor: theme.colors.border,
                    }}
                  >
                    <BrandMark
                      mark={candidate.mark}
                      size={candidate.bleed ? 16 : 11}
                      color="#FFFFFF"
                      mono={candidate.mono && !candidate.bleed}
                    />
                  </View>
                ) : null}
                <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 11 }}>
                  {candidate.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SettingsRow>
      <SettingsInput
        label="Name"
        hint="Use the account the credential belongs to, for example personal or work."
        initialValue=""
        placeholder="personal"
        onChangeText={setName}
      />
      <SettingsInput
        label="Credential"
        hint="An API key, a session cookie, or a control key. It is written once and never displayed again."
        initialValue=""
        placeholder="paste here"
        secureTextEntry
        onChangeText={setValue}
      />
      <SettingsAction
        label="Save credential"
        actionLabel="Save"
        onPress={() => {
          const id = `${vendor}:${(name || "default").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
          void call({ action: "set", id, value, label: name || undefined, kind: "apiKey" });
          setName("");
          setValue("");
        }}
      />

      {vendor === "opendesign" ? (
        <SettingsAction
          label="Read OpenDesign session from my browser"
          actionLabel="Read"
          onPress={() => void call({ action: "import-browser", planId: (name || "default").trim().toLowerCase() })}
        />
      ) : null}

      {status ? <SettingsRow label="Last action" hint={status} /> : null}
    </SettingsSection>
  );
}

/**
 * A monthly budget per account. The key is the provider id, which is what every non-merged card
 * uses, so a budget set here applies to that account's card whichever harness spends on it.
 */
function BudgetsSection({
  theme,
  values,
  update,
}: {
  theme: Theme;
  values: UsageSettings;
  update: (patch: Partial<UsageSettings>) => void;
}) {
  const accounts = useRpc(accountRpc);
  const list = useQuery({ queryKey: ["usage", "accounts"], queryFn: () => accounts({ action: "list" }) });
  const entries = list.data?.accounts ?? [];

  const setBudget = (accountId: string, raw: string) => {
    const parsed = Number(raw);
    const next = { ...values.accounts };
    if (raw.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) delete next[accountId];
    else next[accountId] = { ...(next[accountId] ?? {}), budgetUsd: parsed };
    update({ accounts: next });
  };

  return (
    <SettingsSection
      title="Budgets"
      info="Optional. A monthly budget per account adds a percentage and a projection to its card. Leave a field empty for no budget."
    >
      {entries.length === 0 ? (
        <SettingsRow label="No accounts" hint="Add an account above, or configure one in Paseo's provider list." />
      ) : null}
      {entries.map((entry) => (
        <SettingsInput
          key={`budget-${entry.id}`}
          label={entry.label}
          hint={`USD per cycle · ${entry.id}`}
          initialValue={values.accounts[entry.id]?.budgetUsd ? String(values.accounts[entry.id]?.budgetUsd) : ""}
          placeholder="no budget"
          onChangeText={(next) => setBudget(entry.id, next)}
        />
      ))}
    </SettingsSection>
  );
}

function CycleSection({ theme, values, update }: { theme: Theme; values: UsageSettings; update: (patch: Partial<UsageSettings>) => void }) {
  return (
    <SettingsSection title="Cycle" info="When a billing period starts, and how a workday is priced.">
      <SettingsInput
        label="Cycle start day"
        hint="1 to 28. A billing period begins on this day each month."
        initialValue={String(values.defaultCycleStartDay)}
        placeholder="1"
        onChangeText={(next) => {
          const parsed = Number(next);
          if (Number.isFinite(parsed)) update({ defaultCycleStartDay: Math.min(Math.max(parsed, 1), 28) });
        }}
      />
      <SettingsInput
        label="Hours per workday"
        hint="Used with the hourly rate to turn spend into days of work."
        initialValue={String(values.hoursPerWorkday)}
        placeholder="8"
        onChangeText={(next) => {
          const parsed = Number(next);
          if (Number.isFinite(parsed)) update({ hoursPerWorkday: Math.min(Math.max(parsed, 1), 24) });
        }}
      />
      <SettingsInput
        label="Hourly rate"
        hint="USD. Without a rate, days of work stay hidden rather than invented."
        initialValue={values.hourlyRateUsd ? String(values.hourlyRateUsd) : ""}
        placeholder="0"
        onChangeText={(next) => {
          const parsed = Number(next);
          if (Number.isFinite(parsed)) update({ hourlyRateUsd: Math.max(parsed, 0) });
        }}
      />
    </SettingsSection>
  );
}

export function UsageSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(usageSettings);
  const brands = useRpc(brandsRpc);
  const [draft, setDraft] = useState<UsageSettings | null>(null);
  const values = draft ?? (settings.status === "ready" ? settings.values : null);
  const revision = settings.status === "ready" || settings.status === "invalid" ? settings.revision : null;
  const brandsQuery = useQuery({ queryKey: ["usage", "brands"], queryFn: () => brands({}), staleTime: 3600_000 });

  const styles = useMemo(
    () => ({ screen: { flex: 1, backgroundColor: theme.colors.surface0 }, content: { paddingBottom: 32, gap: layout.compact ? 18 : 24 } }),
    [theme, layout.compact],
  );

  if (!values) {
    return (
      <View style={styles.screen}>
        {settings.status === "error" ? (
          <Text style={{ color: theme.colors.statusDanger, padding: 16, fontSize: 12 }}>{settings.error}</Text>
        ) : (
          <Loading />
        )}
      </View>
    );
  }

  const update = (patch: Partial<UsageSettings>) => setDraft({ ...values, ...patch });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <AccountsSection theme={theme} />
      <CredentialsSection theme={theme} brands={brandsQuery.data?.brands ?? []} />
      <BudgetsSection theme={theme} values={values} update={update} />
      <CycleSection theme={theme} values={values} update={update} />

      {settings.saveError ? (
        <Text style={{ color: theme.colors.statusDanger, paddingHorizontal: 16, fontSize: 11 }}>{settings.saveError}</Text>
      ) : null}

      {draft ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (!revision) return;
            void settings.save(values, revision).then(() => setDraft(null));
          }}
          style={{
            marginHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: theme.colors.accent,
            alignItems: "center",
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const }}>
            {settings.saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
