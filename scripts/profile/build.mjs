// Redraws the two charts on the org's profile page (stars over time, and commits by day over the last year) in a
// light and a dark version, and the line of numbers above them in profile/README.md (between <!-- numbers:start -->
// and <!-- numbers:end -->). Everything else on the page is written by hand.
//
// .github/workflows/profile.yml runs it every day. To run it here: GITHUB_TOKEN=$(gh auth token) node scripts/profile/build.mjs
//
// The workflow's own token can't list a repo's stargazers, so the stars are kept in profile/data/stars.json, a
// running total by day, and each run adds today's. `--seed` rebuilds that file from every stargazer, with a token
// that can (your own).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ORG = process.env.ORG ?? 'Samuels-Development';
const TOKEN = process.env.GITHUB_TOKEN;
const SEED = process.argv.includes('--seed');

const ROOT = new URL('../../', import.meta.url);
const ASSETS = new URL('profile/assets/', ROOT);
const STARS = new URL('profile/data/stars.json', ROOT);
const README = new URL('profile/README.md', ROOT);

// Repos that aren't resources.
const HIDDEN = new Set(['.github', 'docs']);

// GitHub's own greys for each theme, so the charts sit on the page like part of it, and the logo's yellow and cyan
// for the data. In light, the yellow line is taken down to a gold that holds up on white.
const THEMES = {
    light: {
        text: '#59636e',
        grid: '#d1d9e0',
        line: '#8a6f00',
        fill: '#f0e155',
        fillOpacity: 0.45,
        ring: '#ffffff',
        cells: ['#eff2f5', '#c6f1ee', '#7fd9d4', '#2fb2ac', '#0f7f7a'],
    },
    dark: {
        text: '#9198a1',
        grid: '#3d444d',
        line: '#f0e155',
        fill: '#f0e155',
        fillOpacity: 0.12,
        ring: '#0d1117',
        cells: ['#1c2129', '#2e5154', '#4b8a8b', '#71c1bf', '#94f4f0'],
    },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------------------------------------------
// GitHub

async function api(path, accept = 'application/vnd.github+json') {
    const headers = { accept, 'user-agent': ORG, 'x-github-api-version': '2022-11-28' };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

    const res = await fetch(new URL(path, 'https://api.github.com/'), { headers });
    if (res.status === 409) return []; // an empty repo has no commits to list
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);

    return res.json();
}

async function pages(path, accept) {
    const out = [];

    for (let page = 1; ; page++) {
        const items = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, accept);
        out.push(...items);
        if (items.length < 100) return out;
    }
}

async function each(items, limit, fn) {
    let next = 0;

    const worker = async () => {
        while (next < items.length) await fn(items[next++]);
    };

    await Promise.all(Array.from({ length: limit }, worker));
}

const day = t => new Date(t).toISOString().slice(0, 10);

async function gather() {
    const listed = await pages(`orgs/${ORG}/repos?type=public`);
    const repos = listed.filter(r => !r.private && !r.fork && !HIDDEN.has(r.name));

    const now = Date.now();
    const since = new Date(now - 366 * DAY).toISOString();
    const commits = new Map();
    let downloads = 0;

    await each(repos, 6, async repo => {
        const releases = await pages(`repos/${ORG}/${repo.name}/releases`);
        downloads += releases.flatMap(r => r.assets).reduce((n, a) => n + a.download_count, 0);

        if (Date.parse(repo.pushed_at) < now - 366 * DAY) return;
        for (const c of await pages(`repos/${ORG}/${repo.name}/commits?since=${since}`)) {
            const d = day(c.commit.author.date);
            commits.set(d, (commits.get(d) ?? 0) + 1);
        }
    });

    return {
        repos,
        live: repos.filter(r => !r.archived),
        stars: repos.reduce((n, r) => n + r.stargazers_count, 0),
        downloads,
        commits,
    };
}

// The running total of stars by day: every day the total changed, and today.
async function starHistory(repos, total) {
    if (SEED) {
        const times = [];
        await each(repos.filter(r => r.stargazers_count > 0), 6, async repo => {
            const stars = await pages(`repos/${ORG}/${repo.name}/stargazers`, 'application/vnd.github.star+json');
            times.push(...stars.map(s => Date.parse(s.starred_at)));
        });

        const history = {};
        times.sort((a, b) => a - b).forEach((t, i) => (history[day(t)] = i + 1));
        history[day(Date.now())] = total;
        return history;
    }

    const history = JSON.parse(await readFile(STARS, 'utf8'));
    history[day(Date.now())] = total;
    return history;
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r = n => Math.round(n * 10) / 10;
const full = n => n.toLocaleString('en-US');
const compact = n => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`);

function text(x, y, s, fill, anchor) {
    return `<text x="${r(x)}" y="${r(y)}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
}

async function draw(name, width, height, label, body) {
    for (const [mode, theme] of Object.entries(THEMES)) {
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">` +
            `<title>${esc(label)}</title><style>text{font-family:${FONT};font-size:12px}</style>${body(theme)}</svg>\n`;
        await writeFile(new URL(`${name}-${mode}.svg`, ASSETS), svg);
    }
}

function niceStep(max, count) {
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

// Stars over time: the running total as a line over a light wash, its value at today's end.
async function starsChart(history) {
    const W = 880;
    const H = 230;
    const L = 44;
    const R = W - 12;
    const T = 22;
    const B = H - 30;

    const days = Object.entries(history).sort(([a], [b]) => a.localeCompare(b));
    const t0 = Date.parse(days[0][0]);
    const t1 = Date.parse(days.at(-1)[0]);
    const total = days.at(-1)[1];

    const step = niceStep(total, 4);
    const top = Math.ceil(total / step) * step;
    const x = t => L + ((t - t0) / (t1 - t0)) * (R - L);
    const y = v => B - (v / top) * (B - T);

    // A step at every change, so a quiet month stays flat.
    let path = `M${r(x(t0))} ${r(y(0))}`;
    for (const [d, v] of days) path += `H${r(x(Date.parse(d)))}V${r(y(v))}`;
    const [ex, ey] = [x(t1), y(total)];

    await draw('stars', W, H, `${full(total)} stars across the public repositories, over time`, theme => {
        let body = '';

        for (let v = 0; v <= top; v += step) {
            body += `<line x1="${L}" y1="${r(y(v))}" x2="${R}" y2="${r(y(v))}" stroke="${theme.grid}" stroke-width="1"/>`;
            body += text(L - 8, y(v) + 4, compact(v), theme.text, 'end');
        }

        for (let year = new Date(t0).getUTCFullYear() + 1; year <= new Date(t1).getUTCFullYear(); year++) {
            body += text(x(Date.UTC(year, 0, 1)), B + 20, String(year), theme.text, 'middle');
        }

        body += `<path d="${path}H${r(ex)}V${B}H${L}z" fill="${theme.fill}" fill-opacity="${theme.fillOpacity}"/>`;
        body += `<path d="${path}" fill="none" stroke="${theme.line}" stroke-width="2" stroke-linejoin="round"/>`;
        body += `<circle cx="${r(ex)}" cy="${r(ey)}" r="4.5" fill="${theme.line}" stroke="${theme.ring}" stroke-width="2"/>`;
        body += text(ex - 10, ey - 4, full(total), theme.text, 'end');

        return body;
    });
}

// Commits by day for the last 52 weeks, a column a week from Sunday, as GitHub draws a person's.
async function commitsChart(commits) {
    const W = 880;
    const CELL = 13;
    const STEP = 16;
    const X0 = 34;
    const Y0 = 20;
    const H = Y0 + STEP * 7 + 26;

    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const first = today - (now.getUTCDay() + 51 * 7) * DAY;

    const counts = [...commits.values()].sort((a, b) => a - b);
    const q = f => counts[Math.floor((counts.length - 1) * f)] ?? 1;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const level = n => (!n ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4);

    let total = 0;
    for (let t = first; t <= today; t += DAY) total += commits.get(day(t)) ?? 0;

    await draw('commits', W, H, `${full(total)} commits to the public repositories in the last year, by day`, theme => {
        let body = '';
        let labelled = -4;

        for (let week = 0; week < 52; week++) {
            const start = first + week * 7 * DAY;
            const month = new Date(start + 6 * DAY).getUTCMonth();
            const before = new Date(start - DAY).getUTCMonth();

            if ((week === 0 || month !== before) && week - labelled >= 3 && week < 50) {
                body += text(X0 + week * STEP, Y0 - 8, MONTHS[month], theme.text);
                labelled = week;
            }

            for (let d = 0; d < 7; d++) {
                const t = start + d * DAY;
                if (t > today) break;
                const fill = theme.cells[level(commits.get(day(t)))];
                body += `<rect x="${X0 + week * STEP}" y="${Y0 + d * STEP}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`;
            }
        }

        ['Mon', 'Wed', 'Fri'].forEach((name, i) => {
            body += text(X0 - 8, Y0 + (i * 2 + 1) * STEP + 10, name, theme.text, 'end');
        });

        const ly = Y0 + STEP * 7 + 10;
        const lx = X0 + 51 * STEP + CELL - 5 * STEP - 30;
        body += text(lx - 6, ly + 11, 'Less', theme.text, 'end');
        theme.cells.forEach((fill, i) => {
            body += `<rect x="${lx + i * STEP}" y="${ly}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`;
        });
        body += text(lx + 5 * STEP + 3, ly + 11, 'More', theme.text);

        return body;
    });

    return total;
}

// ---------------------------------------------------------------------------------------------------------------

function splice(readme, name, content) {
    const pattern = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
    if (!pattern.test(readme)) throw new Error(`profile/README.md has no <!-- ${name}:start --> marker`);
    return readme.replace(pattern, `$1\n${content}\n$2`);
}

const data = await gather();
const history = await starHistory(data.repos, data.stars);

await mkdir(new URL('profile/data/', ROOT), { recursive: true });
await writeFile(STARS, `${JSON.stringify(history, null, 0).replace(/,"/g, ',\n"')}\n`);

await starsChart(history);
const commits = await commitsChart(data.commits);

const line =
    `${full(data.downloads)} downloads and ${full(data.stars)} stars across ${data.live.length} resources, ` +
    `and ${full(commits)} commits in the last year.`;

const readme = await readFile(README, 'utf8');
await writeFile(README, splice(readme, 'numbers', line));

console.log(line);
