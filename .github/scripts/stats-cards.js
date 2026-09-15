#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════
 * 📊 GitHub 数据卡片生成器（Tokyo Night 专属配色）
 * ═══════════════════════════════════════════════════════════
 * 生成三套卡片 SVG（各含浅色 + 深色版），与贪吃蛇、活跃度折线图
 * 一起由 .github/workflows/snake.yml 调用，推送到 output 分支：
 *   ① github-stats  数据总览卡（提交 / 星标 / PR / Issue / 关注者）
 *   ② top-langs     语言分布卡（用 GitHub 官方语言配色）
 *   ③ trophy        成就奖牌条（按真实数据自动评 S/A/B/C 级）
 *
 * 为什么不用 github-readme-stats / github-profile-trophy？
 *   两者的公共 Vercel 实例长期限流、经常整站不可用——
 *   自己生成 = 永不失效、无限流、配色完全自主。
 *
 * 数据来源：GitHub GraphQL API（仓库统计 + 关注者等）
 * 认证方式：Action 自带的 GITHUB_TOKEN（无需任何额外配置）
 *
 * 想换配色：只改下方 THEMES 中的色值即可
 * ═══════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");

const OUT_DIR = process.argv[2] || "dist";
const API_URL = process.env.GITHUB_API_URL || "https://api.github.com";
const MAX_REPO_PAGES = 10; // 防御性上限：最多统计 1000 个仓库

// ─── Tokyo Night 配色（与整套 Profile 统一）─────────────────
const THEMES = {
  dark: {
    bg: "#1a1b27",       // 卡片底色
    title: "#a9b1d6",    // 标题文字
    text: "#c0caf5",     // 正文 / 数值
    axis: "#565f89",     // 次要文字
    grid: "#292e42",     // 分隔线
    icon: "#7aa2f7",     // 图标（主题蓝）
    rankS: ["#7dcfff", "#7aa2f7", "#bb9af7"], // S 级：蓝紫青渐变
    rankA: "#e0af68",    // A 级：金色
    rankB: "#7dcfff",    // B 级：青色
    rankC: "#565f89",    // C 级：灰蓝
  },
  light: {
    bg: "#ffffff",
    title: "#24283b",
    text: "#343a50",
    axis: "#8999b8",
    grid: "#e9eaf0",
    icon: "#7aa2f7",
    rankS: ["#7dcfff", "#7aa2f7", "#bb9af7"],
    rankA: "#e0af68",
    rankB: "#4ba6cc",
    rankC: "#8999b8",
  },
};

const FONT =
  "ui-sans-serif, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', sans-serif";

// ─── 数据拉取（GraphQL，自动翻页）───────────────────────────
async function gql(query, variables) {
  if (!process.env.GITHUB_TOKEN) throw new Error("缺少环境变量 GITHUB_TOKEN");
  const res = await fetch(`${API_URL}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-cards",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}: ${await res.text()}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`GraphQL 错误: ${JSON.stringify(errors)}`);
  return data;
}

async function fetchStats(owner) {
  const s = { followers: 0, issues: 0, prs: 0, stars: 0, commits: 0, langs: new Map() };
  let cursor = null, pages = 0;

  do {
    // 首页顺带取基础统计；翻页时只取仓库列表，减少响应体积
    const core = pages === 0
      ? `followers { totalCount }
         issues { totalCount }
         pullRequests(states: MERGED) { totalCount }`
      : "";
    const query = `query($login: String!, $cursor: String) {
      user(login: $login) {
        ${core}
        repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false,
                     orderBy: {field: STARGAZERS, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            stargazerCount
            defaultBranchRef { target { ... on Commit { history { totalCount } } } }
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges { size node { name color } }
            }
          }
        }
      }
    }`;
    const data = await gql(query, { login: owner, cursor });
    if (!data.user) throw new Error(`用户 ${owner} 不存在（或 token 无权限）`);
    if (pages === 0) {
      s.followers = data.user.followers.totalCount;
      s.issues = data.user.issues.totalCount;
      s.prs = data.user.pullRequests.totalCount;
    }
    for (const repo of data.user.repositories.nodes) {
      s.stars += repo.stargazerCount;
      const commits = repo.defaultBranchRef?.target?.history?.totalCount;
      if (commits) s.commits += commits;
      for (const e of repo.languages?.edges ?? []) {
        const cur = s.langs.get(e.node.name) || { size: 0, color: e.node.color };
        cur.size += e.size;
        s.langs.set(e.node.name, cur);
      }
    }
    cursor = data.user.repositories.pageInfo.hasNextPage
      ? data.user.repositories.pageInfo.endCursor
      : null;
    pages++;
  } while (cursor && pages < MAX_REPO_PAGES);

  return s;
}

// ─── 工具函数 ────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");
const fmtC = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "K" : fmt(n);

// ─── 矢量小图标（线条风，随主题换色）────────────────────────
const ICONS = {
  // ●──● git 提交
  commits: (cx, cy, c) =>
    `<line x1="${cx - 11}" y1="${cy}" x2="${cx - 5}" y2="${cy}" stroke="${c}" stroke-width="2" stroke-linecap="round"/>` +
    `<line x1="${cx + 5}" y1="${cy}" x2="${cx + 11}" y2="${cy}" stroke="${c}" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="${cx}" cy="${cy}" r="3.6" fill="${c}"/>`,
  // ★ 星标
  stars: (cx, cy, c) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = ((-90 + i * 36) * Math.PI) / 180;
      const r = i % 2 === 0 ? 11 : 4.6;
      pts.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1));
    }
    return `<polygon points="${pts.join(" ")}" fill="${c}"/>`;
  },
  // PR 合并：两个分支节点 + 上行箭头
  prs: (cx, cy, c) => {
    const s = `stroke="${c}" stroke-width="2" stroke-linecap="round" fill="none"`;
    return `<circle cx="${cx - 8}" cy="${cy + 8}" r="3" fill="${c}"/>` +
      `<circle cx="${cx + 8}" cy="${cy + 8}" r="3" ${s}/>` +
      `<path d="M ${cx - 8} ${cy + 4} V ${cy - 3} q 0 -6 6 -6 h 3" ${s}/>` +
      `<path d="M ${cx - 1.5} ${cy - 14} l 5 4 -5 4" ${s}/>`;
  },
  // ◉ 打开的 Issue
  issues: (cx, cy, c) =>
    `<circle cx="${cx}" cy="${cy}" r="9.5" fill="none" stroke="${c}" stroke-width="2"/>` +
    `<circle cx="${cx}" cy="${cy}" r="2.4" fill="${c}"/>`,
  // 人形 关注者
  followers: (cx, cy, c) => {
    const s = `stroke="${c}" stroke-width="2" stroke-linecap="round" fill="none"`;
    return `<circle cx="${cx}" cy="${cy - 5.5}" r="4.2" ${s}/>` +
      `<path d="M ${cx - 9} ${cy + 10} a 9 9 0 0 1 18 0" ${s}/>`;
  },
};

// ─── 卡片一：数据总览（495×195，与连胜卡片等高）──────────────
function statsCard(t, owner, s) {
  const W = 495, H = 195;
  const items = [
    ["commits", "Total Commits", s.commits],
    ["stars", "Total Stars", s.stars],
    ["prs", "PRs Merged", s.prs],
    ["issues", "Issues Opened", s.issues],
    ["followers", "Followers", s.followers],
  ];
  const colW = (W - 48) / items.length;
  const body = items.map(([icon, label, v], i) => {
    const cx = (24 + colW * (i + 0.5)).toFixed(1);
    return ICONS[icon](+cx, 84, t.icon) +
      `<text x="${cx}" y="133" text-anchor="middle" font-size="16.5" font-weight="700" fill="${t.text}" font-family="${FONT}">${fmt(v)}</text>` +
      `<text x="${cx}" y="154" text-anchor="middle" font-size="10.5" fill="${t.axis}" font-family="${FONT}">${label}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
<desc>${esc(owner)} 的 GitHub 数据总览</desc>
<rect width="${W}" height="${H}" rx="6" fill="${t.bg}"/>
<text x="24" y="33" font-size="15" font-weight="700" fill="${t.title}" font-family="${FONT}">${esc(owner)} · GitHub Stats</text>
<line x1="24" y1="50" x2="${W - 24}" y2="50" stroke="${t.grid}" stroke-width="1"/>
${body}
</svg>`;
}

// ─── 卡片二：语言分布（颜色用 GitHub 官方语言色）────────────
function langsCard(t, langs) {
  const W = 495, H = 195;
  const top = [...langs.entries()]
    .map(([name, v]) => ({ name, size: v.size, color: v.color }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  const sum = top.reduce((a, l) => a + l.size, 0);

  let inner;
  if (!top.length) {
    inner = `<text x="${W / 2}" y="120" text-anchor="middle" font-size="13" fill="${t.axis}" font-family="${FONT}">No public repositories yet</text>`;
  } else {
    // 顶部堆叠比例条（圆角裁剪）
    let bar = "", x = 24;
    for (const l of top) {
      const w = (l.size / sum) * (W - 48);
      if (w < 1) continue;
      bar += `<rect x="${x.toFixed(1)}" y="68" width="${Math.min(w, W - 24 - x).toFixed(1)}" height="12" fill="${l.color || t.icon}"/>`;
      x += w;
    }
    // 双列图例：圆点 + 语言名 + 占比
    let legend = "";
    top.forEach((l, i) => {
      const lx = i % 2 === 0 ? 24 : 252;
      const ly = 104 + Math.floor(i / 2) * 25;
      const pct = (l.size / sum) * 100;
      const ps = pct >= 9.95 ? Math.round(pct) + "%" : pct.toFixed(1) + "%";
      legend += `<circle cx="${lx + 4.5}" cy="${ly - 4}" r="4" fill="${l.color || t.icon}"/>` +
        `<text x="${lx + 15}" y="${ly}" font-size="11.5" fill="${t.text}" font-family="${FONT}">${esc(l.name)}</text>` +
        `<text x="${lx + 209}" y="${ly}" text-anchor="end" font-size="11.5" fill="${t.axis}" font-family="${FONT}">${ps}</text>`;
    });
    inner = `<g clip-path="url(#barclip)">${bar}</g>${legend}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
<desc>最常用的编程语言分布</desc>
<defs><clipPath id="barclip"><rect x="24" y="68" width="${W - 48}" height="12" rx="6"/></clipPath></defs>
<rect width="${W}" height="${H}" rx="6" fill="${t.bg}"/>
<text x="24" y="33" font-size="15" font-weight="700" fill="${t.title}" font-family="${FONT}">Most Used Languages</text>
<line x1="24" y1="50" x2="${W - 24}" y2="50" stroke="${t.grid}" stroke-width="1"/>
${inner}
</svg>`;
}

// ─── 卡片三：成就奖牌条（S/A/B/C 自动评级）──────────────────
const TROPHIES = [
  { key: "stars",    label: "Starstruck",    unit: "stars",    th: [1000, 200, 50] },
  { key: "commits",  label: "Commit Machine", unit: "commits", th: [2000, 500, 100] },
  { key: "prs",      label: "Pull Shark",    unit: "PRs merged", th: [200, 50, 10] },
  { key: "issues",   label: "Bug Hunter",    unit: "issues",   th: [200, 50, 10] },
  { key: "followers", label: "Crowd Favorite", unit: "followers", th: [500, 100, 20] },
];

function trophyCard(t, s) {
  const W = 990, H = 170;
  const colW = W / TROPHIES.length;
  let defs = "", medals = "";

  TROPHIES.forEach((tr, i) => {
    const cx = colW * (i + 0.5);
    const v = s[tr.key];
    const rank = v >= tr.th[0] ? "S" : v >= tr.th[1] ? "A" : v >= tr.th[2] ? "B" : "C";
    let ring, letter;
    if (rank === "S") {
      // S 级：蓝→紫→青 渐变奖环
      defs += `<linearGradient id="gradS${i}" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${t.rankS[0]}"/><stop offset="0.5" stop-color="${t.rankS[1]}"/>` +
        `<stop offset="1" stop-color="${t.rankS[2]}"/></linearGradient>`;
      ring = `url(#gradS${i})`;
      letter = t.rankS[1];
    } else {
      ring = letter = t["rank" + rank];
    }
    medals +=
      `<circle cx="${cx}" cy="62" r="30" fill="none" stroke="${ring}" stroke-width="3.5"/>` +
      `<text x="${cx}" y="70" text-anchor="middle" font-size="23" font-weight="800" fill="${letter}" font-family="${FONT}">${rank}</text>` +
      `<text x="${cx}" y="120" text-anchor="middle" font-size="13" font-weight="600" fill="${t.title}" font-family="${FONT}">${esc(tr.label)}</text>` +
      `<text x="${cx}" y="140" text-anchor="middle" font-size="11.5" fill="${t.axis}" font-family="${FONT}">${esc(fmtC(v) + " " + tr.unit)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
<desc>GitHub 成就奖牌：按星标、提交、PR、Issue、关注者评级</desc>
<defs>${defs}</defs>
<rect width="${W}" height="${H}" rx="6" fill="${t.bg}"/>
${medals}
</svg>`;
}

// ─── 主流程 ──────────────────────────────────────────────────
(async () => {
  const owner =
    process.env.OWNER ||
    (process.env.GITHUB_REPOSITORY || "").split("/")[0];
  if (!owner) throw new Error("无法确定用户名：请设置 OWNER 或 GITHUB_REPOSITORY");

  const s = await fetchStats(owner);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cards = [
    ["github-stats", (t) => statsCard(t, owner, s)],
    ["top-langs", (t) => langsCard(t, s.langs)],
    ["trophy", (t) => trophyCard(t, s)],
  ];
  for (const [name, fn] of cards) {
    fs.writeFileSync(path.join(OUT_DIR, `${name}.svg`), fn(THEMES.light));
    fs.writeFileSync(path.join(OUT_DIR, `${name}-dark.svg`), fn(THEMES.dark));
  }

  console.log(`✅ 数据卡片已生成：Stats / 语言分布 / 成就奖牌` +
    `（commits ${s.commits} · stars ${s.stars} · PRs ${s.prs} · repos ${s.langs.size} 种语言）`);
})().catch((e) => {
  console.error("❌ 生成失败:", e.message);
  process.exit(1);
});
