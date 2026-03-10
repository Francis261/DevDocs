# DevDocs Scraper

Download DevDocs documentation as structured Markdown for AI datasets / RAG ingestion.

## Install

```bash
npm install
```

## Run

```bash
node scrape-devdocs.js javascript
```

### Download specific sub-categories (matching DevDocs sidebar groups)

```bash
node scrape-devdocs.js javascript/array
node scrape-devdocs.js javascript/array,classes,math
node scrape-devdocs.js javascript array, classes, math
node scrape-devdocs.js "vite 6"
node scrape-devdocs.js vite 6
```

### Options

```bash
node scrape-devdocs.js javascript --limit 200 --concurrency 8 --retries 4
node scrape-devdocs.js javascript --output datas/devdocs
node scrape-devdocs.js javascript --force
```

- `--force`: re-write files even when unchanged.

## Output structure

```text
datas/devdocs/
  javascript/
    array/
      Array.md
      Array.from().md
      Array.prototype.map().md
    classes/
      class.md
      constructor.md
    _manifest.json
```

- Top-level folder is the selected doc category.
- Sub-folders mirror DevDocs sub-categories (`index.json -> types`).
- Every page is saved as a Markdown file with title + source URL + content.
- Only meaningful content is kept: headings, paragraphs, lists, and code blocks.

## Incremental updates

- The scraper stores `datas/devdocs/<category>/_manifest.json` with per-page content hashes.
- On next run, unchanged pages are skipped automatically.
- Changed pages are rewritten.
- Failed pages are logged to `_failed-pages.json`.
