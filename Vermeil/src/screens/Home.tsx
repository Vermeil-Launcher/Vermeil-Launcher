import { Component, createSignal, createEffect, createResource, createMemo, For, Show, onCleanup } from "solid-js";
import { setActiveScreen, setActiveInstanceId, setInitialInstanceTab, setGameLaunched, instances, ensureAccountOrPrompt, account, activeSkinUrl, setDockPagination, clearGameLogs } from "../App";
import { launchInstance, listInstanceWorlds, getJavaNews, getArticleBody, NewsArticle } from "../ipc/commands";
import { IconPlay, IconGlobe, IconShieldCheck } from "../components/Icons";
import PlayerHead from "../components/PlayerHead";
import { openUrl } from "@tauri-apps/plugin-opener";

const NEWS_PER_PAGE = 8;

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

const Home: Component = () => {
  const [news] = createResource(getJavaNews);
  const [newsPage, setNewsPage] = createSignal(1);
  const [selectedArticle, setSelectedArticle] = createSignal<NewsArticle | null>(null);
  const [articleBody, setArticleBody] = createSignal<string>("");
  const [loadingArticle, setLoadingArticle] = createSignal(false);

  const openArticle = async (article: NewsArticle) => {
    // General news articles have no in-app body — open them on minecraft.net
    // directly. Patch notes (with a contentPath body) open in the reader.
    if (!article.body) {
      if (article.url) openUrl(article.url);
      return;
    }
    setSelectedArticle(article);
    setArticleBody("");
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

  const totalNewsPages = () => Math.ceil((news()?.length || 0) / NEWS_PER_PAGE);
  const visibleNews = () => {
    const all = news() || [];
    const start = (newsPage() - 1) * NEWS_PER_PAGE;
    return all.slice(start, start + NEWS_PER_PAGE);
  };

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

    const allWorlds: { instanceId: string; instanceName: string; worldName: string; lastPlayed: string }[] = [];
    for (const inst of insts.slice(0, 5)) {
      try {
        const worlds = await listInstanceWorlds(inst.id);
        for (const w of worlds) {
          allWorlds.push({ instanceId: inst.id, instanceName: inst.name, worldName: w.name, lastPlayed: w.last_played });
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
            <img class="article-hero" src={selectedArticle()!.image_url} />
            <div class="article-title-section">
              <h2 class="article-title">{selectedArticle()!.title}</h2>
              <span class="article-version">
                {[selectedArticle()!.version, formatArticleDate(selectedArticle()!.date)].filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>
          {/* innerHTML is safe here: the article body is sanitized server-side
              with ammonia::clean() in get_article_body (strips <script>/<iframe>/
              on*= handlers/javascript: URLs) before it crosses IPC. Only ever
              feed this element already-sanitized HTML — never raw remote content. */}
          <div class="article-body" innerHTML={articleBody() || (loadingArticle() ? "<p style='color:var(--muted)'>Loading article...</p>" : "<p style='color:var(--muted)'>No content available. Click below to read on minecraft.net.</p>")} />
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
          <div style="color:var(--muted);font-size:12px;margin-bottom:24px;padding:14px;background:var(--bg3);border:1px solid var(--border)">
            No recent worlds. Play a game to see your worlds here.
          </div>
        }>
          <div class="card-grid" style="margin-bottom:24px">
            <For each={recentWorlds()}>
              {(world) => (
                <div
                  class="card card--compact"
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
                    <div style="display:flex;align-items:center;justify-content:space-between">
                      <span class="side-icon"><IconGlobe /></span>
                      <button
                        class="btn btn--primary btn--sm"
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
                    <div class="card-title">{world.worldName}</div>
                    <div class="card-sub">{world.instanceName}</div>
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
          <div style="color:var(--muted);font-size:12px;padding:14px;background:var(--bg3);border:1px solid var(--border)">
            Loading news...
          </div>
        }>
          <div class="card-grid news-grid" style="margin-bottom:80px">
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
