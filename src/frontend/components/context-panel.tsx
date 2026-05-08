
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { contextUsage } from "../signals/index.js";
import { Clickable } from "./clickable.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Real-usage categories shown in the bar. Free space, autocompact buffer, and
// the "Free" pseudo-category are excluded — the user cares about *what's
// consuming context*, not what's left. System+MCP tools fold into one Tools
// group so users see a single tools slice rather than four lookalike segments.
type GroupKey = "messages" | "tools" | "agents" | "skills" | "systemPrompt";
const GROUP_COLORS: Record<GroupKey, string> = {
  messages: "#7aa2f7",     // blue
  tools: "#9ece6a",        // green
  agents: "#f7768e",       // pink/red
  skills: "#bb9af7",       // purple
  systemPrompt: "#e0af68", // amber
};
const GROUP_LABELS: Record<GroupKey, string> = {
  messages: "Messages",
  tools: "Tools",
  agents: "Agents",
  skills: "Skills",
  systemPrompt: "System prompt",
};
// Chip dots in the expanded drawer keep per-category color so users can scan
// the breakdown. Mirrors the bar's group color when the category maps to one;
// otherwise hashes the name to a stable distinct color.
const CHIP_FALLBACK = ["#7dcfff", "#9ece6a", "#bb9af7", "#e0af68", "#f7768e", "#7aa2f7", "#ff9e64", "#565f89"];
function colorFor(name: string, provided?: string): string {
  if (provided) return provided;
  const g = groupForCategory(name);
  if (g) return GROUP_COLORS[g];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CHIP_FALLBACK[h % CHIP_FALLBACK.length];
}

function groupForCategory(name: string): GroupKey | null {
  // Deferred tools are loadable-but-not-loaded; they don't consume the
  // active context, so they don't belong in the bar (they appear in chips).
  if (/\(deferred\)/i.test(name)) return null;
  if (name === "Messages") return "messages";
  if (/tools/i.test(name)) return "tools"; // System tools, MCP tools (active only)
  if (/agent/i.test(name)) return "agents";
  if (name === "Skills") return "skills";
  if (name === "System prompt") return "systemPrompt";
  return null; // Free space, Autocompact buffer, Free, etc — excluded from bar
}

interface SectionProps {
  title: string;
  count?: string;
  tokens?: number;
  defaultOpen?: boolean;
  children?: any;
}

function Section({ title, count, tokens, defaultOpen = true, children }: SectionProps) {
  const open = useSignal(defaultOpen);
  return (
    <div class="ctx-section">
      <Clickable
        class="ctx-section-head"
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <div class="ctx-section-left">
          <span class={`ctx-arrow ${open.value ? "open" : ""}`}>▸</span>
          <span class="ctx-section-title">{title}</span>
          {count && <span class="ctx-section-count">{count}</span>}
        </div>
        {tokens !== undefined && (
          <span class="ctx-section-tokens">{formatTokens(tokens)}</span>
        )}
      </Clickable>
      {open.value && children && <div class="ctx-section-body">{children}</div>}
    </div>
  );
}

interface RowProps {
  name: string;
  tokens: number;
  badge?: { text: string; loaded?: boolean };
  highlight?: boolean;
}

function Row({ name, tokens, badge, highlight }: RowProps) {
  return (
    <div class="ctx-row">
      <span class="ctx-row-name" title={name}>
        {badge && (
          <span class={`ctx-row-badge ${badge.loaded ? "loaded" : ""}`}>{badge.text}</span>
        )}
        {name}
      </span>
      <span class={`ctx-row-tokens ${highlight ? "high" : ""}`}>
        {formatTokens(tokens)}
      </span>
    </div>
  );
}

export function ContextPanel() {
  const ctx = contextUsage.value;
  const expanded = useSignal(false);
  const mcpFilter = useSignal("");

  if (!ctx) return null;

  const pct = Math.round(ctx.percentage);
  const totalTokens = ctx.totalTokens;
  const maxTokens = ctx.maxTokens;
  const freeTokens = Math.max(0, maxTokens - totalTokens);

  // Only count categories with tokens for the segmented bar
  const visibleCategories = ctx.categories.filter((c) => c.tokens > 0);

  // Bar groups: collapse SDK categories into the 5 buckets that actually
  // matter (messages/tools/agents/skills/system prompt). Free space and
  // autocompact buffer are intentionally absent from the bar.
  const barGroups = (() => {
    const totals: Record<GroupKey, number> = {
      messages: 0, tools: 0, agents: 0, skills: 0, systemPrompt: 0,
    };
    for (const c of ctx.categories) {
      const g = groupForCategory(c.name);
      if (g) totals[g] += c.tokens;
    }
    const order: GroupKey[] = ["messages", "tools", "agents", "skills", "systemPrompt"];
    return order
      .filter((k) => totals[k] > 0)
      .map((k) => ({ key: k, label: GROUP_LABELS[k], color: GROUP_COLORS[k], tokens: totals[k] }));
  })();

  // Threshold marker position (auto-compact threshold)
  const thresholdPct =
    ctx.autoCompactThreshold && maxTokens > 0
      ? Math.min(100, (ctx.autoCompactThreshold / maxTokens) * 100)
      : null;

  // MCP tools sorted desc by tokens, optionally filtered
  const mcpTools = [...ctx.mcpTools]
    .sort((a, b) => b.tokens - a.tokens)
    .filter((t) => {
      if (!mcpFilter.value) return true;
      const f = mcpFilter.value.toLowerCase();
      return (
        t.name.toLowerCase().includes(f) ||
        t.serverName.toLowerCase().includes(f)
      );
    });

  const skills = ctx.skills?.skillFrontmatter
    ? [...ctx.skills.skillFrontmatter].sort((a, b) => b.tokens - a.tokens)
    : [];

  const agents = [...ctx.agents].sort((a, b) => b.tokens - a.tokens);
  const systemTools = ctx.systemTools
    ? [...ctx.systemTools].sort((a, b) => b.tokens - a.tokens)
    : [];
  const deferredTools = ctx.deferredBuiltinTools
    ? [...ctx.deferredBuiltinTools].sort((a, b) => b.tokens - a.tokens)
    : [];
  const systemPrompt = ctx.systemPromptSections
    ? [...ctx.systemPromptSections].sort((a, b) => b.tokens - a.tokens)
    : [];

  const breakdown = ctx.messageBreakdown;

  // Color escalation matches the pre-auto-compact danger zone — the threshold
  // (typically 80%) is the canonical "things are getting tight" line.
  const usageClass =
    pct >= 90 ? "critical" : pct >= 75 ? "high" : pct < 5 ? "low" : "";

  // Render the bar segments — small helper so collapsed + drawer share one
  // implementation. Min-width on segments keeps tiny slivers visible.
  const renderBar = () => (
    <div class={`ctx-bar ${usageClass}`}>
      {barGroups.map((g) => (
        <div
          key={g.key}
          class="ctx-bar-seg"
          style={`width: ${(g.tokens / maxTokens) * 100}%; background-color: ${g.color};`}
          title={`${g.label}: ${formatTokens(g.tokens)}`}
        />
      ))}
      {thresholdPct !== null && ctx.isAutoCompactEnabled && (
        <div
          class="ctx-bar-thresh"
          style={{ left: `${thresholdPct}%` }}
          title={`auto-compact at ${formatTokens(ctx.autoCompactThreshold!)}`}
        />
      )}
    </div>
  );

  // ESC dismisses the drawer.
  useEffect(() => {
    if (!expanded.value) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") expanded.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded.value]);

  return (
    <>
      {/* Collapsed bar — always visible, click expands into the drawer below */}
      <Clickable
        class={`context-panel collapsed ${usageClass}`}
        onClick={() => {
          expanded.value = true;
        }}
        title="Expand context details"
      >
        <div class="ctx-line">
          <span class="ctx-pct">{pct}%</span>
          <span class="ctx-used">
            {formatTokens(totalTokens)} / {formatTokens(maxTokens)} tokens
          </span>
          <span class="ctx-spacer" />
          {ctx.autoCompactThreshold && ctx.isAutoCompactEnabled && (
            <span class="ctx-thresh-tag">
              auto-compact at {formatTokens(ctx.autoCompactThreshold)}
            </span>
          )}
          <span class="ctx-expand-tag">EXPAND ▾</span>
        </div>
        {renderBar()}
      </Clickable>

      {expanded.value && (
        <>
          {/* Backdrop covers the chat below the header so click-out dismisses
              while keeping messages visible. */}
          <Clickable
            class="ctx-drawer-backdrop"
            tabIndex={-1}
            onClick={() => {
              expanded.value = false;
            }}
          />
          <div class="ctx-drawer">
            <div class="ctx-drawer-head">
              <span class="ctx-drawer-title">Context Window</span>
              <span class="ctx-drawer-sub">
                {ctx.model} · {formatTokens(maxTokens)}
                {ctx.autoCompactThreshold && ctx.isAutoCompactEnabled && (
                  <> · auto-compact at {formatTokens(ctx.autoCompactThreshold)}</>
                )}
              </span>
              <button
                class="ctx-drawer-close"
                onClick={() => { expanded.value = false; }}
                title="Collapse (Esc)"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Sticky summary stays visible while the body scrolls. */}
            <div class="ctx-drawer-summary">
              <div class="ctx-line">
                <span class="ctx-pct">{pct}%</span>
                <span class="ctx-used">
                  <strong>{formatTokens(totalTokens)}</strong> used · {formatTokens(freeTokens)} free
                </span>
              </div>
              {renderBar()}
              {visibleCategories.length > 0 && (
                <div class="ctx-chips">
                  {visibleCategories
                    .sort((a, b) => b.tokens - a.tokens)
                    .map((cat) => (
                      <div key={cat.name} class="ctx-chip">
                        <span
                          class="ctx-chip-dot"
                          style={`background-color: ${colorFor(cat.name, cat.color)};`}
                        />
                        <span class="ctx-chip-lbl">{cat.name}</span>
                        <span class="ctx-chip-val">{formatTokens(cat.tokens)}</span>
                      </div>
                    ))}
                  <div class="ctx-chip free-chip">
                    <span class="ctx-chip-dot" />
                    <span class="ctx-chip-lbl">Free</span>
                    <span class="ctx-chip-val">{formatTokens(freeTokens)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Scrollable body */}
            <div class="ctx-drawer-body">
          {/* Messages breakdown — what's actually eating context */}
          {breakdown && (
            <div>
              <Section
                title="Messages breakdown"
                tokens={
                  breakdown.toolCallTokens +
                  breakdown.toolResultTokens +
                  breakdown.assistantMessageTokens +
                  breakdown.userMessageTokens +
                  breakdown.attachmentTokens
                }
              >
                <Row
                  name="Tool results"
                  tokens={breakdown.toolResultTokens}
                  highlight={breakdown.toolResultTokens > breakdown.toolCallTokens * 2}
                />
                <Row name="Tool calls" tokens={breakdown.toolCallTokens} />
                <Row name="Assistant text" tokens={breakdown.assistantMessageTokens} />
                <Row name="User text" tokens={breakdown.userMessageTokens} />
                {breakdown.attachmentTokens > 0 && (
                  <Row name="Attachments" tokens={breakdown.attachmentTokens} />
                )}
                {breakdown.toolCallsByType && breakdown.toolCallsByType.length > 0 && (
                  <>
                    <div class="ctx-row-divider">By tool type</div>
                    {breakdown.toolCallsByType
                      .slice()
                      .sort(
                        (a, b) =>
                          b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens),
                      )
                      .slice(0, 10)
                      .map((t) => (
                        <Row
                          key={t.name}
                          name={t.name}
                          tokens={t.callTokens + t.resultTokens}
                        />
                      ))}
                  </>
                )}
              </Section>
            </div>
          )}

          {/* MCP tools */}
          {ctx.mcpTools.length > 0 && (
            <div>
              <Section
                title="MCP Tools"
                count={`${ctx.mcpTools.length} loaded`}
                tokens={ctx.mcpTools.reduce((s, t) => s + t.tokens, 0)}
              >
                {ctx.mcpTools.length > 8 && (
                  <input
                    class="ctx-filter"
                    placeholder="filter…"
                    value={mcpFilter.value}
                    onInput={(e: Event) => {
                      mcpFilter.value = (e.target as HTMLInputElement).value;
                    }}
                  />
                )}
                <div class="ctx-scroll">
                  {mcpTools.map((t) => (
                    <Row
                      key={`${t.serverName}:${t.name}`}
                      name={`${t.serverName} · ${t.name}`}
                      tokens={t.tokens}
                      badge={{
                        text: t.isLoaded ? "on" : "off",
                        loaded: t.isLoaded,
                      }}
                    />
                  ))}
                </div>
              </Section>
            </div>
          )}

          {/* Skills */}
          {ctx.skills && ctx.skills.totalSkills > 0 && (
            <div>
              <Section
                title="Skills"
                count={`${ctx.skills.includedSkills} / ${ctx.skills.totalSkills}`}
                tokens={ctx.skills.tokens}
              >
                <div class="ctx-scroll">
                  {skills.map((s) => (
                    <Row key={s.name} name={s.name} tokens={s.tokens} />
                  ))}
                </div>
              </Section>
            </div>
          )}

          {/* Agents */}
          {agents.length > 0 && (
            <div>
              <Section
                title="Agents"
                count={String(agents.length)}
                tokens={agents.reduce((s, a) => s + a.tokens, 0)}
              >
                <div class="ctx-scroll">
                  {agents.map((a) => (
                    <Row key={a.agentType} name={a.agentType} tokens={a.tokens} />
                  ))}
                </div>
              </Section>
            </div>
          )}

          {/* System tools */}
          {(systemTools.length > 0 || deferredTools.length > 0) && (
            <div>
              <Section
                title="System tools"
                count={String(systemTools.length + deferredTools.length)}
                tokens={
                  systemTools.reduce((s, t) => s + t.tokens, 0) +
                  deferredTools.reduce((s, t) => s + t.tokens, 0)
                }
                defaultOpen={false}
              >
                {systemTools.map((t) => (
                  <Row key={t.name} name={t.name} tokens={t.tokens} />
                ))}
                {deferredTools.map((t) => (
                  <Row
                    key={t.name}
                    name={t.name}
                    tokens={t.tokens}
                    badge={{ text: "deferred", loaded: t.isLoaded }}
                  />
                ))}
              </Section>
            </div>
          )}

          {/* System prompt sections */}
          {systemPrompt.length > 0 && (
            <div>
              <Section
                title="System prompt"
                count={String(systemPrompt.length)}
                tokens={systemPrompt.reduce((s, t) => s + t.tokens, 0)}
                defaultOpen={false}
              >
                {systemPrompt.map((s) => (
                  <Row key={s.name} name={s.name} tokens={s.tokens} />
                ))}
              </Section>
            </div>
          )}

          {/* Slash commands */}
          {ctx.slashCommands && ctx.slashCommands.totalCommands > 0 && (
            <div>
              <Section
                title="Slash commands"
                count={`${ctx.slashCommands.includedCommands} / ${ctx.slashCommands.totalCommands}`}
                tokens={ctx.slashCommands.tokens}
                defaultOpen={false}
              />
            </div>
          )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
