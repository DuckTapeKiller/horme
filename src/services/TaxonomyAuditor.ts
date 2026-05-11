import { TFile, Notice } from "obsidian";
import HormePlugin from "../../main";

export class TaxonomyAuditor {
    private plugin: HormePlugin;

    constructor(plugin: HormePlugin) {
        this.plugin = plugin;
    }

    private getFrontmatterRange(content: string): { start: number; end: number } | null {
        // YAML frontmatter is only valid at the very start of the file.
        // Support both LF and CRLF. End marker can be "---" or "...".
        if (!content.startsWith("---")) return null;

        const len = content.length;
        let i = 0;

        const readLine = (from: number): { line: string; lineStart: number; lineEnd: number } | null => {
            if (from >= len) return null;
            const lineStart = from;
            const nl = content.indexOf("\n", from);
            const lineEnd = nl === -1 ? len : nl + 1;
            const raw = content.slice(lineStart, lineEnd);
            const line = raw.endsWith("\n")
                ? raw.slice(0, raw.endsWith("\r\n") ? -2 : -1)
                : raw;
            return { line, lineStart, lineEnd };
        };

        const first = readLine(0);
        if (!first) return null;
        if (first.line.trim() !== "---") return null;

        i = first.lineEnd;
        while (i < len) {
            const l = readLine(i);
            if (!l) break;
            const trimmed = l.line.trim();
            if (trimmed === "---" || trimmed === "...") {
                // Include the closing line and its newline (if any)
                return { start: 0, end: l.lineEnd };
            }
            i = l.lineEnd;
        }

        // Unclosed frontmatter — treat as frontmatter to EOF to avoid corruption
        return { start: 0, end: len };
    }

    private getFencedCodeBlockRanges(content: string, startOffset: number): { start: number; end: number }[] {
        const ranges: { start: number; end: number }[] = [];
        const len = content.length;
        let i = startOffset;
        let inFence = false;
        let fenceChar: "`" | "~" | null = null;
        let fenceLen = 0;
        let fenceStart = 0;

        const readLine = (from: number): { line: string; lineStart: number; lineEnd: number } | null => {
            if (from >= len) return null;
            const lineStart = from;
            const nl = content.indexOf("\n", from);
            const lineEnd = nl === -1 ? len : nl + 1;
            const raw = content.slice(lineStart, lineEnd);
            const line = raw.endsWith("\n")
                ? raw.slice(0, raw.endsWith("\r\n") ? -2 : -1)
                : raw;
            return { line, lineStart, lineEnd };
        };

        while (i < len) {
            const l = readLine(i);
            if (!l) break;

            const line = l.line;
            const lineStart = l.lineStart;
            const lineEnd = l.lineEnd;

            if (!inFence) {
                const m = line.match(/^\s*(`{3,}|~{3,})/);
                if (m) {
                    inFence = true;
                    fenceChar = m[1][0] as "`" | "~";
                    fenceLen = m[1].length;
                    fenceStart = lineStart;
                }
            } else {
                const ch = fenceChar;
                if (ch) {
                    const closeRe = new RegExp(`^\\s*${ch}{${fenceLen},}\\s*$`);
                    if (closeRe.test(line)) {
                        ranges.push({ start: fenceStart, end: lineEnd });
                        inFence = false;
                        fenceChar = null;
                        fenceLen = 0;
                        fenceStart = 0;
                    }
                }
            }

            i = lineEnd;
        }

        if (inFence) {
            // Unclosed fence — protect to EOF
            ranges.push({ start: fenceStart, end: len });
        }

        return ranges;
    }

    private getInlineCodeRanges(content: string, startOffset: number, excluded: { start: number; end: number }[]): { start: number; end: number }[] {
        const ranges: { start: number; end: number }[] = [];
        const regex = /`[^`\r\n]+`/g;
        regex.lastIndex = startOffset;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
            const start = m.index;
            const end = start + m[0].length;
            if (!this.isInAnyRange(start, excluded)) {
                ranges.push({ start, end });
            }
        }
        return ranges;
    }

    private isInAnyRange(offset: number, ranges: { start: number; end: number }[]): boolean {
        for (const range of ranges) {
            if (offset >= range.start && offset < range.end) return true;
        }
        return false;
    }

    private getProtectedRanges(content: string): { start: number; end: number }[] {
        const ranges: { start: number; end: number }[] = [];
        const fm = this.getFrontmatterRange(content);
        const startOffset = fm ? fm.end : 0;
        if (fm) ranges.push(fm);

        const fenced = this.getFencedCodeBlockRanges(content, startOffset);
        ranges.push(...fenced);

        const inline = this.getInlineCodeRanges(content, startOffset, ranges);
        ranges.push(...inline);

        ranges.sort((a, b) => a.start - b.start || a.end - b.end);
        return ranges;
    }

    async executeTagRenameBatch(pairs: { from: string; to: string }[]) {
        const validPairs = pairs
            .map(p => ({
                from: p.from.replace(/^#/, '').trim(),
                to: p.to.replace(/^#/, '').trim()
            }))
            .filter(p => p.from && p.to && p.from !== p.to);

        if (validPairs.length === 0) {
            new Notice('Horme: No valid rename pairs found.');
            return;
        }

        // Longest-from-first prevents prefix collisions (e.g. "a" vs "a/b")
        const orderedPairs = [...validPairs].sort((a, b) => b.from.length - a.from.length);
        const renameMap = new Map<string, string>(orderedPairs.map(p => [p.from, p.to]));
        const files = this.plugin.app.vault.getMarkdownFiles();
        let changedFilesCount = 0;

        new Notice(`Horme: Merging ${validPairs.length} tags...`);

        const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sourcePatterns = orderedPairs.map(p => escapeRegExp(p.from)).join('|');
        const tagRegex = new RegExp(
            `(^|[^\\p{L}\\p{N}_/#])(#)((?:${sourcePatterns})(?:\\/[\\p{L}\\p{N}_\\-]+)*)(?=[\\s]|$|[^\\p{L}\\p{N}_\\/-])`,
            'gu'
        );

        this.plugin.setIndexingStatus(`Merging tags: 0/${files.length}...`);
        let processedCount = 0;

        for (const file of files) {
            tagRegex.lastIndex = 0;
            try {
                let modifiedFrontmatter = false;
                let modifiedBody = false;

                // 1. Process Frontmatter
                await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                    const processSingleTag = (t: unknown): unknown => {
                        if (typeof t !== 'string') return t;
                        const hasHash = t.startsWith('#');
                        const raw = hasHash ? t.substring(1) : t;

                        for (const [from, to] of renameMap) {
                            if (raw === from) {
                                modifiedFrontmatter = true;
                                return hasHash ? '#' + to : to;
                            }
                            if (raw.startsWith(from + '/')) {
                                modifiedFrontmatter = true;
                                return hasHash
                                    ? '#' + to + raw.substring(from.length)
                                    : to + raw.substring(from.length);
                            }
                        }
                        return t;
                    };

                    const handleTagKey = (key: string) => {
                        if (!fm[key]) return;
                        if (Array.isArray(fm[key])) {
                            const newTags = (fm[key] as unknown[]).map(processSingleTag);
                            const uniqueTags: unknown[] = [];
                            const seen = new Set<string>();
                            for (const t of newTags) {
                                if (typeof t === 'string') {
                                    const clean = t.startsWith('#') ? t.substring(1) : t;
                                    if (seen.has(clean)) {
                                        modifiedFrontmatter = true;
                                        continue;
                                    }
                                    seen.add(clean);
                                }
                                uniqueTags.push(t);
                            }
                            const originalArr = fm[key] as unknown[];
                            if (uniqueTags.length !== originalArr.length || uniqueTags.some((t, i) => t !== originalArr[i])) {
                                fm[key] = uniqueTags;
                                modifiedFrontmatter = true;
                            }
                        } else if (typeof fm[key] === 'string') {
                            const n = processSingleTag(fm[key]);
                            if (n !== fm[key]) { fm[key] = n; modifiedFrontmatter = true; }
                        }
                    };

                    handleTagKey('tags');
                    handleTagKey('tag');
                });

                // 2. Process Body Tags
                await this.plugin.app.vault.process(file, (data) => {
                    const protectedRanges = this.getProtectedRanges(data);

                    const newData = data.replace(tagRegex, (match, prefix, hash, capturedTag, offset) => {
                        const tagOffset = offset + (typeof prefix === "string" ? prefix.length : 0);
                        if (this.isInAnyRange(tagOffset, protectedRanges)) return match;
                        
                        for (const [from, to] of renameMap) {
                            if (capturedTag === from) {
                                modifiedBody = true;
                                return prefix + hash + to;
                            }
                            if (capturedTag.startsWith(from + '/')) {
                                modifiedBody = true;
                                return prefix + hash + to + capturedTag.substring(from.length);
                            }
                        }
                        return match;
                    });
                    
                    tagRegex.lastIndex = 0;
                    return newData;
                });

                if (modifiedFrontmatter || modifiedBody) {
                    changedFilesCount++;
                }

                processedCount++;
                if (processedCount % 10 === 0 || processedCount === files.length) {
                    this.plugin.setIndexingStatus(`Merging tags: ${processedCount}/${files.length}...`);
                }

            } catch (e) {
                this.plugin.diagnosticService.report(
                    "Taxonomy",
                    `Taxonomy rename failed on ${file.path}: ${e?.message || String(e)}`,
                    "warning"
                );
            }
        }

        this.plugin.setIndexingStatus(null);

        if (changedFilesCount > 0) {
            new Notice(`Horme: Taxonomy audit applied. ${changedFilesCount} files updated.`);
        } else {
            new Notice('Horme: Taxonomy audit completed. No files required modifications.');
        }
    }
}
