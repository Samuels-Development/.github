// Draws the org's profile page from what GitHub says about its public repos: the banner, the buttons, the stat
// tiles, the commit heatmap, downloads by resource, stars over time and a card for each featured resource, into
// profile/assets/, and the parts of profile/README.md between <!-- name:start --> and <!-- name:end -->.
//
// .github/workflows/profile.yml runs it every day. To run it here: GITHUB_TOKEN=$(gh auth token) node scripts/profile/build.mjs
//
// The pictures carry their own fonts (Inter, Manrope and JetBrains Mono, cut down by Google Fonts to the letters
// each one uses), because GitHub shows them as images and an image can't load a font from anywhere else. Without a
// connection to Google Fonts they fall back to the reader's system fonts.
import { readFile, writeFile } from 'node:fs/promises';

const ORG = process.env.ORG ?? 'Samuels-Development';
const TOKEN = process.env.GITHUB_TOKEN;
const ROOT = new URL('../../', import.meta.url);
const ASSETS = new URL('profile/assets/', ROOT);
const README = new URL('profile/README.md', ROOT);

// The cards, in order. A blurb stands in for the repo's own description.
const FEATURED = [
    {
        name: 'sd-phone',
        blurb: 'A phone for Qbox, QBCore, ESX, ox_core and ND: calls, messages, mail, maps, banking, social apps and games. Scripts written for lb-phone and the rest keep working.',
    },
    { name: 'sd-tablet' },
    { name: 'sd-computers' },
    {
        name: 'sd_lib',
        blurb: 'The library under the rest: better base natives, and one way to talk to every framework and the popular resources around them.',
    },
    {
        name: 'sd-policeradar',
        blurb: 'A police radar: speeds in MPH and KMH and plates, ahead and behind. Lock it, keep a log of what it caught, and set BOLOs.',
    },
    {
        name: 'sd-zonecreator',
        blurb: 'Draw zones on an interactive map with a live 3D preview in the game, and export them in the format your script wants.',
    },
];

// Repos that aren't resources.
const HIDDEN = new Set(['.github', 'docs']);

const SURFACE = '#1b1e2e';
const PANEL = '#20243a';
const LINE = '#2c3149';
const INK = '#eef0f6';
const INK2 = '#a9aec4';
const INK3 = '#8088a3';
const YELLOW = '#f0e155';
const CYAN = '#94f4f0';
const OTHER = '#4d5473';

// GitHub's language colours, with Lua lifted off navy so it shows on the dark cards.
const LANGUAGES = {
    Lua: '#7b8cff',
    TypeScript: '#3178c6',
    JavaScript: '#f1e05a',
    Svelte: '#ff3e00',
    HTML: '#e34c26',
    MDX: '#fcb32c',
};

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------------------------------------------
// GitHub

async function api(path, accept = 'application/vnd.github+json') {
    const headers = { accept, 'user-agent': ORG, 'x-github-api-version': '2022-11-28' };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

    const res = await fetch(new URL(path, 'https://api.github.com/'), { headers });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);

    return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function pages(path, accept) {
    const out = [];

    for (let page = 1; ; page++) {
        const { body } = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, accept);
        out.push(...body);
        if (body.length < 100) return out;
    }
}

async function each(items, limit, fn) {
    const out = [];
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    };

    await Promise.all(Array.from({ length: limit }, worker));
    return out;
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

// GitHub works commit activity out on the first ask and answers 202 until it has it, so ask every repo, then ask
// again for the ones that weren't ready.
async function activity(repos) {
    const weeks = new Map();
    let waiting = repos;

    for (let round = 0; waiting.length && round < 10; round++) {
        if (round) await sleep(3000);
        const later = [];

        await each(waiting, 6, async repo => {
            const { status, body } = await api(`repos/${ORG}/${repo.name}/stats/commit_activity`);
            if (status === 202) return later.push(repo);

            for (const { week, days } of body ?? []) {
                const row = weeks.get(week) ?? [0, 0, 0, 0, 0, 0, 0];
                days.forEach((n, i) => (row[i] += n));
                weeks.set(week, row);
            }
        });

        waiting = later;
    }

    if (waiting.length) console.warn(`no commit activity yet for ${waiting.map(r => r.name).join(', ')}`);

    // The 52 weeks to this one, each from its Sunday. A repo nobody has pushed to in a while can answer with the
    // weeks GitHub last worked out for it, a year or more back: those fall outside and are left out.
    const now = new Date();
    const sunday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay());

    return Array.from({ length: 52 }, (_, i) => {
        const start = sunday - (51 - i) * 7 * DAY;
        return { start, days: weeks.get(start / 1000) ?? [0, 0, 0, 0, 0, 0, 0] };
    });
}

async function gather() {
    const org = (await api(`orgs/${ORG}`)).body;
    const listed = await pages(`orgs/${ORG}/repos?type=public`);
    const repos = listed.filter(r => !r.private && !r.fork && !HIDDEN.has(r.name));

    await each(repos, 6, async repo => {
        const releases = await pages(`repos/${ORG}/${repo.name}/releases`);
        repo.downloads = releases.flatMap(r => r.assets).reduce((n, a) => n + a.download_count, 0);
        repo.release = releases.find(r => !r.draft && !r.prerelease)?.tag_name;

        repo.starred = [];
        if (repo.stargazers_count === 0) return;

        const stars = await pages(`repos/${ORG}/${repo.name}/stargazers`, 'application/vnd.github.star+json');
        repo.starred = stars.map(s => Date.parse(s.starred_at));
    });

    const avatar = await fetch(`${org.avatar_url}&s=400`).then(r => r.arrayBuffer());

    return {
        org,
        repos,
        live: repos.filter(r => !r.archived),
        weeks: await activity(repos),
        avatar: `data:image/png;base64,${Buffer.from(avatar).toString('base64')}`,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Text

const METRICS = JSON.parse(await readFile(new URL('metrics.json', import.meta.url), 'utf8'));

// How wide a string sets, from the fonts' own advance widths (metrics.json). Close enough to lay text out by; a
// letter the table doesn't have counts as 0.62 em.
function measure(s, size, weight = 400, face = 'inter') {
    if (face === 'mono') return [...s].length * size * 0.6;

    const table = METRICS.width[face === 'manrope' ? 'manrope800' : `inter${weight}`];
    let width = 0;

    for (const ch of s) {
        const i = METRICS.chars.indexOf(ch);
        width += i < 0 ? 620 : table[i];
    }

    return (width * size) / 1000;
}

function clip(s, size, max, weight) {
    if (measure(s, size, weight) <= max) return s;
    while (s && measure(`${s}…`, size, weight) > max) s = s.slice(0, -1);
    return `${s.trimEnd().replace(/[,.;:]$/, '')}…`;
}

function wrap(s, size, max, lines) {
    const out = [''];

    for (const word of s.split(/\s+/).filter(Boolean)) {
        const line = out.at(-1);
        const next = line ? `${line} ${word}` : word;

        if (measure(next, size) <= max) {
            out[out.length - 1] = next;
            continue;
        }

        if (out.length === lines) {
            out[out.length - 1] = clip(next, size, max);
            return out;
        }

        out.push(word);
    }

    return out;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const r = n => Math.round(n * 10) / 10;

function text(x, y, s, { size = 13, weight = 400, fill = INK, anchor, cls, spacing } = {}) {
    let attrs = `x="${r(x)}" y="${r(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}"`;
    if (anchor) attrs += ` text-anchor="${anchor}"`;
    if (cls) attrs += ` class="${cls}"`;
    if (spacing) attrs += ` letter-spacing="${spacing}"`;

    return `<text ${attrs}>${esc(s)}</text>`;
}

const full = n => n.toLocaleString('en-US');

function compact(n) {
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e5 ? 1 : 0).replace(/\.0$/, '')}K`;
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

// ---------------------------------------------------------------------------------------------------------------
// Fonts

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FAMILIES = { inter: 'Inter:wght@400;500;600;700', manrope: 'Manrope:wght@800', mono: 'JetBrains+Mono:wght@500' };
const FONTS = new Map();

const CSS =
    "text{font-family:Inter,'Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-optical-sizing:none}" +
    ".d{font-family:Manrope,Inter,'Segoe UI',sans-serif}" +
    ".m{font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,monospace}";

async function fontFaces(faces, chars) {
    try {
        const query = faces.map(f => `family=${FAMILIES[f]}`).join('&');
        const res = await fetch(`https://fonts.googleapis.com/css2?${query}&text=${encodeURIComponent(chars)}`, {
            headers: { 'user-agent': UA },
        });
        if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`);

        // One file can serve several weights (Inter is variable): give it the whole range once.
        const files = new Map();
        for (const [, block] of (await res.text()).matchAll(/@font-face\s*{([^}]*)}/g)) {
            const url = block.match(/url\(([^)]+)\)/)[1];
            const file = files.get(url) ?? { family: block.match(/font-family:\s*'([^']+)'/)[1], weights: [] };
            file.weights.push(Number(block.match(/font-weight:\s*(\d+)/)[1]));
            files.set(url, file);
        }

        let css = '';
        for (const [url, { family, weights }] of files) {
            if (!FONTS.has(url)) FONTS.set(url, Buffer.from(await (await fetch(url)).arrayBuffer()).toString('base64'));
            const weight = `${Math.min(...weights)} ${Math.max(...weights)}`;
            css += `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${FONTS.get(url)}) format('woff2')}`;
        }

        return css;
    } catch (err) {
        console.warn(`fonts not embedded: ${err.message}`);
        return '';
    }
}

async function draw(file, width, height, label, body, faces = ['inter']) {
    const chars = [...new Set(unesc(body.replace(/<[^>]*>/g, '')).replace(/\s/g, ''))].join('') + ' ';
    const css = await fontFaces(faces, chars);
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">` +
        `<title>${esc(label)}</title><style>${css}${CSS}</style>${body}</svg>\n`;

    await writeFile(new URL(file, ASSETS), svg);
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces

// A card: the panel every picture below the banner sits on.
const card = (w, h) => `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="12" fill="${SURFACE}" stroke="${LINE}"/>`;

// A chart's title on the left and its headline on the right.
function heading(w, title, note) {
    return text(24, 36, title, { size: 15, weight: 600 }) + text(w - 24, 36, note, { size: 13, fill: INK2, anchor: 'end' });
}

// A bar from the baseline at x, rounded only at its end.
function bar(x, y, w, h, fill) {
    if (w < 4) return `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(w, 1))}" height="${h}" fill="${fill}"/>`;
    return `<path d="M${r(x)} ${r(y)}h${r(w - 4)}a4 4 0 0 1 4 4v${h - 8}a4 4 0 0 1-4 4h${r(-(w - 4))}z" fill="${fill}"/>`;
}

function niceStep(max, count) {
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

const mix = (a, b, t) => {
    const ch = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
    const out = [0, 1, 2].map(i => Math.round(ch(b, i) + (ch(a, i) - ch(b, i)) * t));
    return `#${out.map(n => n.toString(16).padStart(2, '0')).join('')}`;
};

// Small line icons on a 16 grid, drawn in the stroke colour they're given.
const ICONS = {
    repo: 'M3 2.5h8.5a1 1 0 0 1 1 1V13H4.5A1.5 1.5 0 0 1 3 11.5v-9zM3 11.5A1.5 1.5 0 0 1 4.5 10h8',
    star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z',
    fork: 'M4.5 2.5v2.2a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V2.5M8 6.7v6.8',
    download: 'M8 2v8M4.6 6.8 8 10.2l3.4-3.4M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5',
};

function icon(name, x, y, colour) {
    const extra = name === 'fork' ? `<circle cx="4.5" cy="2.5" r="1.5"/><circle cx="11.5" cy="2.5" r="1.5"/><circle cx="8" cy="13.5" r="1.5"/>` : '';
    return (
        `<g transform="translate(${r(x)} ${r(y)})" fill="none" stroke="${colour}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="${ICONS[name]}"/>${extra}</g>`
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The banner

async function banner(avatar) {
    const W = 1280;
    const H = 340;
    const X = 300;

    const pills = ['Qbox', 'QBCore', 'ESX', 'ox_core', 'ND'];
    let px = X + measure('Works with', 14, 500) + 14;
    let pillMarks = text(X, 285, 'Works with', { size: 14, weight: 500, fill: INK3 });
    for (const name of pills) {
        const w = measure(name, 13, 500) + 24;
        pillMarks += `<rect x="${r(px)}" y="265" width="${r(w)}" height="28" rx="14" fill="${PANEL}" stroke="${LINE}"/>`;
        pillMarks += text(px + w / 2, 284, name, { size: 13, weight: 500, fill: INK2, anchor: 'middle' });
        px += w + 8;
    }

    // The logo's two strokes, as big arcs off the right-hand edge.
    const arc = (cx, cy, radius, from, to) => {
        const p = a => [cx + radius * Math.cos((a * Math.PI) / 180), cy + radius * Math.sin((a * Math.PI) / 180)];
        const [x1, y1] = p(from);
        const [x2, y2] = p(to);
        return `M${r(x1)} ${r(y1)}A${radius} ${radius} 0 0 0 ${r(x2)} ${r(y2)}`;
    };

    const body =
        `<defs>` +
        `<clipPath id="c"><rect width="${W}" height="${H}" rx="16"/></clipPath>` +
        `<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.3" fill="${CYAN}"/></pattern>` +
        `<linearGradient id="fade" x1="0" x2="1"><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".22"/></linearGradient>` +
        `<mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>` +
        `<linearGradient id="edge" x1="0" x2="1"><stop offset="0" stop-color="${YELLOW}"/><stop offset="1" stop-color="${CYAN}"/></linearGradient>` +
        `<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
        `</defs>` +
        `<g clip-path="url(#c)">` +
        `<rect width="${W}" height="${H}" fill="${SURFACE}"/>` +
        `<rect width="${W}" height="${H}" fill="url(#dots)" mask="url(#m)"/>` +
        `<g fill="none" stroke-linecap="round" filter="url(#glow)">` +
        `<path d="${arc(1330, 170, 230, 255, 105)}" stroke="${CYAN}" stroke-width="9" opacity=".85"/>` +
        `<path d="${arc(1330, 170, 160, 235, 150)}" stroke="${YELLOW}" stroke-width="9" opacity=".85"/>` +
        `</g>` +
        `<rect y="${H - 4}" width="${W}" height="4" fill="url(#edge)"/>` +
        `</g>` +
        `<image href="${avatar}" x="62" y="70" width="200" height="200"/>` +
        text(X + 2, 120, 'OPEN-SOURCE FIVEM RESOURCES', { size: 14, weight: 600, fill: CYAN, spacing: 2.6 }) +
        text(X, 186, "Samuel's Development", { size: 58, weight: 800, cls: 'd' }) +
        text(X + 2, 230, 'Phones, tablets, computers, jobs and the tools to build them.', { size: 21, fill: INK2 }) +
        pillMarks;

    await draw('banner.svg', W, H, "Samuel's Development: open-source FiveM resources", body, ['inter', 'manrope']);
}

// ---------------------------------------------------------------------------------------------------------------
// The buttons

const BUTTON_ICONS = {
    store: '<path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8zM9 8V7a3 3 0 0 1 6 0v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    docs: '<path d="M12 6.5C10.5 5.3 8.3 4.8 4 5v13c4.3-.2 6.5.3 8 1.5 1.5-1.2 3.7-1.7 8-1.5V5c-4.3-.2-6.5.3-8 1.5zM12 6.5v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    discord:
        '<path fill="currentColor" d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a18.27 18.27 0 0 0-5.49 0 12.64 12.64 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1-.01.13 12.3 12.3 0 0 1-1.87.89.08.08 0 0 0-.04.11c.36.7.77 1.36 1.23 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z"/>',
    demo: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 8.6v6.8l5.4-3.4z" fill="currentColor"/>',
};

const BUTTONS = [
    { file: 'button-store.svg', label: 'Store', icon: 'store', primary: true },
    { file: 'button-docs.svg', label: 'Documentation', icon: 'docs' },
    { file: 'button-discord.svg', label: 'Discord', icon: 'discord' },
    { file: 'button-demo.svg', label: 'Live demo', icon: 'demo' },
];

async function buttons() {
    for (const { file, label, icon: glyph, primary } of BUTTONS) {
        const H = 44;
        const W = Math.ceil(16 + 20 + 10 + measure(label, 15, 600) + 20);
        const fg = primary ? '#15171f' : INK;
        const mark = primary ? '#15171f' : CYAN;

        const body =
            (primary
                ? `<rect width="${W}" height="${H}" rx="10" fill="${YELLOW}"/>`
                : `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="10" fill="${SURFACE}" stroke="${LINE}"/>`) +
            `<g transform="translate(16 12) scale(.8333)" color="${mark}">${BUTTON_ICONS[glyph]}</g>` +
            text(46, 27.5, label, { size: 15, weight: 600, fill: fg });

        await draw(file, W, H, label, body);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The stat tiles

function sparkline(points, x, y, w, h) {
    const max = Math.max(...points, 1);
    const at = (v, i) => [x + (i * w) / (points.length - 1), y + h - (v / max) * h];
    const line = points.map((v, i) => at(v, i).map(r).join(' ')).join('L');
    const [ex, ey] = at(points.at(-1), points.length - 1);

    return (
        `<path d="M${line}" fill="none" stroke="${INK3}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<circle cx="${r(ex)}" cy="${r(ey)}" r="3.5" fill="${YELLOW}" stroke="${SURFACE}" stroke-width="2"/>`
    );
}

async function stats({ org, repos, live, weeks }) {
    const W = 880;
    const H = 120;
    const GAP = 10;
    const tw = (W - GAP * 4) / 5;

    const downloads = repos.reduce((n, r) => n + r.downloads, 0);
    const starred = repos.flatMap(r => r.starred);
    const commits = weeks.reduce((n, w) => n + w.days.reduce((a, b) => a + b, 0), 0);

    // New stars in each of the last 12 calendar months, this one last.
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, i) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
    const perMonth = months.map((start, i) => starred.filter(t => t >= start && t < (months[i + 1] ?? Infinity)).length);
    const thisYear = perMonth.reduce((a, b) => a + b, 0);

    // Commits in each 4-week stretch of the last 52 weeks.
    const perStretch = Array.from({ length: 13 }, (_, i) =>
        weeks.slice(i * 4, i * 4 + 4).reduce((n, w) => n + w.days.reduce((a, b) => a + b, 0), 0),
    );

    const tiles = [
        { label: 'Downloads', value: downloads, note: 'from every release' },
        { label: 'Stars', value: starred.length, note: `+${full(thisYear)} in 12 months`, trend: perMonth },
        { label: 'Commits', value: commits, note: 'in the last 12 months', trend: perStretch },
        { label: 'Resources', value: live.length, note: 'open source' },
        { label: 'Followers', value: org.followers, note: 'on GitHub' },
    ];

    let body = '';
    tiles.forEach(({ label, value, note, trend }, i) => {
        const x = i * (tw + GAP);
        const shown = value < 1e5 ? full(value) : compact(value);

        body += `<rect x="${r(x + 0.5)}" y=".5" width="${r(tw - 1)}" height="${H - 1}" rx="12" fill="${SURFACE}" stroke="${LINE}"/>`;
        body += text(x + 18, 32, label, { size: 13, weight: 500, fill: INK2 });
        body += text(x + 18, 74, shown, { size: 30, weight: 600 });
        body += text(x + 18, 100, clip(note, 12, tw - 30), { size: 12, fill: INK3 });

        // The trend sits in the corner, level with the label, out of the number's way.
        if (trend) body += sparkline(trend, x + tw - 18 - 58, 18, 58, 16);
    });

    const label =
        `${full(downloads)} downloads, ${full(starred.length)} stars, ${full(commits)} commits in the last 12 months, ` +
        `${live.length} open-source resources, ${full(org.followers)} followers`;

    await draw('stats.svg', W, H, label, body);
    return { downloads, stars: starred.length, commits, label };
}

// ---------------------------------------------------------------------------------------------------------------
// The commit heatmap

async function heatmap({ repos, weeks }) {
    const W = 880;
    const CELL = 12;
    const STEP = 15;
    const X0 = 60;
    const Y0 = 74;
    const H = Y0 + STEP * 7 + 44;

    const today = Date.now();
    const counts = weeks.flatMap(w => w.days).filter(n => n > 0).sort((a, b) => a - b);
    const total = counts.reduce((a, b) => a + b, 0);
    const q = f => counts[Math.floor((counts.length - 1) * f)] ?? 1;
    const cuts = [q(0.25), q(0.5), q(0.75)];

    // One hue, darker for fewer: the cyan from the logo let down into the card.
    const ramp = ['#262b42', mix(CYAN, SURFACE, 0.3), mix(CYAN, SURFACE, 0.5), mix(CYAN, SURFACE, 0.75), CYAN];
    const level = n => (n === 0 ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4);

    let body = card(W, H) + heading(W, 'Commits', `${full(total)} in the last 12 months`);
    let lastLabel = -4;

    weeks.forEach(({ start, days }, col) => {
        const x = X0 + col * STEP;
        const month = new Date(start + 6 * DAY).getUTCMonth();
        const prev = col && new Date(weeks[col - 1].start + 6 * DAY).getUTCMonth();

        if ((col === 0 || month !== prev) && col - lastLabel >= 3 && col < weeks.length - 1) {
            body += text(x, Y0 - 10, MONTHS[month], { size: 11, fill: INK3 });
            lastLabel = col;
        }

        days.forEach((n, row) => {
            if (start + row * DAY > today) return;
            body += `<rect x="${x}" y="${Y0 + row * STEP}" width="${CELL}" height="${CELL}" rx="2.5" fill="${ramp[level(n)]}"/>`;
        });
    });

    ['Mon', 'Wed', 'Fri'].forEach((day, i) => {
        body += text(X0 - 10, Y0 + (i * 2 + 1) * STEP + 10, day, { size: 11, fill: INK3, anchor: 'end' });
    });

    const ly = Y0 + STEP * 7 + 18;
    const lx = W - 24 - 34 - ramp.length * STEP;
    body += text(24, ly + 10, `Commits to the ${repos.length} public repositories, by day`, { size: 12, fill: INK3 });
    body += text(lx - 8, ly + 10, 'Less', { size: 11, fill: INK3, anchor: 'end' });
    ramp.forEach((fill, i) => {
        body += `<rect x="${lx + i * STEP}" y="${ly}" width="${CELL}" height="${CELL}" rx="2.5" fill="${fill}"/>`;
    });
    body += text(lx + ramp.length * STEP + 5, ly + 10, 'More', { size: 11, fill: INK3 });

    await draw('commits.svg', W, H, `${full(total)} commits in the last 12 months`, body);
    return total;
}

// ---------------------------------------------------------------------------------------------------------------
// Downloads by resource

async function downloadsChart({ repos }) {
    const W = 880;
    const TOP = 8;
    const ROW = 30;
    const BAR = 14;
    const Y0 = 62;

    const ranked = repos.filter(r => r.downloads > 0).sort((a, b) => b.downloads - a.downloads);
    const rows = ranked.slice(0, TOP).map(r => ({ name: r.name, value: r.downloads, fill: YELLOW }));
    const rest = ranked.slice(TOP);
    if (rest.length) {
        rows.push({ name: `${rest.length} more`, value: rest.reduce((n, r) => n + r.downloads, 0), fill: OTHER });
    }

    const total = ranked.reduce((n, r) => n + r.downloads, 0);
    const max = Math.max(...rows.map(r => r.value));
    const gutter = 24 + Math.max(...rows.map(r => measure(r.name, 13, 500))) + 14;
    const span = W - 24 - 52 - gutter;
    const H = Y0 + rows.length * ROW + 16;

    let body = card(W, H) + heading(W, 'Downloads by resource', `${full(total)} from every release`);
    body += `<line x1="${r(gutter)}" y1="${Y0 - 6}" x2="${r(gutter)}" y2="${Y0 + rows.length * ROW - 2}" stroke="${LINE}"/>`;

    rows.forEach(({ name, value, fill }, i) => {
        const y = Y0 + i * ROW;
        const w = (value / max) * span;

        body += text(gutter - 12, y + 16, name, { size: 13, weight: 500, fill: fill === OTHER ? INK2 : INK, anchor: 'end' });
        body += bar(gutter, y + (ROW - BAR) / 2 - 4, w, BAR, fill);
        body += text(gutter + w + 8, y + 16, compact(value), { size: 12, weight: 500, fill: INK2 });
    });

    await draw('downloads.svg', W, H, `Downloads by resource: ${full(total)} in all`, body);
    return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Stars over time

async function starsChart({ repos }) {
    const W = 880;
    const H = 270;
    const L = 64;
    const R = W - 40;
    const T = 70;
    const B = H - 46;

    const times = repos.flatMap(r => r.starred).sort((a, b) => a - b);
    const total = times.length;
    const t0 = times[0];
    const t1 = Date.now();

    const step = niceStep(total, 4);
    const top = Math.ceil(total / step) * step;
    const x = t => L + ((t - t0) / (t1 - t0)) * (R - L);
    const y = v => B - (v / top) * (B - T);

    let body = card(W, H) + heading(W, 'Stars over time', `${full(total)} across every repository`);

    for (let v = 0; v <= top; v += step) {
        body += `<line x1="${L}" y1="${r(y(v))}" x2="${R}" y2="${r(y(v))}" stroke="${LINE}"/>`;
        body += text(L - 10, y(v) + 4, compact(v), { size: 11, fill: INK3, anchor: 'end' });
    }

    const first = new Date(t0).getUTCFullYear();
    const last = new Date(t1).getUTCFullYear();
    for (let year = first + 1; year <= last; year++) {
        const tx = x(Date.UTC(year, 0, 1));
        body += `<line x1="${r(tx)}" y1="${B}" x2="${r(tx)}" y2="${B + 5}" stroke="${LINE}"/>`;
        body += text(tx, B + 22, String(year), { size: 11, fill: INK3, anchor: 'middle' });
    }

    // The running total, sampled across the span.
    const SAMPLES = 260;
    const points = [];
    let seen = 0;
    for (let i = 0; i <= SAMPLES; i++) {
        const t = t0 + ((t1 - t0) * i) / SAMPLES;
        while (seen < total && times[seen] <= t) seen++;
        points.push([r(x(t)), r(y(seen))]);
    }

    const line = points.map(p => p.join(' ')).join('L');
    const [ex, ey] = points.at(-1);
    body += `<path d="M${line}L${R} ${B}L${L} ${B}z" fill="${YELLOW}" fill-opacity=".1"/>`;
    body += `<path d="M${line}" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    body += `<circle cx="${ex}" cy="${ey}" r="4.5" fill="${YELLOW}" stroke="${SURFACE}" stroke-width="2"/>`;
    body += text(ex - 10, ey - 10, full(total), { size: 13, weight: 600, anchor: 'end' });

    await draw('stars.svg', W, H, `${full(total)} stars, by when they were given`, body);
}

// ---------------------------------------------------------------------------------------------------------------
// The featured cards

async function cards({ repos }) {
    const W = 430;
    const H = 172;
    const out = [];

    for (const { name, blurb } of FEATURED) {
        const repo = repos.find(r => r.name === name);
        if (!repo) {
            console.warn(`featured ${name} isn't a public repo of ${ORG}`);
            continue;
        }

        let body = card(W, H) + icon('repo', 20, 22, INK3) + text(44, 35, name, { size: 17, weight: 600 });

        if (repo.release) {
            const tag = clip(repo.release, 11, 90);
            const tw = measure(tag, 11, 500, 'mono') + 16;
            body += `<rect x="${r(W - 20 - tw)}" y="19" width="${r(tw)}" height="22" rx="11" fill="${PANEL}" stroke="${LINE}"/>`;
            body += text(W - 20 - tw / 2, 34, tag, { size: 11, weight: 500, fill: INK2, anchor: 'middle', cls: 'm' });
        }

        wrap(blurb ?? repo.description ?? '', 13.5, W - 40, 3).forEach((line, i) => {
            body += text(20, 70 + i * 21, line, { size: 13.5, fill: INK2 });
        });

        // The footer: language, stars, forks, downloads.
        let fx = 20;
        const fy = H - 24;
        const fact = (glyph, value) => {
            body += icon(glyph, fx, fy - 12, INK3);
            body += text(fx + 21, fy, value, { size: 12.5, weight: 500, fill: INK2 });
            fx += 21 + measure(value, 12.5, 500) + 18;
        };

        if (repo.language) {
            body += `<circle cx="${fx + 5}" cy="${fy - 4.5}" r="5" fill="${LANGUAGES[repo.language] ?? INK3}"/>`;
            body += text(fx + 16, fy, repo.language, { size: 12.5, weight: 500, fill: INK2 });
            fx += 16 + measure(repo.language, 12.5, 500) + 18;
        }
        fact('star', full(repo.stargazers_count));
        fact('fork', full(repo.forks_count));
        if (repo.downloads) fact('download', compact(repo.downloads));

        const file = `card-${name}.svg`;
        const said = blurb ?? repo.description ?? '';
        await draw(file, W, H, `${name}: ${said}`, body, repo.release ? ['inter', 'mono'] : ['inter']);
        out.push({ name, file, said });
    }

    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The README

function splice(readme, name, content) {
    const pattern = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
    if (!pattern.test(readme)) throw new Error(`profile/README.md has no <!-- ${name}:start --> marker`);
    return readme.replace(pattern, `$1\n${content}\n$2`);
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

async function readme(data, { label }, featured) {
    let md = await readFile(README, 'utf8');

    md = splice(md, 'stats', `<img src="assets/stats.svg" width="100%" alt="${esc(label)}">`);

    const pairs = [];
    for (let i = 0; i < featured.length; i += 2) {
        const links = featured
            .slice(i, i + 2)
            .map(f => `  <a href="https://github.com/${ORG}/${f.name}"><img src="assets/${f.file}" width="49%" alt="${esc(`${f.name}: ${f.said}`)}"></a>`);
        pairs.push(`<p align="center">\n${links.join('\n')}\n</p>`);
    }
    md = splice(md, 'featured', pairs.join('\n\n'));

    const blurbs = new Map(FEATURED.map(f => [f.name, f.blurb]));
    const listed = [...data.live].sort((a, b) => b.downloads - a.downloads || b.stargazers_count - a.stargazers_count);
    const rows = listed.map(r => {
        const link = `[**${r.name}**](https://github.com/${ORG}/${r.name})`;
        const said = cell(blurbs.get(r.name) ?? r.description);
        const release = r.release ? `\`${cell(r.release)}\`` : '';
        return `| ${link} | ${said} | ${full(r.stargazers_count)} | ${r.downloads ? full(r.downloads) : ''} | ${release} |`;
    });
    md = splice(
        md,
        'resources',
        `<details>\n<summary><b>All ${listed.length} public resources</b>, with their stars, downloads and latest release</summary>\n<br>\n\n` +
            `| Resource | What it is | Stars | Downloads | Release |\n|---|---|--:|--:|---|\n${rows.join('\n')}\n\n</details>`,
    );

    const day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    md = splice(md, 'updated', `<sub>Numbers from GitHub, ${day}.</sub>`);

    await writeFile(README, md);
}

// ---------------------------------------------------------------------------------------------------------------

const data = await gather();
console.log(`${data.repos.length} public repos (${data.live.length} not archived), ${data.weeks.length} weeks of commits`);

await banner(data.avatar);
await buttons();
const totals = await stats(data);
await heatmap(data);
await downloadsChart(data);
await starsChart(data);
const featured = await cards(data);
await readme(data, totals, featured);

console.log(totals.label);
