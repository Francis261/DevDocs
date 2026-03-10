#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cheerio = require('cheerio');

const execFileAsync = promisify(execFile);

const BASE_URL = 'https://devdocs.io';
const DOCS_ORIGIN = 'https://documents.devdocs.io';
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'datas', 'devdocs');
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRIES = 3;

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    category: null,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    retries: DEFAULT_RETRIES,
    outputRoot: DEFAULT_OUTPUT_ROOT,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--') && !options.category) {
      options.category = token;
      continue;
    }

    if (!token.startsWith('--') && options.category && options.limit === null && /^\d+$/.test(token)) {
      options.limit = Number(token);
      continue;
    }

    const [flag, rawValue] = token.split('=');
    const nextValue = rawValue ?? args[i + 1];

    if (flag === '--limit' && /^\d+$/.test(nextValue || '')) {
      options.limit = Number(nextValue);
      if (rawValue === undefined) i += 1;
    } else if (flag === '--concurrency' && /^\d+$/.test(nextValue || '')) {
      options.concurrency = Math.max(1, Number(nextValue));
      if (rawValue === undefined) i += 1;
    } else if (flag === '--retries' && /^\d+$/.test(nextValue || '')) {
      options.retries = Math.max(1, Number(nextValue));
      if (rawValue === undefined) i += 1;
    } else if (flag === '--output' && nextValue) {
      options.outputRoot = path.resolve(nextValue);
      if (rawValue === undefined) i += 1;
    }
  }

  return options;
}

function printUsage() {
  console.error(`Usage:
  node scrape-devdocs.js <category> [limit]
  node scrape-devdocs.js <category> --limit 100 --concurrency 8 --retries 4 --output datas/devdocs

Examples:
  node scrape-devdocs.js javascript
  node scrape-devdocs.js html 250
  node scrape-devdocs.js css --concurrency 10`);
}

function sanitizeSegment(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '') || 'untitled';
}

async function fetchJsonWithCurl(url, retries) {
  let latestError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--retry-delay', '1', url],
        { maxBuffer: 100 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    } catch (error) {
      latestError = error;
      if (attempt < retries) console.warn(`Retry ${attempt}/${retries - 1}: ${url}`);
    }
  }
  throw latestError;
}

async function fetchCategoryIndex(category, retries) {
  return fetchJsonWithCurl(`${DOCS_ORIGIN}/${encodeURIComponent(category)}/index.json`, retries);
}

async function fetchCategoryDb(category, retries) {
  return fetchJsonWithCurl(`${DOCS_ORIGIN}/${encodeURIComponent(category)}/db.json`, retries);
}

function buildOutputPath(outputRoot, category, entryPath) {
  const segments = entryPath.split('/').filter(Boolean).map(sanitizeSegment);
  const fileName = `${segments.pop() || 'index'}.md`;
  return path.join(outputRoot, sanitizeSegment(category), ...segments, fileName);
}

function normalizeWhitespace(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function listToMarkdown($, listNode, depth = 0) {
  const ordered = listNode.tagName.toLowerCase() === 'ol';
  const lines = [];

  $(listNode).children('li').each((idx, li) => {
    const liNode = $(li);
    const textOnly = normalizeWhitespace(liNode.clone().children('ul,ol').remove().end().text());
    const marker = ordered ? `${idx + 1}.` : '-';
    const indent = '  '.repeat(depth);
    if (textOnly) lines.push(`${indent}${marker} ${textOnly}`);

    liNode.children('ul,ol').each((_, nested) => {
      const nestedMd = listToMarkdown($, nested, depth + 1);
      if (nestedMd) lines.push(nestedMd);
    });
  });

  return lines.join('\n');
}

function htmlToMarkdown(html, fallbackTitle) {
  const $ = cheerio.load(`<article>${html}</article>`);

  $('script,style,noscript,nav,aside,form,button,.bc-data,.baseline-indicator,.metadata,.reference-tools,.interactive').remove();

  const blocks = [];
  $('article').find('h1,h2,h3,h4,h5,h6,p,ul,ol,pre').each((_, node) => {
    const tag = node.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = normalizeWhitespace($(node).text());
      if (!text) return;
      blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
      return;
    }

    if (tag === 'p') {
      const text = normalizeWhitespace($(node).text());
      if (text) blocks.push(text);
      return;
    }

    if (tag === 'pre') {
      const code = $(node).text().replace(/\n+$/g, '');
      if (code.trim()) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      const listMd = listToMarkdown($, node, 0);
      if (listMd) blocks.push(listMd);
    }
  });

  let markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  if (!markdown) return `# ${fallbackTitle}\n\nNo parsable content found.`;

  return markdown;
}

function stripDuplicateTopHeading(title, markdown) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^#\\s+${escaped}\\n\\n`, 'i');
  return markdown.replace(regex, '');
}

function getEntryHtml(db, entryPath) {
  return db[entryPath] || db[`/${entryPath}`] || null;
}

async function withConcurrency(items, concurrency, worker) {
  let pointer = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (pointer < items.length) {
      const index = pointer;
      pointer += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function run() {
  const options = parseArgs(process.argv);
  if (!options.category) {
    printUsage();
    process.exit(1);
  }

  await fs.mkdir(options.outputRoot, { recursive: true });

  const [indexJson, dbJson] = await Promise.all([
    fetchCategoryIndex(options.category, options.retries),
    fetchCategoryDb(options.category, options.retries),
  ]);

  const visited = new Set();
  let entries = (indexJson.entries || []).filter((entry) => {
    const key = `${options.category}/${entry.path}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return true;
  });

  if (options.limit) entries = entries.slice(0, options.limit);

  console.log(
    `Category=${options.category} | pages=${entries.length} | concurrency=${options.concurrency} | retries=${options.retries}`,
  );

  let success = 0;
  let failed = 0;

  await withConcurrency(entries, options.concurrency, async (entry, idx) => {
    const sourceUrl = `${BASE_URL}/${options.category}/${entry.path}`;
    const outputPath = buildOutputPath(options.outputRoot, options.category, entry.path);
    const relativePath = path.relative(process.cwd(), outputPath);

    process.stdout.write(`[${idx + 1}/${entries.length}] ${entry.path} ... `);

    try {
      const html = getEntryHtml(dbJson, entry.path);
      if (!html) throw new Error('content missing from db.json');

      let markdownBody = htmlToMarkdown(html, entry.name || entry.path);
      const extractedHeading = markdownBody.match(/^#\s+(.+)$/m)?.[1];
      const title = extractedHeading || entry.name || entry.path;
      markdownBody = stripDuplicateTopHeading(title, markdownBody);

      const finalContent = `# ${title}\n\nSource: ${sourceUrl}\n\n${markdownBody}\n`;

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, finalContent, 'utf8');

      success += 1;
      console.log(`saved ${relativePath}`);
    } catch (error) {
      failed += 1;
      console.log(`failed (${error.message})`);
    }
  });

  console.log(`\nCompleted. Downloaded: ${success}/${entries.length}. Failed: ${failed}.`);
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
