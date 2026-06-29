import { Component, createSignal, createEffect, createResource, createMemo, For, Show, onCleanup } from "solid-js";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, setGameLaunched, instances, ensureAccountOrPrompt, account, activeSkinUrl, setDockPagination, clearGameLogs } from "../App";
import { launchInstance, listInstanceWorlds, getJavaNews, getArticleBody, NewsArticle } from "../ipc/commands";
import { loaderBadgeClass, loaderLabel } from "../lib/loader";
import { createGridPageSize } from "../lib/gridPageSize";
import { IconPlay, IconGlobe, IconShieldCheck } from "../components/Icons";
import PlayerHead from "../components/PlayerHead";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Pick a time-of-day greeting. Cheap personalization that makes the home
 *  screen feel less generic without leaning on user data we don't have. */
function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Good evening";   // late night still reads as evening
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Format the most recent play timestamp as a relative phrase
 *  ("today", "yesterday", "3 days ago"). Falls back to the date. */
function relativePlayed(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** Loader-tinted icon-tile background class (mirrors the Library card). */
function bannerColor(loader: string): string {
  switch (loader) {
    case "fabric": return "fabric";
    case "quilt": return "quilt";
    case "forge": return "orange";
    case "neoforge": return "purple";
    default: return "green";
  }
}

const Home: Component = () => {
  const [news] = createResource(getJavaNews);
  const [newsPage, setNewsPage] = createSignal(1);
  // Column-aware news page size so each page fills complete rows when the
  // window is maximized (shared helper — see lib/gridPageSize.ts). News uses
  // the standard `.card-grid` (track 240, gap 12); media cards are taller.
  const newsPageSize = createGridPageSize({ track: 240, gap: 12, rowHeight: 240, maxRows: 4 });
  const [selectedArticle, setSelectedArticle] = createSignal<NewsArticle | null>(null);
  const [articleBody, setArticleBody] = createSignal<string>("");
  const [loadingArticle, setLoadingArticle] = createSignal(false);

  const openArticle = async (article: NewsArticle) => {
    // Every article opens the in-app reader for a consistent experience.
    // Patch notes (with a contentPath `body`) fetch their full HTML; general
    // news has no in-app body, so the reader shows the excerpt plus a
    // "Read on minecraft.net" button (its `url` is the canonical article link).
    setSelectedArticle(article);
    setArticleBody("");
    if (!article.body) return;
    setLoadingArticle(true);
    try {
      const body = await getArticleBody(article.body);
      setArticleBody(body);
    } catch { setArticleBody(""); }
    finally { setLoadingArticle(false); }
  };

  /** Format an ISO-8601 date to a short, locale-aware label (e.g. "May 19, 2026").
   *  Returns "" for missing/unparseable dates so the caller can omit it. */
  const formatArticleDate = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const totalNewsPages = () => Math.ceil((news()?.length || 0) / newsPageSize.size());
  const visibleNews = () => {
    const all = news() || [];
    const start = (newsPage() - 1) * newsPageSize.size();
    return all.slice(start, start + newsPageSize.size());
  };

  // Clamp the page if the column-aware size grows (e.g. on maximize) so a
  // formerly-valid page number doesn't land past the new last page.
  createEffect(() => {
    const total = totalNewsPages();
    if (newsPage() > total) setNewsPage(Math.max(1, total));
  });

  // Push news pagination into the dock when there are multiple pages.
  createEffect(() => {
    if (totalNewsPages() > 1) {
      setDockPagination({ current: newsPage(), total: totalNewsPages(), onPageChange: setNewsPage });
    } else {
      setDockPagination(null);
    }
  });
  onCleanup(() => setDockPagination(null));

  const [recentWorlds] = createResource(async () => {
    const insts = instances();
    if (!insts || insts.length === 0) return [];

    const allWorlds: {
      instanceId: string; instanceName: string; instanceIcon: string;
      loader: string; gameVersion: string;
      worldName: string; worldIcon: string | null; lastPlayed: string;
    }[] = [];
    for (const inst of insts.slice(0, 5)) {
      try {
        const worlds = await listInstanceWorlds(inst.id);
        for (const w of worlds) {
          allWorlds.push({
            instanceId: inst.id,
            instanceName: inst.name,
            instanceIcon: inst.icon,
            loader: inst.loader.type,
            gameVersion: inst.game_version,
            worldName: w.name,
            worldIcon: w.icon,
            lastPlayed: w.last_played,
          });
        }
      } catch { /* ignore */ }
    }
    allWorlds.sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed));
    return allWorlds.slice(0, 3);
  });

  const handlePlayWorld = async (instanceId: string) => {
    if (!ensureAccountOrPrompt()) return;
    setActiveInstanceId(instanceId);
    setInitialInstanceTab("logs");
    setGameLaunched(true);
    setActiveScreen("mods");
    clearGameLogs(instanceId);
    try { await launchInstance(instanceId); } catch (e) { console.error(e); }
  };

  // Header summary — total instance count + most-recent play date across
  // all instances, formatted relatively. Memo'd so it only recomputes when
  // the instances signal changes, not on every render.
  const headerSummary = createMemo(() => {
    const list = instances() ?? [];
    if (list.length === 0) return null;
    const mostRecent = list
      .map((i) => i.last_played)
      .filter((d): d is string => Boolean(d))
      .sort()
      .pop();
    return {
      count: list.length,
      relative: relativePlayed(mostRecent),
    };
  });

  const displayName = () => account()?.name ?? "Player";

  return (
    <div class="screen-enter">
      {/* Article detail view */}
      <Show when={selectedArticle()}>
        <div class="article-detail">
          <button class="btn btn--ghost" style="margin-bottom:12px" onClick={() => setSelectedArticle(null)}>← Back to News</button>
          <div class="article-header">
            <div class="article-hero-wrap">
              {/* Blurred backdrop fills the wide banner; the sharp copy sits
                  centred and only ever downscales, so low-res feed images stay
                  crisp and uncropped. */}
              <div class="article-hero-bg" style={`background-image:url(${selectedArticle()!.image_url})`} />
              <img class="article-hero-img" src={selectedArticle()!.image_url} />
            </div>
            <div class="article-title-section">
              <h2 class="article-title">{selectedArticle()!.title}</h2>
              <span class="article-version">
                {[selectedArticle()!.version, formatArticleDate(selectedArticle()!.date)].filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>
          {/* Patch notes have a full in-app HTML body; general news only has a
              short excerpt + an external link. */}
          <Show
            when={selectedArticle()!.body}
            fallback={
              <div class="article-body">
                {/* Escaped text — never innerHTML for feed-supplied excerpts. */}
                <p>{selectedArticle()!.excerpt || "Read the full article on minecraft.net."}</p>
              </div>
            }
          >
            {/* innerHTML is safe here: the article body is sanitized server-side
                with ammonia::clean() in get_article_body (strips <script>/<iframe>/
                on*= handlers/javascript: URLs) before it crosses IPC. Only ever
                feed this element already-sanitized HTML — never raw remote content. */}
            <div class="article-body" innerHTML={articleBody() || (loadingArticle() ? "<p style='color:var(--muted)'>Loading article...</p>" : "<p style='color:var(--muted)'>No content available.</p>")} />
          </Show>
          <Show when={selectedArticle()!.url}>
            <button class="btn" style="margin-top:12px" onClick={() => openUrl(selectedArticle()!.url)}>
              Read on minecraft.net ↗
            </button>
          </Show>
        </div>
      </Show>

      {/* Main home content */}
      <Show when={!selectedArticle()}>
        {/* Greeting — personalizes the empty space at the top of Home and
            grounds the page so it feels less like a bare news feed. */}
        <div class="home-greeting panel--bracketed">
          <PlayerHead
            skinUrl={activeSkinUrl()}
            name={displayName()}
            size={56}
            class="home-greeting-head"
          />
          <div class="home-greeting-text">
            <div class="home-greeting-line">
              {timeOfDayGreeting()}, <span class="home-greeting-name">{displayName()}</span>
            </div>
            <Show
              when={headerSummary()}
              fallback={
                <div class="home-greeting-meta">
                  Welcome to Vermeil. Create your first instance from the Library tab.
                </div>
              }
            >
              <div class="home-greeting-meta">
                {headerSummary()!.count} instance{headerSummary()!.count === 1 ? "" : "s"}
                <Show when={headerSummary()!.relative}>
                  {" · "}last played {headerSummary()!.relative}
                </Show>
              </div>
            </Show>
          </div>
        </div>

        {/* Continue section */}
        <div class="section-label">Continue</div>
        <Show when={recentWorlds() && recentWorlds()!.length > 0} fallback={
          <div style="color:var(--muted);font-size:12px;margin-bottom:24px;padding:14px;background:var(--surface-panel);border:1px solid var(--border)">
            No recent worlds. Play a game to see your worlds here.
          </div>
        }>
          <div class="card-grid" style="margin-bottom:24px">
            <For each={recentWorlds()}>
              {(world) => (
                <div
                  class="card card--inst world-card"
                  style="cursor:pointer"
                  onClick={() => {
                    // Default click action is to open the instance — matches
                    // the same behavior as clicking an instance card in the
                    // Library. Only the Play button itself launches the game.
                    setActiveInstanceId(world.instanceId);
                    setInitialInstanceTab("content");
                    setActiveScreen("mods");
                  }}
                >
                  <div class="card-body">
                    {/* World thumbnail (icon.png) — loader-tinted tile with a
                        globe fallback when the world has no icon yet. */}
                    <div class={`inst-card-icon ${bannerColor(world.loader)}`}>
                      <Show when={world.worldIcon} fallback={<span class="side-icon"><IconGlobe /></span>}>
                        <img src={world.worldIcon!} alt="" draggable={false} />
                      </Show>
                    </div>
                    <div class="inst-card-content">
                      <div class="card-title inst-name">{world.worldName}</div>
                      <div class="card-sub inst-meta world-card-sub">
                        {/* Modpack/instance icon + name so it's clear which
                            instance the world belongs to. */}
                        <Show when={world.instanceIcon && world.instanceIcon !== 'cube'}>
                          <img class="world-card-inst-icon" src={world.instanceIcon} alt="" draggable={false} />
                        </Show>
                        <span class="world-card-inst-name">{world.instanceName}</span>
                      </div>
                      <div class="inst-card-badges">
                        <span class="badge badge--version">{world.gameVersion}</span>
                        <span class={`badge badge--loader ${loaderBadgeClass(world.loader)}`}>
                          {loaderLabel(world.loader)}
                        </span>
                      </div>
                    </div>
                    <button
                      class="btn btn--primary btn--sm world-card-play"
                      onClick={(e) => {
                        // Stop the bubble so the card-level handler doesn't
                        // also fire and double-navigate.
                        e.stopPropagation();
                        handlePlayWorld(world.instanceId);
                      }}
                    >
                      <IconPlay /> Play
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* News section */}
        <div class="section-label section-label--row">
          <span>Minecraft: Java Edition News</span>
          <div class="section-label-aside">
            <Show when={totalNewsPages() > 1}>
              <span class="news-page-count">Page {newsPage()} / {totalNewsPages()}</span>
            </Show>
            <span
              class="official-badge tip-below tip-right"
              data-tip="News pulled straight from Mojang's official launcher feed."
            >
              <IconShieldCheck />
              Official · Mojang
            </span>
          </div>
        </div>
        <Show when={news() && news()!.length > 0} fallback={
          <div style="color:var(--muted);font-size:12px;padding:14px;background:var(--surface-panel);border:1px solid var(--border)">
            Loading news...
          </div>
        }>
          <div class="card-grid" ref={newsPageSize.setEl}>
            <For each={visibleNews()}>
              {(article) => (
                <div class="card card--media" style="cursor:pointer" onClick={() => openArticle(article)}>
                  <div class="news-thumb" style={`background-image:url(${article.image_url})`} />
                  <div class="card-body">
                    <div class="card-title">{article.title}</div>
                    <div class="card-sub">
                      {[article.version, formatArticleDate(article.date)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default Home;
