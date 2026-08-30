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

const systemPalettes = {
  dark: {
    bg: "#0d1117",
    surface: "#161b22",
    surfaceAlt: "#0d1117",
    border: "#30363d",
    text: "#f0f6fc",
    body: "#c9d1d9",
    muted: "#8b949e",
    faint: "#6e7681",
    accent: "#58a6ff",
    success: "#3fb950",
    glow: "#388bfd",
    scan: "#79c0ff",
  },
  light: {
    bg: "#ffffff",
    surface: "#f6f8fa",
    surfaceAlt: "#ffffff",
    border: "#d0d7de",
    text: "#1f2328",
    body: "#24292f",
    muted: "#57606a",
    faint: "#6e7781",
    accent: "#0969da",
    success: "#1a7f37",
    glow: "#54aeff",
    scan: "#0969da",
  },
};

function systemProfileSvg(palette, profileData, avatarData, mode) {
  const infoRows = [
    ["identity", "Tanvir Aditya Bayi"],
    ["codename", "SPYLEAN"],
    ["function", "Creative Technologist"],
    ["role", "Founder, CFORGE"],
    ["base", "Bangalore, India"],
    ["status", "Building in public"],
  ];
  const engineRows = [
    ["product", "React · Next.js · TypeScript · Node.js"],
    ["intelligence", "Python · Gemini · applied ML · data systems"],
    ["creative", "Brand systems · campaigns · experience design"],
    ["method", "Problems → systems → shipped work"],
  ];
  const builds = [
    ["01", "SAMUDRANETRA", "MARITIME INTELLIGENCE"],
    ["02", "KANNU", "CRIME INTELLIGENCE"],
    ["03", "RANK RASCAL", "GAME SYSTEMS"],
    ["04", "VENUEPULSE AI", "CROWD OPERATIONS"],
  ];
  const info = infoRows.map(([label, value], index) => {
    const y = 148 + index * 41;
    return `<text x="548" y="${y}" class="label">${esc(label)}:</text>
      <text x="675" y="${y}" class="value">${esc(value)}</text>
      <line x1="548" y1="${y + 13}" x2="1143" y2="${y + 13}" class="hairline"/>`;
  }).join("");
  const engine = engineRows.map(([label, value], index) => {
    const y = 427 + index * 30;
    return `<text x="548" y="${y}" class="label">${esc(label)}:</text>
      <text x="675" y="${y}" class="smallValue">${esc(value)}</text>`;
  }).join("");
  const buildRows = builds.map(([index, name, domain], position) => {
    const x = 48 + position * 286;
    return `<text x="${x}" y="568" class="buildIndex">${index}</text>
      <text x="${x + 31}" y="568" class="buildName">${esc(name)}</text>
      <text x="${x + 31}" y="585" class="buildDomain">${esc(domain)}</text>
      <circle cx="${x + 265}" cy="563" r="3.5" fill="${palette.success}" class="buildPulse" style="animation-delay:${position * 0.35}s"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620" role="img" aria-labelledby="system-title system-desc">
    <title id="system-title">SPYLEAN identity system</title>
    <desc id="system-desc">A GitHub-native profile console for Tanvir Aditya Bayi, also known as SPYLEAN, showing his identity, role, technical engine and active software systems.</desc>
    <defs>
      <clipPath id="portrait-clip"><rect x="48" y="92" width="454" height="414" rx="10"/></clipPath>
      <clipPath id="registry-clip"><rect x="536" y="74" width="634" height="458" rx="12"/></clipPath>
      <linearGradient id="portrait-fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="white"/>
        <stop offset=".72" stop-color="white"/>
        <stop offset="1" stop-color="black"/>
      </linearGradient>
      <mask id="portrait-mask">
        <rect x="48" y="92" width="454" height="414" rx="10" fill="url(#portrait-fade)"/>
      </mask>
      <pattern id="scanlines" width="6" height="7" patternUnits="userSpaceOnUse">
        <rect width="6" height="1" fill="${palette.scan}" opacity=".78"/>
      </pattern>
      <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
        <path d="M32 0H0V32" fill="none" stroke="${palette.border}" stroke-width=".7" opacity=".55"/>
      </pattern>
      <filter id="portrait-tone" color-interpolation-filters="sRGB">
        <feColorMatrix type="matrix" values=".03 .10 .01 0 .02  .12 .40 .04 0 .10  .20 .68 .07 0 .22  0 0 0 .92 0"/>
        <feComponentTransfer>
          <feFuncR type="gamma" amplitude="1.05" exponent=".88" offset="0"/>
          <feFuncG type="gamma" amplitude="1.08" exponent=".82" offset="0"/>
          <feFuncB type="gamma" amplitude="1.15" exponent=".78" offset="0"/>
        </feComponentTransfer>
      </filter>
      <filter id="soft-glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <style>
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace}
        .sans{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
        .header{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.body};font-size:14px;font-weight:650;letter-spacing:1.5px}
        .eyebrow{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.accent};font-size:12px;font-weight:700;letter-spacing:1.4px}
        .label{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.muted};font-size:13px}
        .value{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.text};font-size:15px;font-weight:650}
        .smallValue{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.body};font-size:12.5px}
        .portraitName{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${palette.text};font-size:25px;font-weight:650}
        .portraitRole{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.accent};font-size:12px;font-weight:650;letter-spacing:1.2px}
        .micro{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.faint};font-size:9px;letter-spacing:1px}
        .buildIndex{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.success};font-size:12px;font-weight:750}
        .buildName{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.text};font-size:12px;font-weight:750}
        .buildDomain{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;fill:${palette.faint};font-size:8px;letter-spacing:.7px}
        .hairline{stroke:${palette.border};stroke-width:1}
        .signalDot{transform-box:fill-box;transform-origin:center;animation:signal-pulse 2.4s ease-in-out infinite}
        .portraitSignal{animation:hologram-flicker 7.5s linear infinite}
        .scanSweep{transform-box:fill-box;animation:scan-sweep 5.2s cubic-bezier(.45,0,.55,1) infinite}
        .registrySweep{transform-box:fill-box;animation:registry-sweep 7.2s ease-in-out infinite}
        .buildPulse{transform-box:fill-box;transform-origin:center;animation:build-pulse 2.8s ease-in-out infinite}
        @keyframes signal-pulse{
          0%,100%{opacity:.5;transform:scale(.82)}
          45%,55%{opacity:1;transform:scale(1.18)}
        }
        @keyframes hologram-flicker{
          0%,44%,48%,73%,76%,100%{opacity:1}
          45%{opacity:.92}
          46%{opacity:.76}
          47%{opacity:.96}
          74%{opacity:.88}
          75%{opacity:1}
        }
        @keyframes scan-sweep{
          0%{opacity:0;transform:translateY(0)}
          10%{opacity:.82}
          82%{opacity:.65}
          100%{opacity:0;transform:translateY(378px)}
        }
        @keyframes registry-sweep{
          0%,12%{opacity:0;transform:translateX(0)}
          18%{opacity:.28}
          72%{opacity:.18}
          82%,100%{opacity:0;transform:translateX(568px)}
        }
        @keyframes build-pulse{
          0%,100%{opacity:.45;transform:scale(.8)}
          50%{opacity:1;transform:scale(1.12)}
        }
        @media (prefers-reduced-motion:reduce){
          .signalDot,.portraitSignal,.scanSweep,.registrySweep,.buildPulse{animation:none!important}
          .signalDot,.buildPulse{opacity:1}
          .scanSweep,.registrySweep{display:none}
        }
      </style>
    </defs>

    <rect width="1200" height="620" rx="12" fill="${palette.bg}"/>
    <rect x=".5" y=".5" width="1199" height="619" rx="11.5" fill="none" stroke="${palette.border}"/>
    <rect x="1" y="1" width="1198" height="54" rx="11" fill="${palette.surface}"/>
    <path d="M1 44h1198v11H1z" fill="${palette.surface}"/>
    <circle cx="28" cy="28" r="5" fill="${palette.faint}" opacity=".55"/>
    <circle cx="46" cy="28" r="5" fill="${palette.faint}" opacity=".38"/>
    <circle cx="64" cy="28" r="5" fill="${palette.faint}" opacity=".22"/>
    <text x="92" y="33" class="header">SPYLEAN.ME / IDENTITY.REGISTRY</text>
    <circle cx="1048" cy="28" r="4" fill="${palette.success}" class="signalDot"/>
    <text x="1060" y="33" class="micro">SIGNAL ONLINE</text>

    <rect x="30" y="74" width="490" height="458" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
    <rect x="48" y="92" width="454" height="414" rx="10" fill="${palette.surfaceAlt}"/>
    <rect x="48" y="92" width="454" height="414" rx="10" fill="url(#grid)"/>
    <g class="portraitSignal">
      ${avatarData ? `<image href="${avatarData}" x="48" y="70" width="454" height="454" preserveAspectRatio="xMidYMid slice" clip-path="url(#portrait-clip)" mask="url(#portrait-mask)" filter="url(#portrait-tone)" opacity="${mode === "dark" ? ".88" : ".72"}"/>` : ""}
      <rect x="48" y="92" width="454" height="414" rx="10" fill="url(#scanlines)" opacity="${mode === "dark" ? ".32" : ".18"}" clip-path="url(#portrait-clip)"/>
    </g>
    <rect x="48" y="101" width="454" height="7" fill="${palette.scan}" opacity="0" class="scanSweep" clip-path="url(#portrait-clip)" filter="url(#soft-glow)"/>
    <path d="M70 116h42M70 116v42M480 116h-42M480 116v42M70 482h42M70 482v-42M480 482h-42M480 482v-42" fill="none" stroke="${palette.accent}" stroke-width="2" opacity=".72" filter="url(#soft-glow)"/>
    <line x1="67" y1="306" x2="483" y2="306" stroke="${palette.scan}" stroke-width="2" opacity=".68" filter="url(#soft-glow)"/>
    <rect x="68" y="398" width="414" height="88" rx="7" fill="${palette.bg}" opacity=".86" stroke="${palette.border}"/>
    <text x="88" y="430" class="portraitName">Tanvir Aditya Bayi</text>
    <text x="88" y="454" class="portraitRole">SPYLEAN / CREATIVE × TECHNOLOGY</text>
    <text x="88" y="476" class="micro">FOUNDER · BUILDER · CREATIVE DIRECTOR</text>

    <rect x="536" y="74" width="634" height="458" rx="12" fill="${palette.surface}" stroke="${palette.border}"/>
    <rect x="548" y="120" width="2" height="286" fill="${palette.accent}" opacity="0" class="registrySweep" clip-path="url(#registry-clip)" filter="url(#soft-glow)"/>
    <text x="558" y="108" class="eyebrow">SYSTEM.INFO / PROFILE RESOURCE</text>
    <line x1="548" y1="119" x2="1143" y2="119" class="hairline"/>
    ${info}
    <text x="558" y="394" class="eyebrow">BUILD.ENGINE / OPERATING RANGE</text>
    <line x1="548" y1="405" x2="1143" y2="405" class="hairline"/>
    ${engine}

    <rect x="30" y="548" width="1140" height="54" rx="8" fill="${palette.surface}" stroke="${palette.border}"/>
    ${buildRows}
  </svg>`;
}

function lightMetricSvg(darkSvg) {
  const replacements = [
    ["#0d1117", "#ffffff"],
    ["#161b22", "#f6f8fa"],
    ["#30363d", "#d0d7de"],
    ["#f0f6fc", "#1f2328"],
    ["#c9d1d9", "#24292f"],
    ["#8b949e", "#57606a"],
    ["#6e7681", "#6e7781"],
    ["#58a6ff", "#0969da"],
    ["#3fb950", "#1a7f37"],
    ["#21262d", "#ebedf0"],
    ["#0e4429", "#aceebb"],
    ["#006d32", "#4ac26b"],
    ["#26a641", "#2da44e"],
    ["#39d353", "#116329"],
  ];
  return replacements.reduce((output, [from, to]) => output.replaceAll(from, to), darkSvg);
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

const systemDark = systemProfileSvg(systemPalettes.dark, profile, avatar, "dark");
const systemLight = systemProfileSvg(systemPalettes.light, profile, avatar, "light");
const metricsLight = lightMetricSvg(svg);

await Promise.all([
  writeFile("spylean-system-dark.svg", systemDark),
  writeFile("spylean-system-light.svg", systemLight),
  writeFile("spylean-live-metrics-dark.svg", svg),
  writeFile("spylean-live-metrics-light.svg", metricsLight),
]);

console.log(`Generated adaptive SPYLEAN identity system and build graph for ${profile.login}`);
