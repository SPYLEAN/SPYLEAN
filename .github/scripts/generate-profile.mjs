import { writeFile } from "node:fs/promises";

const USER = "SPYLEAN";
const API = "https://api.github.com";
const token = process.env.GITHUB_TOKEN || "";
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "SPYLEAN-profile-proof",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const themes = {
  dark: {
    bg: "#0d1117", surface: "#161b22", border: "#30363d",
    text: "#f0f6fc", muted: "#8b949e", faint: "#6e7681",
    blue: "#58a6ff", green: "#3fb950", amber: "#d29922", track: "#21262d",
  },
  light: {
    bg: "#ffffff", surface: "#f6f8fa", border: "#d0d7de",
    text: "#1f2328", muted: "#59636e", faint: "#6e7781",
    blue: "#0969da", green: "#1a7f37", amber: "#9a6700", track: "#eaeef2",
  },
};

const languageColors = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5",
  HTML: "#e34c26", CSS: "#563d7c", Shell: "#89e051", Go: "#00ADD8",
  Java: "#b07219", C: "#555555", "C++": "#f34b7d", Rust: "#dea584",
};

const esc = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function allRepos() {
  const repos = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = await request(`${API}/users/${USER}/repos?per_page=100&type=owner&sort=updated&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function contributionCalendar() {
  const now = new Date();
  const from = new Date(now);
  from.setUTCFullYear(from.getUTCFullYear() - 1);

  if (token) {
    try {
      const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
        user(login:$login){contributionsCollection(from:$from,to:$to){
          contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}
        }}
      }`;
      const result = await request(`${API}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { login: USER, from: from.toISOString(), to: now.toISOString() },
        }),
      });
      const calendar = result?.data?.user?.contributionsCollection?.contributionCalendar;
      if (calendar) {
        return {
          total: calendar.totalContributions,
          exact: true,
          days: calendar.weeks.flatMap((week) => week.contributionDays),
        };
      }
    } catch (error) {
      console.warn(`Contribution API fallback: ${error.message}`);
    }
  }

  const response = await fetch(
    `https://github.com/users/${USER}/contributions?from=${isoDate(from)}&to=${isoDate(now)}`,
    { headers: { "User-Agent": "SPYLEAN-profile-proof" } },
  );
  const html = response.ok ? await response.text() : "";
  const totalMatch = html.match(/([0-9,]+)\s+contributions?\s+in\s+the\s+last\s+year/i);
  const levels = new Map();
  for (const match of html.matchAll(/data-date="([0-9-]+)"[^>]*data-level="([0-4])"/g)) {
    levels.set(match[1], Number(match[2]));
  }
  for (const match of html.matchAll(/data-level="([0-4])"[^>]*data-date="([0-9-]+)"/g)) {
    levels.set(match[2], Number(match[1]));
  }

  const days = [];
  for (let cursor = new Date(from); cursor <= now; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = isoDate(cursor);
    days.push({ date, contributionCount: levels.get(date) || 0 });
  }
  return {
    total: totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : null,
    exact: false,
    days,
  };
}

function streaks(days) {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let best = 0;
  let running = 0;
  for (const day of ordered) {
    running = day.contributionCount > 0 ? running + 1 : 0;
    best = Math.max(best, running);
  }
  let cursor = ordered.length - 1;
  if (cursor >= 0 && ordered[cursor].contributionCount === 0) cursor -= 1;
  let current = 0;
  while (cursor >= 0 && ordered[cursor].contributionCount > 0) {
    current += 1;
    cursor -= 1;
  }
  return {
    current,
    best,
    activeDays: ordered.filter((day) => day.contributionCount > 0).length,
  };
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric",
  }).format(new Date(value)).toUpperCase();
}

function css(theme) {
  const c = themes[theme];
  return `<style>
    .head{font:650 14px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:1.4px;fill:${c.text}}
    .eyebrow{font:750 11px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:1.25px;fill:${c.blue}}
    .label{font:700 9px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:.8px;fill:${c.muted}}
    .body{font:500 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${c.muted}}
    .strong{font:650 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${c.text}}
    .number{font:720 27px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${c.text}}
    .micro{font:550 9px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:.75px;fill:${c.faint}}
    .center{text-anchor:middle}.right{text-anchor:end}
    .pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.4s ease-in-out infinite}
    .scan{stroke-dasharray:90 1100;animation:scan 7s linear infinite}
    @keyframes pulse{0%,100%{opacity:.35;transform:scale(.75)}50%{opacity:1;transform:scale(1.18)}}
    @keyframes scan{to{stroke-dashoffset:-1190}}
    @media(prefers-reduced-motion:reduce){.pulse,.scan{animation:none!important}.pulse{opacity:1}.scan{stroke-dasharray:none}}
  </style>`;
}

function shell(theme, height, title, status, body, description) {
  const c = themes[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(description)}</desc>
  <defs>${css(theme)}</defs>
  <rect width="1200" height="${height}" rx="12" fill="${c.bg}"/>
  <rect x=".5" y=".5" width="1199" height="${height - 1}" rx="11.5" fill="none" stroke="${c.border}"/>
  <rect x="1" y="1" width="1198" height="54" rx="11" fill="${c.surface}"/>
  <path d="M1 44h1198v11H1z" fill="${c.surface}"/>
  <circle cx="28" cy="28" r="5" fill="${c.faint}" opacity=".55"/><circle cx="46" cy="28" r="5" fill="${c.faint}" opacity=".35"/><circle cx="64" cy="28" r="5" fill="${c.faint}" opacity=".2"/>
  <text x="92" y="33" class="head">${esc(title)}</text>
  <circle cx="1017" cy="28" r="4" fill="${c.green}" class="pulse"/><text x="1030" y="33" class="micro">${esc(status)}</text>
  ${body}
  </svg>`;
}

function metricCard(x, value, label, theme) {
  const c = themes[theme];
  return `<g transform="translate(${x} 92)">
    <rect width="210" height="82" rx="9" fill="${c.surface}" stroke="${c.border}"/>
    <text x="18" y="42" class="number">${esc(value)}</text>
    <text x="18" y="64" class="label">${esc(label)}</text>
  </g>`;
}

function renderSignal(theme, data) {
  const c = themes[theme];
  const { profile, repos, originalRepos, languages, calendar, streak, active30, stars, latest } = data;
  const contributionValue = calendar.total === null ? streak.activeDays : calendar.total;
  const contributionLabel = calendar.total === null ? "ACTIVE BUILD DAYS / YEAR" : "CONTRIBUTIONS / YEAR";
  const maxShare = Math.max(...languages.map((language) => language.share), 1);
  const languageRows = languages.slice(0, 5).map((language, index) => {
    const y = 249 + index * 29;
    const width = Math.max(5, 300 * language.share / maxShare);
    return `<circle cx="58" cy="${y - 4}" r="4" fill="${language.color}"/>
      <text x="72" y="${y}" class="strong">${esc(language.name)}</text>
      <rect x="185" y="${y - 11}" width="300" height="8" rx="4" fill="${c.track}"/>
      <rect x="185" y="${y - 11}" width="${width.toFixed(1)}" height="8" rx="4" fill="${c.green}"/>
      <text x="510" y="${y}" class="micro right">${(language.share * 100).toFixed(1)}%</text>`;
  }).join("");
  const recentRows = latest.map((repo, index) => {
    const y = 250 + index * 48;
    const date = formatDate(repo.pushed_at || repo.updated_at).replace(/ 20([0-9]{2})$/, " '$1");
    return `<circle cx="787" cy="${y - 4}" r="4" fill="${index === 0 ? c.green : c.blue}" class="${index === 0 ? "pulse" : ""}"/>
      <text x="802" y="${y}" class="strong">${esc(repo.name.toUpperCase())}</text>
      <text x="1127" y="${y}" class="micro right">${esc(date)}</text>
      <text x="802" y="${y + 18}" class="micro">${esc(repo.language || "SYSTEM")} · ${repo.size > 0 ? "PUBLIC BUILD" : "INITIALIZED"}</text>`;
  }).join("");

  const body = `${metricCard(30, profile.public_repos, "PUBLIC REPOSITORIES", theme)}
  ${metricCard(260, originalRepos.length, "ORIGINAL SYSTEMS", theme)}
  ${metricCard(490, active30, "ACTIVE / 30 DAYS", theme)}
  ${metricCard(720, profile.followers, "FOLLOWERS", theme)}
  ${metricCard(950, stars, "EARNED STARS", theme)}

  <rect x="30" y="194" width="520" height="202" rx="10" fill="${c.surface}" stroke="${c.border}"/>
  <text x="54" y="222" class="eyebrow">LANGUAGE.SIGNAL / REPOSITORY BYTES</text>
  ${languageRows}

  <rect x="570" y="194" width="180" height="202" rx="10" fill="${c.surface}" stroke="${c.border}"/>
  <text x="594" y="222" class="eyebrow">ACTIVITY</text>
  <text x="594" y="266" class="number">${esc(contributionValue)}</text><text x="594" y="286" class="label">${contributionLabel}</text>
  <line x1="594" y1="303" x2="726" y2="303" stroke="${c.border}"/>
  <text x="594" y="330" class="strong">${streak.current} day${streak.current === 1 ? "" : "s"}</text><text x="594" y="347" class="micro">CURRENT STREAK</text>
  <text x="594" y="373" class="strong">${streak.best} day${streak.best === 1 ? "" : "s"}</text><text x="594" y="390" class="micro">BEST / YEAR</text>

  <rect x="770" y="194" width="400" height="202" rx="10" fill="${c.surface}" stroke="${c.border}"/>
  <text x="794" y="222" class="eyebrow">RECENT.REPOSITORY.SIGNAL</text>
  ${recentRows}

  <rect x="30" y="414" width="1140" height="40" rx="8" fill="${c.surface}" stroke="${c.border}"/>
  <line x1="30" y1="414" x2="1170" y2="414" stroke="${c.blue}" stroke-width="2" class="scan"/>
  <text x="52" y="439" class="strong">PUBLIC DATA · AUTO-GENERATED · NO SELF-REPORTED COUNTS</text>
  <text x="1148" y="439" class="micro right">UPDATED ${formatDate(new Date())} · IST</text>`;

  return shell(
    theme, 474, "SPYLEAN.ME / ENGINEERING.PROOF", "AUTO REFRESH / DAILY", body,
    `Live GitHub evidence for ${USER}: repositories, activity, followers, stars, languages and recent systems.`,
  );
}

const [profile, repos, calendar] = await Promise.all([
  request(`${API}/users/${USER}`), allRepos(), contributionCalendar(),
]);

const originalRepos = repos.filter((repo) => !repo.fork && repo.name !== USER);
const nonEmptyOriginals = originalRepos.filter((repo) => repo.size > 0);
const languageMaps = await Promise.all(nonEmptyOriginals.map(async (repo) => {
  try { return await request(`${API}/repos/${USER}/${repo.name}/languages`); }
  catch { return {}; }
}));
const languageTotals = {};
for (const map of languageMaps) {
  for (const [name, bytes] of Object.entries(map)) {
    languageTotals[name] = (languageTotals[name] || 0) + bytes;
  }
}
const languageBytes = Object.values(languageTotals).reduce((sum, bytes) => sum + bytes, 0) || 1;
const languages = Object.entries(languageTotals)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([name, bytes]) => ({
    name, share: bytes / languageBytes, color: languageColors[name] || themes.dark.muted,
  }));

const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
const active30 = originalRepos.filter((repo) => new Date(repo.pushed_at || repo.updated_at).getTime() >= thirtyDaysAgo).length;
const stars = originalRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
const latest = [...originalRepos]
  .sort((a, b) => new Date(b.pushed_at || b.updated_at) - new Date(a.pushed_at || a.updated_at))
  .slice(0, 3);
const streak = streaks(calendar.days);
const data = { profile, repos, originalRepos, languages, calendar, streak, active30, stars, latest };

for (const theme of Object.keys(themes)) {
  await writeFile(`spylean-signal-v3-${theme}.svg`, renderSignal(theme, data));
}

console.log(`Generated SPYLEAN engineering proof for ${formatDate(new Date())}.`);
