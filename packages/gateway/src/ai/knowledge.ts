import fs from 'node:fs';
import path from 'node:path';

/**
 * The integration point for VERIFIED company knowledge.
 *
 * The agent must not invent what the company offers, charges or promises, and pasting every document into every prompt
 * is slow, expensive and makes the model skim. Instead each caller turn asks a KnowledgeProvider for the few passages
 * that bear on what was just said, and only those go into that turn's prompt, labelled as the sole source for
 * company-specific facts.
 *
 * KnowledgeProvider is the seam. LocalKnowledgeBase (below) is a dependency-free implementation: it indexes a folder of
 * .md / .txt files you wrote and checked, and ranks passages with BM25. A vector store, a database of FAQs or a search
 * service can replace it by implementing the same one method; nothing else in the engine changes.
 */
export interface KnowledgeHit {
  /** File (and heading) the passage came from, so an answer can be traced to a document. */
  source: string;
  text: string;
  score: number;
}

export interface KnowledgeProvider {
  readonly name: string;
  /** The best passages for the query, best first, never more than `maxChars` of text in total. Must not throw. */
  retrieve(query: string, options: { topK: number; maxChars: number }): Promise<KnowledgeHit[]>;
}

/** Added to the system prompt whenever a knowledge base is configured, whether or not this turn found anything. */
export const KNOWLEDGE_RULES =
  'COMPANY FACTS: State facts about the company (services, prices, hours, policies, capabilities, contact details) only if they appear under ' +
  'VERIFIED COMPANY INFORMATION or in the instructions above. If they do not cover the question, say you do not have that detail and offer to ' +
  'have the team follow up. Never guess, never invent a service, a price, or a promise.';

export function formatKnowledge(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return '';
  const body = hits.map((h) => `[${h.source}] ${h.text}`).join('\n');
  return `VERIFIED COMPANY INFORMATION (the only source for company-specific facts; say it in your own short words):\n${body}`;
}

// ---------------------------------------------------------------------------------------------------------------------

interface Chunk {
  source: string;
  text: string;
  terms: Map<string, number>;
  length: number;
}

const STOPWORDS = new Set(
  (
    'a an the and or but if of to in on at by for with from as is are was were be been being do does did have has had i you he she it we they ' +
    'me my your our their this that these those there here what which who whom how when where why can could would should will shall may might ' +
    'about into than then so such not no yes just also very any some more most please tell want need know get got go going'
  ).split(' ')
);

/** Lower-case words, light plural stripping, stopwords out. Deliberately simple: it must be predictable and fast. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

const K1 = 1.5;
const B = 0.75;
const MAX_CHUNK_CHARS = 500;
/** A passage must cover at least this share of the question's informative words to be offered at all. */
const MIN_COVERAGE = 0.2;

export class LocalKnowledgeBase implements KnowledgeProvider {
  readonly name = 'local-knowledge';
  private chunks: Chunk[] = [];
  private docFreq = new Map<string, number>();
  private avgLength = 0;

  constructor(entries: Array<{ source: string; text: string }>) {
    this.index(entries);
  }

  /** Index every .md and .txt file under `dir` (two levels deep). An unreadable or missing folder gives an empty base. */
  static fromDir(dir: string): LocalKnowledgeBase {
    const entries: Array<{ source: string; text: string }> = [];
    const walk = (current: string, depth: number): void => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of names) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
        else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
          try {
            entries.push({ source: path.relative(dir, full).replace(/\\/g, '/'), text: fs.readFileSync(full, 'utf8') });
          } catch {
            // an unreadable file is skipped, not fatal
          }
        }
      }
    };
    walk(dir, 0);
    return new LocalKnowledgeBase(entries);
  }

  get size(): number {
    return this.chunks.length;
  }

  private index(entries: Array<{ source: string; text: string }>): void {
    this.chunks = [];
    this.docFreq = new Map();
    for (const entry of entries) {
      for (const piece of this.split(entry.text)) {
        const tokens = tokenize(`${piece.heading} ${piece.text}`);
        if (tokens.length === 0) continue;
        const terms = new Map<string, number>();
        for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
        this.chunks.push({
          source: piece.heading ? `${entry.source} > ${piece.heading}` : entry.source,
          text: piece.text,
          terms,
          length: tokens.length,
        });
        for (const t of terms.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      }
    }
    this.avgLength = this.chunks.length === 0 ? 0 : this.chunks.reduce((n, c) => n + c.length, 0) / this.chunks.length;
  }

  /** Paragraphs, merged up to a size where one passage is a coherent answer, each remembering its nearest heading. */
  private split(text: string): Array<{ heading: string; text: string }> {
    const out: Array<{ heading: string; text: string }> = [];
    let heading = '';
    let buffer = '';
    const flush = () => {
      const t = buffer.trim();
      if (t) out.push({ heading, text: t });
      buffer = '';
    };
    for (const block of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const h = /^#{1,6}\s+(.+)$/m.exec(trimmed.split('\n')[0]);
      if (h) {
        flush();
        heading = h[1].trim();
        const rest = trimmed.split('\n').slice(1).join('\n').trim();
        if (rest) buffer = rest;
        continue;
      }
      if (buffer && buffer.length + trimmed.length > MAX_CHUNK_CHARS) flush();
      buffer = buffer ? `${buffer}\n${trimmed}` : trimmed;
    }
    flush();
    return out;
  }

  async retrieve(query: string, options: { topK: number; maxChars: number }): Promise<KnowledgeHit[]> {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || this.chunks.length === 0) return [];
    const n = this.chunks.length;
    const idfOf = (term: string): number => {
      const df = this.docFreq.get(term) ?? 0;
      return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    };
    // How much of the question a passage must account for. Words the documents never use count half: they cannot
    // match anything, but a passage that explains only one incidental word of a long question is not an answer.
    const wanted = queryTerms.reduce((sum, t) => sum + (this.docFreq.has(t) ? idfOf(t) : idfOf(t) * 0.5), 0);
    const scored: KnowledgeHit[] = [];
    for (const chunk of this.chunks) {
      let score = 0;
      let covered = 0;
      for (const term of queryTerms) {
        const tf = chunk.terms.get(term);
        if (!tf) continue;
        const idf = idfOf(term);
        covered += idf;
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * chunk.length) / (this.avgLength || 1)));
      }
      if (score > 0 && wanted > 0 && covered / wanted >= MIN_COVERAGE) scored.push({ source: chunk.source, text: chunk.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return [];
    // Weak matches are noise: keep passages that are at least a third as good as the best.
    const best = scored[0].score;
    const out: KnowledgeHit[] = [];
    let chars = 0;
    for (const hit of scored) {
      if (out.length >= options.topK) break;
      if (hit.score < best * 0.35) break;
      if (chars + hit.text.length > options.maxChars && out.length > 0) break;
      out.push({ ...hit, text: hit.text.slice(0, options.maxChars) });
      chars += hit.text.length;
    }
    return out;
  }
}
