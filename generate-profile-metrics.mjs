import { writeFile } from "node:fs/promises";

const USER = "SPYLEAN";
const API = "https://api.github.com";
const token = process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN || "";
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "SPYLEAN-profile-metrics",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const esc = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86_400_000);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function levelFor(count) {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 7) return 3;
  return 4;
}

async function contributionDays() {
  const today = new Date();
  const from = new Date(today);
  from.setUTCFullYear(from.getUTCFullYear() - 1);

  if (token) {
    try {
      const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
        user(login:$login){
          contributionsCollection(from:$from,to:$to){
            contributionCalendar{
              totalContributions
              weeks{contributionDays{date contributionCount weekday}}
            }
          }
        }
      }`;
      const data = await json(`${API}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { login: USER, from: from.toISOString(), to: today.toISOString() } }),
      });
      const calendar = data?.data?.user?.contributionsCollection?.contributionCalendar;
      if (calendar) {
        return {
          exact: true,
          total: calendar.totalContributions,
          days: calendar.weeks.flatMap((week) => week.contributionDays),
        };
      }
    } catch (error) {
      console.warn(`GraphQL contribution query failed; using public fallback: ${error.message}`);
    }
  }

  const start = isoDate(from);
  const end = isoDate(today);
  const response = await fetch(`https://github.com/users/${USER}/contributions?from=${start}&to=${end}`, {
    headers: { "User-Agent": "SPYLEAN-profile-metrics" },
  });
  const html = response.ok ? await response.text() : "";
  const found = new Map();
  for (const match of html.matchAll(/data-date="([0-9-]+)"[^>]*data-level="([0-4])"/g)) {
    found.set(match[1], Number(match[2]));
  }
  for (const match of html.matchAll(/data-level="([0-4])"[^>]*data-date="([0-9-]+)"/g)) {
    found.set(match[2], Number(match[1]));
  }
  const days = [];
  for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= today; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = isoDate(cursor);
    days.push({ date, contributionCount: found.get(date) || 0, weekday: cursor.getUTCDay() });
  }
  return { exact: false, total: null, days };
}

function streaks(days) {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let best = 0;
  let run = 0;
  for (const day of ordered) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let index = ordered.length - 1;
  if (index >= 0 && ordered[index].contributionCount === 0) index -= 1;
  let current = 0;
  while (index >= 0 && ordered[index].contributionCount > 0) {
    current += 1;
    index -= 1;
  }
  const active = ordered.filter((day) => day.contributionCount > 0).length;
  const total = ordered.reduce((sum, day) => sum + day.contributionCount, 0);
  return { current, best, active, average: active ? total / active : 0 };
}

function wallTime(iso) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(iso));
  return {
    hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
    weekday: parts.find((part) => part.type === "weekday")?.value || "Sun",
  };
}

function habits(events) {
  const hours = Array(24).fill(0);
  const weekdays = Object.fromEntries(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => [day, 0]));
  const pushes = events.filter((event) => event.type === "PushEvent" && event.repo?.name !== `${USER}/${USER}`);
  for (const event of pushes) {
    const time = wallTime(event.created_at);
    hours[time.hour] += Math.max(1, Number(event.payload?.size || 1));
    weekdays[time.weekday] += Math.max(1, Number(event.payload?.size || 1));
  }
  return { hours, weekdays, pushes };
}

const languageColors = {
  JavaScript: "#f1e05a",
  TypeScript: "#3178c6",
  Python: "#3572A5",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Shell: "#89e051",
  Go: "#00ADD8",
  Java: "#b07219",
};

function bars(values, x, y, width, height, labels = []) {
  const max = Math.max(1, ...values);
  const gap = 5;
  const barWidth = (width - gap * (values.length - 1)) / values.length;
  return values.map((value, index) => {
    const barHeight = Math.max(value ? 3 : 1, (value / max) * height);
    const label = labels[index] !== undefined
      ? `<text x="${(x + index * (barWidth + gap) + barWidth / 2).toFixed(1)}" y="${y + height + 13}" class="tiny center">${esc(labels[index])}</text>`
      : "";
    return `<rect x="${(x + index * (barWidth + gap)).toFixed(1)}" y="${(y + height - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="${Math.min(3, barWidth / 2)}" fill="#3fb950"/>${label}`;
  }).join("");
}

function contributionTerrain(days) {
  const map = new Map(days.map((day) => [day.date, day.contributionCount]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 25 * 7);
  const cells = [];
  for (let week = 0; week < 26; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + week * 7 + day);
      const count = map.get(isoDate(date)) || 0;
      cells.push({ week, day, count, level: levelFor(count) });
    }
  }
  cells.sort((a, b) => (a.week + a.day) - (b.week + b.day));
  const colors = ["#21262d", "#0e4429", "#006d32", "#26a641", "#39d353"];
  return cells.map(({ week, day, level }) => {
    const x = 850 + week * 11 - day * 11;
    const y = 214 + (week + day) * 5;
    const height = level * 6;
    const top = colors[level];
    if (!level) {
      return `<path d="M${x} ${y}l10 5-10 5-10-5z" fill="#21262d" stroke="#30363d" stroke-width=".6"/>`;
    }
    return `<path d="M${x - 10} ${y - height + 5}v${height}l10 5v-${height}z" fill="#0e4429"/>
      <path d="M${x + 10} ${y - height + 5}v${height}l-10 5v-${height}z" fill="#006d32"/>
      <path d="M${x} ${y - height}l10 5-10 5-10-5z" fill="${top}" stroke="#0d1117" stroke-width=".5"/>`;
  }).join("");
}

function languageBar(languages, x, y, width) {
  let cursor = x;
  return languages.map((language, index) => {
    const segment = width * language.share;
    const rx = index === 0 || index === languages.length - 1 ? 5 : 0;
    const output = `<rect x="${cursor.toFixed(1)}" y="${y}" width="${Math.max(1, segment).toFixed(1)}" height="9" rx="${rx}" fill="${language.color}"/>`;
    cursor += segment;
    return output;
  }).join("");
}

function badge(label, x, y, width) {
  return `<rect x="${x}" y="${y}" width="${width}" height="24" rx="6" fill="#161b22" stroke="#30363d"/>
    <text x="${x + width / 2}" y="${y + 16}" class="badge center">${esc(label)}</text>`;
}

const [profile, repos, events, contributionData] = await Promise.all([
  json(`${API}/users/${USER}`),
  json(`${API}/users/${USER}/repos?per_page=100&type=owner&sort=updated`),
  json(`${API}/users/${USER}/events/public?per_page=100`),
  contributionDays(),
]);

const originalRepos = repos.filter((repo) => !repo.fork && repo.name !== USER);
const languageMaps = await Promise.all(originalRepos.map(async (repo) => {
  try { return await json(`${API}/repos/${USER}/${repo.name}/languages`); }
  catch { return {}; }
}));
const languageTotals = {};
for (const languageMap of languageMaps) {
  for (const [language, bytes] of Object.entries(languageMap)) {
    languageTotals[language] = (languageTotals[language] || 0) + bytes;
  }
}
const totalLanguageBytes = Object.values(languageTotals).reduce((sum, bytes) => sum + bytes, 0) || 1;
const languages = Object.entries(languageTotals)
  .sort((a, b) => b[1] - a[1])
  .map(([name, bytes]) => ({ name, bytes, share: bytes / totalLanguageBytes, color: languageColors[name] || "#8b949e" }))
  .filter((language) => language.share >= 0.003)
  .slice(0, 6);

const avatarResponse = await fetch(profile.avatar_url, { headers: { "User-Agent": "SPYLEAN-profile-metrics" } });
const avatar = avatarResponse.ok
  ? `data:${avatarResponse.headers.get("content-type") || "image/png"};base64,${Buffer.from(await avatarResponse.arrayBuffer()).toString("base64")}`
  : "";

const stats = streaks(contributionData.days);
const activity = habits(events);
const totalStars = originalRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
const totalForks = originalRepos.reduce((sum, repo) => sum + repo.forks_count, 0);
const joinedYears = Math.max(1, Math.floor(daysBetween(profile.created_at, new Date()) / 365.25));
const updatedRepos = new Set(activity.pushes.map((event) => event.repo?.name).filter(Boolean)).size;
const dayValues = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => activity.weekdays[day]);
const featured = [
  ["SamudraNetra", "Oil-spill intelligence"],
  ["KANNU", "Crime-intelligence platform"],
  ["Rank Rascal", "Gaming identity system"],
  ["VenuePulse AI", "Crowd-flow optimization"],
];
const stack = ["TypeScript", "React", "Next.js", "Node.js", "Python", "AI / ML", "Express", "SQLite", "MapLibre", "Data Viz"];

const languageLegend = languages.map((language, index) => {
  const column = index % 3;
  const row = Math.floor(index / 3);
  const x = 785 + column * 142;
  const y = 486 + row * 21;
  return `<circle cx="${x}" cy="${y - 4}" r="4" fill="${language.color}"/>
    <text x="${x + 11}" y="${y}" class="small">${esc(language.name)}</text>
    <text x="${x + 104}" y="${y}" class="tiny">${(language.share * 100).toFixed(1)}%</text>`;
}).join("");

const stackBadges = stack.map((item, index) => {
  const row = Math.floor(index / 5);
  const column = index % 5;
  return badge(item, 335 + column * 80, 548 + row * 32, 72);
}).join("");

const featuredRows = featured.map(([name, label], index) => {
  const y = 566 + index * 32;
  return `<circle cx="786" cy="${y - 4}" r="4" fill="#3fb950"/>
    <text x="798" y="${y}" class="link">${esc(name)}</text>
    <text x="1000" y="${y}" class="tiny">${esc(label)}</text>`;
}).join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-labelledby="title desc">
  <title id="title">SPYLEAN GitHub build graph</title>
  <desc id="desc">Live GitHub profile metrics for Tanvir Aditya, including repository statistics, coding habits, technologies, languages and an isometric contribution terrain.</desc>
  <defs>
    <clipPath id="avatar"><circle cx="154" cy="161" r="86"/></clipPath>
    <style>
      .text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#c9d1d9;font-size:13px}
      .title{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#f0f6fc;font-size:22px;font-weight:600}
      .section{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#58a6ff;font-size:14px;font-weight:600}
      .link{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#58a6ff;font-size:12px;font-weight:600}
      .small{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#8b949e;font-size:11px}
      .tiny{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#6e7681;font-size:9px}
      .badge{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:#c9d1d9;font-size:10px;font-weight:500}
      .number{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:#f0f6fc;font-size:16px;font-weight:600}
      .center{text-anchor:middle}
      .rule{stroke:#21262d;stroke-width:1}
    </style>
  </defs>

  <rect width="1280" height="720" fill="#0d1117"/>
  <rect width="1280" height="58" fill="#161b22"/>
  <path d="M58 22C50 22 44 28.5 44 36.2c0 6.1 3.8 11.3 9.5 13.1.7.1 1-.3 1-.7v-2.7c-4.1.9-5-1.8-5-1.8-.7-1.8-1.7-2.3-1.7-2.3-1.4-1 .1-.9.1-.9 1.6.1 2.4 1.6 2.4 1.6 1.4 2.4 3.7 1.7 4.6 1.3.1-1 .5-1.7.9-2.1-3.3-.4-6.8-1.7-6.8-7.4 0-1.6.6-3 1.6-4-.2-.4-.7-1.9.1-4 0 0 1.3-.4 4.1 1.5 1.2-.3 2.5-.5 3.8-.5s2.6.2 3.8.5c2.8-1.9 4.1-1.5 4.1-1.5.8 2.1.3 3.6.1 4 1 1.1 1.6 2.4 1.6 4 0 5.8-3.5 7-6.8 7.4.5.5 1 1.4 1 2.8v4.1c0 .4.3.8 1 .7 5.6-1.9 9.5-7 9.5-13.1C72 28.5 65.7 22 58 22z" fill="#f0f6fc"/>
  <text x="88" y="36" class="title" font-size="16">SPYLEAN / BUILD GRAPH</text>
  <text x="1130" y="36" class="small">LIVE · PUBLIC DATA</text>

  ${avatar ? `<image href="${avatar}" x="68" y="75" width="172" height="172" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar)"/>` : ""}
  <circle cx="154" cy="161" r="87" fill="none" stroke="#30363d" stroke-width="2"/>
  <text x="66" y="278" class="title">${esc(profile.name || USER)}</text>
  <text x="66" y="300" class="section">@${USER}</text>
  <text x="66" y="329" class="text">Creative technologist</text>
  <text x="66" y="348" class="text">&amp; systems builder</text>
  <text x="66" y="382" class="small">Founder, CFORGE · Bangalore</text>
  <text x="66" y="403" class="link">spylean-portfolio.vercel.app</text>
  <line x1="66" y1="430" x2="282" y2="430" class="rule"/>
  <text x="66" y="458" class="section">GitHub metrics</text>
  <text x="66" y="480" class="small">${USER} / public build activity</text>
  <text x="66" y="518" class="small">Joined GitHub ${joinedYears} year${joinedYears === 1 ? "" : "s"} ago</text>
  <text x="66" y="540" class="small">${profile.followers} followers · ${profile.following} following</text>
  <text x="66" y="562" class="small">${profile.public_repos} public repositories</text>
  <text x="66" y="584" class="small">${totalStars} earned star${totalStars === 1 ? "" : "s"} · ${totalForks} forks</text>
  <text x="66" y="618" class="small">Creative × technology</text>
  <text x="66" y="640" class="small">Problems → systems → shipped work</text>

  <line x1="310" y1="78" x2="310" y2="680" class="rule"/>
  <text x="335" y="96" class="section">Profile activity</text>
  <text x="335" y="124" class="small">● ${contributionData.exact ? `${contributionData.total} public contributions this year` : `${stats.active} active build days mapped this year`}</text>
  <text x="335" y="148" class="small">◇ ${updatedRepos} repositories updated recently</text>
  <text x="335" y="172" class="small">⌘ ${stats.active} active build days</text>
  <text x="555" y="124" class="small">★ ${totalStars} stars across original systems</text>
  <text x="555" y="148" class="small">↳ ${totalForks} public forks</text>
  <text x="555" y="172" class="small">◉ ${languages.length} active languages</text>
  <line x1="335" y1="195" x2="748" y2="195" class="rule"/>

  <text x="335" y="226" class="section">Build habits &amp; recent signal</text>
  <text x="438" y="254" class="small">Commit activity per time of day</text>
  <line x1="335" y1="350" x2="748" y2="350" class="rule"/>
  ${bars(activity.hours, 335, 270, 413, 70, Array.from({ length: 24 }, (_, index) => index % 3 === 0 ? String(index).padStart(2, "0") : ""))}
  <text x="335" y="389" class="small">Commit activity by day</text>
  ${bars(dayValues, 335, 402, 188, 55, ["S", "M", "T", "W", "T", "F", "S"])}
  <text x="565" y="389" class="small">Language activity</text>
  ${languages.slice(0, 3).map((language, index) => {
    const y = 409 + index * 25;
    return `<text x="565" y="${y + 9}" class="tiny">${esc(language.name)}</text>
      <rect x="633" y="${y}" width="105" height="7" rx="4" fill="#21262d"/>
      <rect x="633" y="${y}" width="${Math.max(2, 105 * language.share).toFixed(1)}" height="7" rx="4" fill="#3fb950"/>
      <text x="744" y="${y + 8}" class="tiny">${(language.share * 100).toFixed(0)}%</text>`;
  }).join("")}
  <text x="335" y="520" class="section">Core stack &amp; domains</text>
  ${stackBadges}

  <line x1="770" y1="78" x2="770" y2="680" class="rule"/>
  <text x="792" y="96" class="section">Repository signal</text>
  ${[
    [828, profile.public_repos, "Repositories"],
    [928, originalRepos.length, "Original"],
    [1028, languages.length, "Languages"],
    [1128, featured.length, "Featured"],
  ].map(([x, value, label]) => `<circle cx="${x}" cy="133" r="28" fill="none" stroke="#30363d" stroke-width="4"/>
    <circle cx="${x}" cy="133" r="28" fill="none" stroke="#3fb950" stroke-width="4" stroke-dasharray="${Math.min(166, 28 + Number(value) * 12)} 176" transform="rotate(-90 ${x} 133)"/>
    <text x="${x}" y="139" class="number center">${value}</text>
    <text x="${x}" y="176" class="tiny center">${label}</text>`).join("")}

  <text x="792" y="208" class="section">Contribution terrain</text>
  ${contributionTerrain(contributionData.days)}
  <text x="1042" y="226" class="small">Current streak ${stats.current} day${stats.current === 1 ? "" : "s"}</text>
  <text x="1042" y="246" class="small">Best streak ${stats.best} day${stats.best === 1 ? "" : "s"}</text>
  <text x="1042" y="266" class="small">~${stats.average.toFixed(1)} contributions / active day</text>

  <text x="792" y="452" class="section">Most used languages</text>
  <rect x="785" y="463" width="430" height="9" rx="5" fill="#21262d"/>
  ${languageBar(languages, 785, 463, 430)}
  ${languageLegend}

  <text x="792" y="542" class="section">Active systems</text>
  ${featuredRows}

  <line x1="42" y1="682" x2="1238" y2="682" class="rule"/>
  <text x="42" y="705" class="tiny">Updated ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium" }).format(new Date())} · Asia/Kolkata · generated from public GitHub data</text>
</svg>`;

await writeFile("spylean-live-metrics.svg", svg);
console.log(`Generated spylean-live-metrics.svg for ${profile.login}`);
