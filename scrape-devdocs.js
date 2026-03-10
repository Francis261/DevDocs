#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cheerio = require('cheerio');

const BASE_URL = 'https://devdocs.io';
const DOCS_ORIGIN = 'https://documents.devdocs.io';
const OUTPUT_ROOT = path.join(process.cwd(), 'datas', 'devdocs');
const MAX_CONCURRENCY = 6;
const MAX_RETRIES = 3;
const execFileAsync = promisify(execFile);

function sanitizeSegment(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '') || 'untitled';
}

async function fetchJsonWithCurl(url, retries = MAX_RETRIES) {
  let error;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['--fail', '--silent', '--show-error', '--location', url],
        { maxBuffer: 100 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    } catch (err) {
      error = err;
      if (attempt < retries) {
        console.warn(`retry ${attempt}/${retries - 1}: ${url}`);
      }
    }
  }
  throw error;
}

async function fetchIndex(category) {
  return fetchJsonWithCurl(`${DOCS_ORIGIN}/${encodeURIComponent(category)}/index.json`);
}

async function fetchDb(category) {
  return fetchJsonWithCurl(`${DOCS_ORIGIN}/${encodeURIComponent(category)}/db.json`);
}

function buildOutputPath(category, docPath) {
  const segments = docPath.split('/').filter(Boolean).map(sanitizeSegment);
  const fileName = `${segments.pop() || 'index'}.md`;
  return path.join(OUTPUT_ROOT, sanitizeSegment(category), ...segments, fileName);
}

function normalizeWhitespace(text) {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function nodeToMarkdown($, node, depth = 0) {
  const tag = node.tagName ? node.tagName.toLowerCase() : '';
  const el = $(node);

  if (tag && /^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return `${'#'.repeat(level)} ${normalizeWhitespace(el.text())}`;
  }

  if (tag === 'p') return normalizeWhitespace(el.text());

  if (tag === 'pre') {
    const raw = el.text().replace(/\n+$/g, '');
    return raw.trim() ? `\n\`\`\`\n${raw}\n\`\`\`` : '';
  }

  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    const lines = [];
    el.children('li').each((idx, li) => {
      const text = normalizeWhitespace($(li).text());
      if (!text) return;
      const indent = '  '.repeat(depth);
      const marker = ordered ? `${idx + 1}.` : '-';
      lines.push(`${indent}${marker} ${text}`);
    });
    return lines.join('\n');
  }

  return '';
}

function toMarkdown(html, fallbackTitle) {
  const $ = cheerio.load(`<article>${html}</article>`);
  $('nav, aside, ._header, ._sidebar, ._menu, script, style, noscript').remove();

  const blocks = [];
  $('article').find('h1,h2,h3,h4,h5,h6,p,ul,ol,pre').each((_, node) => {
    const md = nodeToMarkdown($, node);
    if (md) blocks.push(md);
  });

  const content = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return content || `# ${fallbackTitle}\n\nNo parsable content found.`;
}

function getEntryHtml(db, entryPath) {
  return db[entryPath] || db[`/${entryPath}`] || null;
}

async function withConcurrency(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function run() {
  const category = process.argv[2];
  const limitArg = process.argv[3];
  const limit = Number.isFinite(Number(limitArg)) && Number(limitArg) > 0 ? Number(limitArg) : null;
  if (!category) {
    console.error('Usage: node scrape-devdocs.js <category> [limit]');
    process.exit(1);
  }

  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  const [index, db] = await Promise.all([fetchIndex(category), fetchDb(category)]);

  const visited = new Set();
  let entries = (index.entries || []).filter((entry) => {
    const key = `${category}/${entry.path}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return true;
  });

  if (limit) entries = entries.slice(0, limit);

  console.log(`Found ${entries.length} pages in ${category}${limit ? ' (limited)' : ''}.`);

  let success = 0;
  let failed = 0;

  await withConcurrency(entries, MAX_CONCURRENCY, async (entry, idx) => {
    const pageUrl = `${BASE_URL}/${category}/${entry.path}`;
    const filePath = buildOutputPath(category, entry.path);
    const relative = path.relative(process.cwd(), filePath);

    process.stdout.write(`[${idx + 1}/${entries.length}] ${entry.path} ... `);

    try {
      const html = getEntryHtml(db, entry.path);
      if (!html) throw new Error('missing page content in db.json');

      const markdown = toMarkdown(html, entry.name);
      const title = markdown.match(/^#\s+(.+)$/m)?.[1] || entry.name;
      const content = `# ${title}\n\nSource: ${pageUrl}\n\n${markdown}\n`;

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
      success += 1;
      console.log(`saved ${relative}`);
    } catch (error) {
      failed += 1;
      console.log(`failed (${error.message})`);
    }
  });

  console.log(`\nDone. Downloaded ${success}/${entries.length} pages. Failed: ${failed}.`);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
