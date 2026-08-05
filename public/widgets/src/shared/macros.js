// Macro panel builder — shared by every widget that shows intake vs goal.
//
// Renders calories as a full-width hero ring, protein/carbs/fat as three smaller
// rings in one card, water as a full-width progress bar, fiber/sugar as
// sub-components revealed inside the carbs disclosure, and alcohol as a plain
// stat line. Pairs with shared/macros.css (layout) and shared/ring.css (the
// gauge).
//
// Requires fmt(n, decimals) and esc(s) to already be defined in the widget scope.
//
// Data contract: `vals` and `goal` are plain objects keyed by macro
// (`calories`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`,
// `alcohol_g`, `water_ml`) — e.g. a day's totals, a range's averages, or a
// computed slice. `wording` tunes the caption verb for the remaining amount on
// a FLOOR: { under: "left" | "under", over: "over" } (default "left" / "over").
// A ceiling ignores it — see macroBits.
//
// EVERY entry below must declare a `role`, because the panel is laid out BY
// ROLE and never by a hardcoded key list. A new entry therefore appears exactly
// where its role says it should — and an entry with no role (or an unknown one)
// renders nowhere at all rather than silently sprouting a sixth ring:
//
//   hero  full-width calorie ring
//   ring  one cell of the protein/carbs/fat row
//   bar   full-width horizontal progress bar (water)
//   sub   a sub-component of `parent`, shown inside the parent's disclosure
//   stat  a plain value line under the panel — no ring, no bar (alcohol)
//
// `direction` marks a target you stay UNDER rather than reach (mirrors
// GoalDirection in src/mcp.ts): exceeding a ceiling is flagged with --over,
// exceeding a floor is not.
const MACROS = [
    {
        key: "calories",
        label: "Calories",
        unit: "kcal",
        color: "var(--calories)",
        decimals: 0,
        role: "hero",
    },
    {
        key: "protein_g",
        label: "Protein",
        unit: "g",
        color: "var(--protein)",
        decimals: 0,
        role: "ring",
    },
    {
        key: "carbs_g",
        label: "Carbs",
        unit: "g",
        color: "var(--carbs)",
        decimals: 0,
        role: "ring",
    },
    {
        key: "fat_g",
        label: "Fat",
        unit: "g",
        color: "var(--fat)",
        decimals: 0,
        role: "ring",
    },
    {
        key: "fiber_g",
        label: "Fiber",
        unit: "g",
        color: "var(--fiber)",
        decimals: 1,
        role: "sub",
        parent: "carbs_g",
    },
    {
        key: "sugar_g",
        label: "Sugar",
        unit: "g",
        color: "var(--sugar)",
        decimals: 1,
        role: "sub",
        parent: "carbs_g",
        direction: "ceiling",
    },
    {
        key: "alcohol_g",
        label: "Alcohol",
        unit: "g",
        color: "var(--alcohol)",
        decimals: 1,
        role: "stat",
        direction: "ceiling",
    },
    {
        key: "water_ml",
        label: "Water",
        unit: "ml",
        color: "var(--water)",
        decimals: 0,
        role: "bar",
    },
];

// The metrics that stand on their own as evidence that a day was logged at all
// — used by trends to count logged days. Derived from the roles so a new entry
// joins the test only if it is a top-level metric: fiber and sugar never appear
// without a meal that already contributes calories, and alcohol_g is null (not
// 0) for a user with alcohol tracking off, so neither belongs in the test.
const TOP_LEVEL_MACRO_KEYS = MACROS.filter(
    (m) => m.role === "hero" || m.role === "ring" || m.role === "bar",
).map((m) => m.key);

function dayHasData(day) {
    return TOP_LEVEL_MACRO_KEYS.some((k) => (day?.[k] || 0) > 0);
}

// Grams of pure ethanol per standard drink, and how to name one. Mirrors
// src/alcohol.ts (NIAAA: 14 g per US drink; NHS: one unit is 10 mL of ethanol
// = 7.893 g). Hand-copied rather than pulled in with @inlinets because
// src/widgets.test.ts requires every @include'd partial to appear VERBATIM in
// the assembled HTML, and a marker expanded inside this partial would break it.
const DRINK_GRAMS = { us: 14, uk: 7.893 };
const DRINK_LABEL = { us: "US drinks", uk: "UK units" };

// value vs goal → filled fraction, centre % caption, and the caption line. The
// ring keeps its macro colour even past 100% so the gauges stay distinct; only
// the % caption / value turns red to flag going over goal.
function macroBits(m, vals, goal, wording) {
    const ceiling = m.direction === "ceiling";
    // A ceiling reads as distance from a limit, never as budget remaining:
    // "limit 20 g · 20 g left" tells someone trying to drink less that they
    // have 20 g in hand, and over an average ("7-day average, 12 g left") it
    // means nothing at all. So a ceiling always uses under/over — matching the
    // "Days over limit" phrasing in computeTrends — and `wording` tunes the
    // floor case only (trends passes { under: "under" } for its averages).
    const underWord = ceiling ? "under" : (wording && wording.under) || "left";
    const overWord = (wording && wording.over) || "over";
    const raw = vals?.[m.key];
    // null is the presence signal (no calculated value in the selection), not
    // a zero intake: the tile renders its no-data state — never a 0% ring.
    const noData = raw == null;
    const val = noData ? 0 : raw;
    const target = goal?.[m.key] ?? null;

    let pct = null;
    let over = false;
    if (target != null && target > 0) {
        pct = (val / target) * 100;
        over = pct > 100;
    } else if (ceiling && target === 0) {
        // A ceiling of 0 is a real limit — "none today" is the most likely
        // alcohol limit there is — so it is honoured, while a floor of 0 stays
        // "no goal set" (a 0 g protein target is meaningless). Percent of zero
        // has no value to report, so it is pinned rather than left to divide
        // into Infinity/NaN.
        over = val > 0;
        pct = over ? 100 : 0;
    }
    const frac = pct == null ? 0 : Math.max(0, Math.min(pct, 100)) / 100;
    const pctColor = over ? "var(--over)" : m.color;

    let goalLine, center2;
    if (noData) {
        goalLine = "no data yet";
        center2 = `<div class="ru">${m.unit}</div>`;
    } else if (pct == null) {
        goalLine = "no goal set";
        center2 = `<div class="ru">${m.unit}</div>`;
    } else {
        const delta = target - val;
        let deltaStr;
        if (delta < 0) {
            deltaStr = `${fmt(-delta, m.decimals)} ${m.unit} ${overWord}`;
        } else if (delta === 0 && ceiling) {
            // "0 g under" would be read as room left; exactly at a limit is
            // its own state.
            deltaStr = "at limit";
        } else {
            deltaStr = `${fmt(delta, m.decimals)} ${m.unit} ${underWord}`;
        }
        goalLine = `${ceiling ? "limit" : "of"} ${fmt(target, m.decimals)} ${m.unit} · ${deltaStr}`;
        center2 = `<div class="rp" style="color:${pctColor}">${Math.round(pct)}%</div>`;
    }
    return { val, target, pct, over, frac, goalLine, center2, noData };
}

// The conic-gradient ring gauge markup (size comes from the CSS context). Its
// aria-label is what a STATIC tile exposes; inside an interactive tile the
// button role makes every child presentational, so the value reaches a screen
// reader through the tile's own name instead — see tileLabel.
function ringMarkup(m, b) {
    const cap =
        b.pct != null && b.frac > 0.005 ? `<div class="ring-cap"></div>` : "";
    // No-data renders an em dash, on screen and in the accessible name — a
    // formatted "0" would claim a zero intake the data does not support.
    const valueText = b.noData ? "—" : fmt(b.val, m.decimals);
    const aria = b.noData
        ? `${esc(m.label)} no data yet`
        : `${esc(m.label)} ${valueText} ${m.unit}`;
    return `
      <div class="ring" style="--c:${m.color};--p:${b.frac.toFixed(4)}" role="img" aria-label="${aria}">
        <div class="ring-track"></div>
        <div class="ring-arc"></div>
        ${cap}
        <div class="ring-center">
          <div class="rv">${valueText}</div>
          ${b.center2}
        </div>
      </div>`;
}

function macroLabelGoal(m, b) {
    return `
      <div class="mlabel"><span class="dot" style="background:${m.color}"></span>${m.label}</div>
      <div class="mgoal">${esc(b.goalLine)}</div>`;
}

// The sub-components of one macro that are worth showing: fiber and sugar under
// carbs. Same rule the water bar uses — an untracked metric is noise rather
// than a zero, so a sub only appears once it has data or a goal of its own.
//
// `null` is not "no data yet, treat as zero" — it is the covered-days signal
// (see trendsDayPayloadOf / avgOf): a range with zero covered days for this
// nutrient has nothing to average, so the sub is dropped entirely even when a
// goal is set, matching computeTrends/formatStatLine suppressing the whole
// section rather than printing "0g of 30g target".
function subMacrosOf(m, ctx) {
    return MACROS.filter(
        (s) =>
            s.role === "sub" &&
            s.parent === m.key &&
            ctx.vals[s.key] != null &&
            ((ctx.vals[s.key] ?? 0) > 0 ||
                (ctx.goal ? (ctx.goal[s.key] ?? null) != null : false)),
    );
}

// Is there anything behind this tile to disclose? Either the meals that
// contributed to it, or its own sub-components (carbs → fiber + sugar). A
// panel built without meals is therefore still interactive on carbs alone,
// which is how averaged views like trends surface fiber and sugar.
function macroHasDetail(m, ctx) {
    return !!ctx.meals || subMacrosOf(m, ctx).length > 0;
}

// What tapping this tile reveals. No macro name in it — tileLabel below always
// puts one in front — so the spoken name never says "Carbs" three times.
function detailLabel(m, ctx) {
    const subs = subMacrosOf(m, ctx).map((s) => s.label.toLowerCase());
    if (subs.length && ctx.meals) {
        return `Show ${subs.join(" and ")}, and the meals that contributed.`;
    }
    if (subs.length) return `Show ${subs.join(" and ")}.`;
    return `Show the meals that contributed.`;
}

// The accessible name of an interactive tile — VALUE FIRST, action second.
//
// `role="button"` makes a tile's children presentational: the ring's own
// aria-label, the macro name and the goal caption all drop out of the
// accessibility tree, so a screen reader hears the action and no numbers at
// all, while the static tile beside it reads "Protein 120 g / PROTEIN / of
// 160 g · 40 g left". Folding the value and goal state into the name restores
// exactly what the static tile exposes, in one announcement.
//
// The alternative — moving role="button" to an inner element so the values stay
// exposed — was rejected: the whole tile is the tap target (a 78px ring is the
// thing a finger aims at), so the button would either be smaller than what
// responds to a tap or would nest a second target inside the first.
function tileLabel(m, b, ctx) {
    if (b.noData) {
        return `${m.label} no data yet. ${detailLabel(m, ctx)}`;
    }
    // "·" separates value from goal visually; screen readers either skip it or
    // announce "middle dot", so the spoken name uses a comma.
    const state = b.goalLine.replace(" · ", ", ");
    return `${m.label} ${fmt(b.val, m.decimals)} ${m.unit}, ${state}. ${detailLabel(m, ctx)}`;
}

// When a tile has something to disclose it is also a button that toggles its
// breakdown — see macroToggle below.
function interactiveAttrs(m, b, ctx, interactive) {
    return interactive
        ? ` role="button" tabindex="0" data-macro="${m.key}" aria-expanded="false" aria-label="${esc(tileLabel(m, b, ctx))}"`
        : "";
}

// Calories — full-width hero card with the large ring.
function macroHero(m, ctx, interactive) {
    const b = macroBits(m, ctx.vals, ctx.goal, ctx.wording);
    return `
      <div class="mcard macro-hero${interactive ? " interactive" : ""}"${interactiveAttrs(m, b, ctx, interactive)}>${ringMarkup(m, b)}${macroLabelGoal(m, b)}
      </div>`;
}

// One protein/carbs/fat cell inside the shared row card.
function macroCell(m, ctx, interactive) {
    const b = macroBits(m, ctx.vals, ctx.goal, ctx.wording);
    return `
        <div class="macro-cell${interactive ? " interactive" : ""}"${interactiveAttrs(m, b, ctx, interactive)}>${ringMarkup(m, b)}${macroLabelGoal(m, b)}
        </div>`;
}

// Label + value line, thin progress bar, goal caption. Full-width for water and,
// at a smaller scale, for each carbs sub-component inside the disclosure — one
// idiom, two sizes (see .barstat / .macro-sub in macros.css).
function barStatInner(m, b) {
    const fillPct = b.pct == null ? 0 : Math.max(0, Math.min(b.pct, 100));
    // Exceeding a ceiling (sugar) is the thing to flag; exceeding a floor
    // (fiber, water) is the goal being met, so it keeps the macro colour.
    const flag = b.over && m.direction === "ceiling";
    const valStyle = flag ? ' style="color:var(--over)"' : "";
    const right =
        b.target != null
            ? `<div class="wval"${valStyle}>${fmt(b.val, m.decimals)}<span class="wsub">/ ${fmt(b.target, m.decimals)} ${m.unit}</span></div>`
            : `<div class="wval">${fmt(b.val, m.decimals)}<span class="wsub">${m.unit}</span></div>`;
    return `
        <div class="wtop">
          <div class="mlabel"><span class="dot" style="background:${m.color}"></span>${m.label}</div>
          ${right}
        </div>
        <div class="wbar"><div class="wfill" style="width:${fillPct.toFixed(1)}%;background:${m.color}"></div></div>
        <div class="mgoal wgoal">${esc(b.goalLine)}</div>`;
}

// Water — full-width horizontal bar instead of a ring.
function macroBar(m, ctx) {
    const b = macroBits(m, ctx.vals, ctx.goal, ctx.wording);
    return `
      <div class="mcard macro-water barstat">${barStatInner(m, b)}
      </div>`;
}

// Alcohol — a plain stat line, never a ring: grams with the drink count as the
// intuitive gloss ("2.1 US drinks · 28 g"), plus the limit when one is set.
//
// null vs 0 is load-bearing. `alcohol_g: null` is how a payload in src/mcp.ts
// says "nothing to show here" — either the user does not track alcohol at all
// (see AlcoholDisplay), or (trends' per-day/averaged series only) this day or
// window has zero covered days for it (see trendsDayPayloadOf) — so the line
// is dropped entirely either way. A 0 from a user who DOES track it, on a day
// or window that DOES cover it, is a real alcohol-free reading and stays on
// screen — unlike the water bar, whose 0 means "never logged any" because
// water has no such opt-in to distinguish the two.
function macroStat(m, ctx) {
    const grams = ctx.vals?.[m.key];
    if (grams == null) return "";
    const b = macroBits(m, ctx.vals, ctx.goal, ctx.wording);
    const unitName = DRINK_LABEL[ctx.drinkUnit];
    const drinks = grams / DRINK_GRAMS[ctx.drinkUnit];
    const flag = b.over && m.direction === "ceiling";
    const gramsHtml = `${fmt(grams, m.decimals)}<span class="ssub">${m.unit}</span>`;
    const value =
        grams > 0
            ? `${drinks.toFixed(1)}<span class="ssub">${esc(unitName)}</span><span class="ssep">·</span>${gramsHtml}`
            : `${gramsHtml}<span class="ssep">·</span><span class="ssub">none logged</span>`;
    return `
      <div class="mcard macro-stat">
        <div class="stop">
          <div class="mlabel"><span class="dot" style="background:${m.color}"></span>${m.label}</div>
          <div class="sval"${flag ? ' style="color:var(--over)"' : ""}>${value}</div>
        </div>
        ${b.target != null ? `<div class="mgoal sgoal">${esc(b.goalLine)}</div>` : ""}
      </div>`;
}

// Everything the panel and its disclosure need, in one object: the values, the
// goals, the caption wording, the optional per-meal rows, and the drink unit.
// Built once per macroPanel() call and stashed for the delegated toggle handler.
function macroCtxOf(vals, goal, wording, meals, opts) {
    const unit = opts && opts.drinkUnit;
    return {
        vals: vals || {},
        goal: goal || null,
        wording,
        meals: Array.isArray(meals) && meals.length > 0 ? meals : null,
        // The server sends `drink_unit` on every payload with an alcohol
        // figure and all four production templates pass it through as
        // opts.drinkUnit — do not unwire that. The fallback covers a caller
        // that passes no opts at all (the dev-only component gallery) or an
        // unrecognised unit: "us" is what src/mcp.ts uses for an
        // alcohol-tracking user with no saved preference.
        drinkUnit: DRINK_GRAMS[unit] ? unit : "us",
    };
}

// Full macro panel: calories hero + protein/carbs/fat row + water bar + alcohol
// stat line, laid out by role (never by a hardcoded key list).
//
// `meals` is optional: when a non-empty array of per-meal breakdown rows is
// passed (each { description, meal_type, date, calories, protein_g, carbs_g,
// fat_g, ... }), the tiles become tappable and reveal the meals that contributed
// to that macro (see macroToggle). Carbs is tappable even without meals, since
// it also discloses fiber and sugar.
//
// `opts` is optional: { drinkUnit: "us" | "uk" } for the alcohol line.
function macroPanel(vals, goal, wording, meals, opts) {
    const ctx = macroCtxOf(vals, goal, wording, meals, opts);
    // Stash it so the delegated toggle handler can build the breakdown on
    // demand. One panel per widget, so a single slot is enough.
    __macroCtx = ctx;

    const hero = MACROS.find((m) => m.role === "hero");
    const trio = MACROS.filter((m) => m.role === "ring");
    const bars = MACROS.filter(
        // Only show a bar for a metric that was actually tracked — an empty bar
        // for an untouched metric is noise.
        (m) => m.role === "bar" && (ctx.vals[m.key] ?? 0) > 0,
    );
    const stats = MACROS.filter((m) => m.role === "stat");

    const heroOn = macroHasDetail(hero, ctx);
    const cells = trio.map((m) => macroCell(m, ctx, macroHasDetail(m, ctx)));
    const interactive = heroOn || trio.some((m) => macroHasDetail(m, ctx));

    const hint = interactive
        ? `<div class="macro-hint">${
              ctx.meals
                  ? "Tap a metric to see which meals contributed."
                  : "Tap carbs to see fiber and sugar."
          }</div>`
        : "";
    // The breakdown renders into this region on tap; hidden until then.
    const detail = interactive
        ? `<div class="macro-detail" hidden aria-live="polite"></div>`
        : "";
    return `
      <div class="macro-panel"${interactive ? " data-macro-panel" : ""}>
      ${hint}
      ${macroHero(hero, ctx, heroOn)}
      <div class="mcard macro-row">${cells.join("")}
      </div>
      ${bars.map((m) => macroBar(m, ctx)).join("")}
      ${stats.map((m) => macroStat(m, ctx)).join("")}
      ${detail}
      </div>`;
}

// ---- Interactive breakdown ------------------------------------------------
// Set by macroPanel() when the panel is interactive; read by the delegated
// handlers below.
let __macroCtx = null;

// Fiber and sugar for the same period as the panel, rendered as compact bar
// stats inside the parent's disclosure. Sub-components of carbs, never rings of
// their own.
function subBlock(m, ctx) {
    const subs = subMacrosOf(m, ctx);
    if (!subs.length) return "";
    const rows = subs
        .map(
            (s) =>
                `<div class="macro-sub barstat">${barStatInner(s, macroBits(s, ctx.vals, ctx.goal, ctx.wording))}</div>`,
        )
        .join("");
    return `<div class="md-subs"><div class="md-subtitle">Of which</div>${rows}</div>`;
}

// The list of meals that contributed a positive amount of one macro,
// largest-first, capped so a long range stays readable.
function mealList(m, meals) {
    const decimals = m.key === "calories" ? 0 : 1;
    const rows = meals
        .map((meal) => ({ meal, v: Number(meal?.[m.key] ?? 0) || 0 }))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v);

    if (!rows.length) {
        return `<div class="md-empty">No logged meals contributed ${esc(m.label.toLowerCase())}.</div>`;
    }

    const CAP = 8;
    const shown = rows.slice(0, CAP);
    const extra = rows.length - shown.length;
    const items = shown
        .map(({ meal, v }) => {
            // Prefer a date tag for multi-day ranges, otherwise the meal type.
            const sub = meal.date
                ? esc(String(meal.date).slice(5))
                : meal.meal_type
                  ? esc(meal.meal_type)
                  : "";
            return `
        <li class="md-row">
          <span class="md-val" style="color:${m.color}">${fmt(v, decimals)}<span class="md-unit">${esc(m.unit)}</span></span>
          <span class="md-name">${esc(meal.description || "Untitled meal")}${sub ? `<span class="md-sub">${sub}</span>` : ""}</span>
        </li>`;
        })
        .join("");
    const more =
        extra > 0
            ? `<li class="md-more">+ ${extra} smaller meal${extra === 1 ? "" : "s"}</li>`
            : "";
    return `<ul class="md-list">${items}${more}</ul>`;
}

// Build the breakdown for one macro: its sub-components (carbs → fiber, sugar)
// and/or the meals behind it. One disclosure, one region, whichever parts apply.
function macroDetailBody(m, ctx) {
    const subs = subBlock(m, ctx);
    const head = `
      <div class="md-head">
        <span class="md-title"><span class="dot" style="background:${m.color}"></span>${esc(m.label)} ${subs ? "breakdown" : "by meal"}</span>
        <button class="md-close" data-macro-close aria-label="Close breakdown">✕</button>
      </div>`;
    if (!ctx.meals) return `${head}${subs}`;
    // Both parts present → the meal list needs its own heading to stay legible.
    const listTitle = subs ? `<div class="md-subtitle">By meal</div>` : "";
    return `${head}${subs}${listTitle}${mealList(m, ctx.meals)}`;
}

// Toggle the breakdown for the tapped tile. Tapping the open tile again (or its
// ✕) collapses it; tapping another tile swaps the list. The height change is
// picked up by the bridge's ResizeObserver, which re-reports so the host grows
// the iframe.
function macroToggle(cell) {
    const panel = cell.closest("[data-macro-panel]");
    if (!panel || !__macroCtx) return;
    const detail = panel.querySelector(".macro-detail");
    if (!detail) return;
    const key = cell.dataset.macro;
    const alreadyOpen = detail.dataset.open === key && detail.hidden === false;

    panel.querySelectorAll("[data-macro]").forEach((c) => {
        const on = c === cell && !alreadyOpen;
        c.classList.toggle("open", on);
        c.setAttribute("aria-expanded", on ? "true" : "false");
    });

    if (alreadyOpen) {
        detail.hidden = true;
        detail.dataset.open = "";
        detail.innerHTML = "";
        return;
    }
    const m = MACROS.find((mm) => mm.key === key);
    if (!m) return;
    detail.innerHTML = macroDetailBody(m, __macroCtx);
    detail.dataset.open = key;
    detail.hidden = false;
}

// Delegated once per document. No-ops on non-interactive panels (no
// [data-macro] tiles), so widgets that omit meals are unaffected.
if (typeof document !== "undefined" && !window.__macroWired) {
    window.__macroWired = true;
    document.addEventListener("click", (e) => {
        if (e.target.closest("[data-macro-close]")) {
            const panel = e.target.closest("[data-macro-panel]");
            const detail = panel && panel.querySelector(".macro-detail");
            if (detail && detail.dataset.open) {
                const cell = panel.querySelector(
                    `[data-macro="${detail.dataset.open}"]`,
                );
                if (cell) macroToggle(cell);
            }
            return;
        }
        const cell = e.target.closest("[data-macro]");
        if (cell) macroToggle(cell);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        const cell = e.target.closest("[data-macro]");
        if (!cell) return;
        e.preventDefault();
        macroToggle(cell);
    });
}
