// Formula property engine (Phase 7). A self-contained, NO-eval expression
// language for database formula properties. Pure TypeScript: a tokenizer, a
// recursive-descent parser producing a cacheable AST, and a tree-walking
// evaluator. There is NO use of `eval`, `Function`, or any global lookup — the
// evaluator can only touch the values it is handed via the evaluation context.
//
// ----------------------------------------------------------------------------
// GRAMMAR (lowest → highest precedence)
//
//   expr        := ternary
//   ternary     := logicOr ( '?' expr ':' expr )?      // C-style ?: (sugar)
//   logicOr     := logicAnd ( ('or' | '||') logicAnd )*
//   logicAnd    := equality ( ('and'| '&&') equality )*
//   equality    := comparison ( ('=='|'!='|'<>') comparison )*
//   comparison  := additive ( ('>'|'>='|'<'|'<=') additive )*
//   additive    := multiplicative ( ('+'|'-') multiplicative )*
//   multiplic.  := unary ( ('*'|'/'|'%') unary )*
//   unary       := ('-' | 'not' | '!') unary | primary
//   primary     := NUMBER | STRING | 'true' | 'false'
//                | '{{' name '}}'                       // bare prop ref
//                | IDENT '(' args? ')'                  // function call
//                | IDENT                                // bare identifier → error
//                | '(' expr ')'
//
// `prop("Name")` is just the built-in `prop` function; `{{Name}}` is sugar for
// it. Property names resolve case-insensitively within the same database.
//
// `+` adds numerically when BOTH sides are numbers, otherwise concatenates as
// strings (matching Notion). All other arithmetic operators coerce to number.
//
// ----------------------------------------------------------------------------
// FUNCTIONS (semantics chosen to be clean + predictable)
//
//   concat(...args)        → string; each arg formatted, joined with ''
//   join(sep, ...args)     → string; args formatted, joined with `sep`
//   length(x)              → number; string length, or array length
//   round(x[, digits])     → number; round to `digits` decimals (default 0)
//   floor(x) / ceil(x)     → number
//   abs(x)                 → number
//   min(...) / max(...)    → number; min/max of numeric args
//   sum(...)               → number; numeric sum of args
//   contains(str, sub)     → bool; substring test (string), or membership (array)
//   lower(x) / upper(x)    → string
//   trim(x)                → string
//   replace(s, find, repl) → string; replaces ALL occurrences (literal find)
//   slice(s, a[, b])       → string; like String.prototype.slice
//   format(x)              → string; human formatting of any value
//   number(x)              → number; parse to number, NaN→error
//   empty(x)               → bool; null/''/[]/NaN → true
//   notEmpty(x)            → bool; negation of empty
//   and(...) / or(...)     → bool
//   not(x)                 → bool
//   if(cond, a, b)         → a when cond truthy, else b (lazy)
//   now()                  → Date (current instant)
//   today()                → Date (current date at 00:00 local)
//   dateBetween(a, b, unit)→ number; whole units from b→a (days|months|years)
//   dateAdd(d, n, unit)    → Date; add n units (days|months|years)
//   year(d)/month(d)/day(d)→ number; calendar parts (month is 1-12)
//   test(s, regexStr)      → bool; RegExp(regexStr) test against s
//
// ----------------------------------------------------------------------------
// SAFETY
//   - Expression length is capped (MAX_EXPR_LEN) at parse time.
//   - Parser + evaluator recursion is capped (MAX_DEPTH) to prevent blowups.
//   - Unknown function / bare identifier → FormulaError (typed).
//   - Division / modulo by zero → FormulaError (no Infinity/NaN leak).
//   - `test()` guards against catastrophic regex by capping pattern length.
//   - The evaluator has access to NOTHING but the provided context.

export const MAX_EXPR_LEN = 2000;
export const MAX_DEPTH = 64;
const MAX_REGEX_LEN = 200;

/** Typed error thrown on any parse/eval failure. Caught by the caller. */
export class FormulaError extends Error {
  override readonly name = 'FormulaError';
  constructor(message: string) {
    super(message);
  }
}

/** Sentinel returned (instead of throwing) by the safe `safeEvaluate` wrapper. */
export interface FormulaErrorResult {
  __error: string;
}

export function isFormulaError(v: unknown): v is FormulaErrorResult {
  return typeof v === 'object' && v !== null && typeof (v as FormulaErrorResult).__error === 'string';
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | 'number'
  | 'string'
  | 'ident'
  | 'prop' // {{Name}} → carries the name in `value`
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'question'
  | 'colon'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const KEYWORD_OPS = new Set(['and', 'or', 'not']);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const push = (type: TokenType, value: string, pos: number) => tokens.push({ type, value, pos });

  while (i < n) {
    const ch = src[i]!;

    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Bare prop ref: {{ Property Name }}
    if (ch === '{' && src[i + 1] === '{') {
      const start = i;
      i += 2;
      let name = '';
      while (i < n && !(src[i] === '}' && src[i + 1] === '}')) {
        name += src[i];
        i++;
      }
      if (i >= n) throw new FormulaError('Unterminated {{property}} reference');
      i += 2; // consume }}
      push('prop', name.trim(), start);
      continue;
    }

    // Numbers (with optional single decimal point).
    if (ch >= '0' && ch <= '9') {
      const start = i;
      let num = '';
      let seenDot = false;
      while (i < n) {
        const c = src[i]!;
        if (c >= '0' && c <= '9') {
          num += c;
          i++;
        } else if (c === '.' && !seenDot) {
          seenDot = true;
          num += c;
          i++;
        } else break;
      }
      push('number', num, start);
      continue;
    }

    // Leading-dot decimals: .5
    if (ch === '.' && src[i + 1] && src[i + 1]! >= '0' && src[i + 1]! <= '9') {
      const start = i;
      let num = '.';
      i++;
      while (i < n && src[i]! >= '0' && src[i]! <= '9') {
        num += src[i];
        i++;
      }
      push('number', num, start);
      continue;
    }

    // Strings: "..." or '...'  (supports \\ \" \' \n \t escapes).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      let str = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const next = src[i + 1];
          if (next === 'n') str += '\n';
          else if (next === 't') str += '\t';
          else if (next === 'r') str += '\r';
          else if (next === '\\') str += '\\';
          else if (next === '"') str += '"';
          else if (next === "'") str += "'";
          else str += next ?? '';
          i += 2;
        } else {
          str += src[i];
          i++;
        }
      }
      if (i >= n) throw new FormulaError('Unterminated string literal');
      i++; // consume closing quote
      push('string', str, start);
      continue;
    }

    // Identifiers / keyword operators.
    if (isIdentStart(ch)) {
      const start = i;
      let id = '';
      while (i < n && isIdentPart(src[i]!)) {
        id += src[i];
        i++;
      }
      if (KEYWORD_OPS.has(id.toLowerCase())) push('op', id.toLowerCase(), start);
      else push('ident', id, start);
      continue;
    }

    // Multi-char operators.
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<>' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      push('op', two, i);
      i += 2;
      continue;
    }

    // Single-char tokens.
    switch (ch) {
      case '(':
        push('lparen', ch, i);
        i++;
        continue;
      case ')':
        push('rparen', ch, i);
        i++;
        continue;
      case ',':
        push('comma', ch, i);
        i++;
        continue;
      case '?':
        push('question', ch, i);
        i++;
        continue;
      case ':':
        push('colon', ch, i);
        i++;
        continue;
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '>':
      case '<':
      case '!':
        push('op', ch, i);
        i++;
        continue;
      default:
        throw new FormulaError(`Unexpected character '${ch}' at position ${i}`);
    }
  }

  push('eof', '', n);
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Ast =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'prop'; name: string }
  | { kind: 'unary'; op: string; arg: Ast }
  | { kind: 'binary'; op: string; left: Ast; right: Ast }
  | { kind: 'ternary'; cond: Ast; whenTrue: Ast; whenFalse: Ast }
  | { kind: 'call'; name: string; args: Ast[] };

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) throw new FormulaError(`Expected ${what} but found '${t.value || t.type}'`);
    return this.next();
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new FormulaError('Expression nesting too deep');
  }
  private leave(): void {
    this.depth--;
  }

  parse(): Ast {
    const ast = this.ternary();
    if (this.peek().type !== 'eof') {
      throw new FormulaError(`Unexpected trailing token '${this.peek().value}'`);
    }
    return ast;
  }

  private ternary(): Ast {
    this.enter();
    try {
      const cond = this.logicOr();
      if (this.peek().type === 'question') {
        this.next();
        const whenTrue = this.ternary();
        this.expect('colon', "':' in ternary");
        const whenFalse = this.ternary();
        return { kind: 'ternary', cond, whenTrue, whenFalse };
      }
      return cond;
    } finally {
      this.leave();
    }
  }

  private logicOr(): Ast {
    let left = this.logicAnd();
    while (this.peek().type === 'op' && (this.peek().value === 'or' || this.peek().value === '||')) {
      this.next();
      const right = this.logicAnd();
      left = { kind: 'binary', op: 'or', left, right };
    }
    return left;
  }

  private logicAnd(): Ast {
    let left = this.equality();
    while (this.peek().type === 'op' && (this.peek().value === 'and' || this.peek().value === '&&')) {
      this.next();
      const right = this.equality();
      left = { kind: 'binary', op: 'and', left, right };
    }
    return left;
  }

  private equality(): Ast {
    let left = this.comparison();
    while (this.peek().type === 'op' && ['==', '!=', '<>'].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.comparison();
      left = { kind: 'binary', op: op === '<>' ? '!=' : op, left, right };
    }
    return left;
  }

  private comparison(): Ast {
    let left = this.additive();
    while (this.peek().type === 'op' && ['>', '>=', '<', '<='].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.additive();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private additive(): Ast {
    let left = this.multiplicative();
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.multiplicative();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private multiplicative(): Ast {
    let left = this.unary();
    while (this.peek().type === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.unary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private unary(): Ast {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === 'not' || t.value === '!')) {
      this.next();
      this.enter();
      try {
        const arg = this.unary();
        return { kind: 'unary', op: t.value === '!' ? 'not' : t.value, arg };
      } finally {
        this.leave();
      }
    }
    return this.primary();
  }

  private primary(): Ast {
    const t = this.peek();
    // `and` / `or` / `not` double as function names; when one appears in operand
    // position immediately followed by '(', parse it as a function call.
    if (t.type === 'op' && KEYWORD_OPS.has(t.value) && this.tokens[this.pos + 1]?.type === 'lparen') {
      this.next(); // keyword
      this.next(); // (
      const args: Ast[] = [];
      if (this.peek().type !== 'rparen') {
        this.enter();
        try {
          args.push(this.ternary());
          while (this.peek().type === 'comma') {
            this.next();
            args.push(this.ternary());
          }
        } finally {
          this.leave();
        }
      }
      this.expect('rparen', "')' to close function call");
      return { kind: 'call', name: t.value, args };
    }
    switch (t.type) {
      case 'number': {
        this.next();
        const num = Number(t.value);
        if (!Number.isFinite(num)) throw new FormulaError(`Invalid number '${t.value}'`);
        return { kind: 'num', value: num };
      }
      case 'string':
        this.next();
        return { kind: 'str', value: t.value };
      case 'prop':
        this.next();
        if (!t.value) throw new FormulaError('Empty {{}} property reference');
        return { kind: 'prop', name: t.value };
      case 'lparen': {
        this.next();
        this.enter();
        try {
          const expr = this.ternary();
          this.expect('rparen', "')'");
          return expr;
        } finally {
          this.leave();
        }
      }
      case 'ident': {
        this.next();
        const lower = t.value.toLowerCase();
        if (lower === 'true') return { kind: 'bool', value: true };
        if (lower === 'false') return { kind: 'bool', value: false };
        // Must be a function call.
        if (this.peek().type !== 'lparen') {
          throw new FormulaError(`Unknown identifier '${t.value}' (functions need parentheses)`);
        }
        this.next(); // (
        const args: Ast[] = [];
        if (this.peek().type !== 'rparen') {
          this.enter();
          try {
            args.push(this.ternary());
            while (this.peek().type === 'comma') {
              this.next();
              args.push(this.ternary());
            }
          } finally {
            this.leave();
          }
        }
        this.expect('rparen', "')' to close function call");
        return { kind: 'call', name: t.value, args };
      }
      default:
        throw new FormulaError(`Unexpected token '${t.value || t.type}'`);
    }
  }
}

/**
 * Parse an expression string into a cacheable AST. Throws `FormulaError` on any
 * lexical / syntactic problem (including the length guard).
 */
export function parseFormula(expr: string): Ast {
  if (typeof expr !== 'string') throw new FormulaError('Expression must be a string');
  if (expr.length > MAX_EXPR_LEN) {
    throw new FormulaError(`Expression too long (max ${MAX_EXPR_LEN} chars)`);
  }
  const tokens = tokenize(expr);
  return new Parser(tokens).parse();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluation context. `resolveProp` maps a property NAME (case-insensitive,
 * caller's responsibility) to a coerced value, or returns the FormulaError
 * sentinel via throwing FormulaError when the property cannot/should-not be
 * resolved (e.g. a cyclic formula→formula reference).
 */
export interface FormulaContext {
  /** Resolve a property by name to its coerced JS value. Throw FormulaError to fail. */
  resolveProp: (name: string) => FormulaValue;
  /** Current instant; injectable so tests are deterministic. Defaults to new Date(). */
  now?: () => Date;
}

export type FormulaValue = number | string | boolean | Date | null;

function isDate(v: unknown): v is Date {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** Coerce any formula value to a number, or throw. */
function toNum(v: FormulaValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isDate(v)) return v.getTime();
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') throw new FormulaError('Cannot convert empty string to number');
    const n = Number(trimmed);
    if (!Number.isFinite(n)) throw new FormulaError(`Cannot convert '${v}' to number`);
    return n;
  }
  throw new FormulaError('Cannot convert null to number');
}

/** Human string formatting of any value (also the `format`/concat path). */
function toStr(v: FormulaValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (isDate(v)) return v.toISOString();
  // number
  return String(v);
}

/** Truthiness: false / 0 / '' / null / NaN are falsy. */
function truthy(v: FormulaValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (isDate(v)) return true;
  return false; // null
}

function isEmpty(v: FormulaValue): boolean {
  if (v === null) return true;
  if (typeof v === 'string') return v.length === 0;
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

const DAY_MS = 86_400_000;

/** Coerce to a Date for date functions, or throw. */
function toDate(v: FormulaValue): Date {
  if (isDate(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  throw new FormulaError('Expected a date value');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class Evaluator {
  private depth = 0;
  private readonly nowFn: () => Date;
  constructor(private readonly ctx: FormulaContext) {
    this.nowFn = ctx.now ?? (() => new Date());
  }

  eval(node: Ast): FormulaValue {
    if (++this.depth > MAX_DEPTH) throw new FormulaError('Evaluation nesting too deep');
    try {
      return this.evalNode(node);
    } finally {
      this.depth--;
    }
  }

  private evalNode(node: Ast): FormulaValue {
    switch (node.kind) {
      case 'num':
        return node.value;
      case 'str':
        return node.value;
      case 'bool':
        return node.value;
      case 'prop':
        return this.ctx.resolveProp(node.name);
      case 'unary':
        return this.evalUnary(node.op, node.arg);
      case 'binary':
        return this.evalBinary(node.op, node.left, node.right);
      case 'ternary':
        return truthy(this.eval(node.cond)) ? this.eval(node.whenTrue) : this.eval(node.whenFalse);
      case 'call':
        return this.evalCall(node.name, node.args);
    }
  }

  private evalUnary(op: string, argNode: Ast): FormulaValue {
    const v = this.eval(argNode);
    if (op === '-') return -toNum(v);
    if (op === 'not') return !truthy(v);
    throw new FormulaError(`Unknown unary operator '${op}'`);
  }

  private evalBinary(op: string, leftNode: Ast, rightNode: Ast): FormulaValue {
    // Short-circuit logical operators.
    if (op === 'and') {
      const l = this.eval(leftNode);
      return truthy(l) ? truthy(this.eval(rightNode)) : false;
    }
    if (op === 'or') {
      const l = this.eval(leftNode);
      return truthy(l) ? true : truthy(this.eval(rightNode));
    }

    const left = this.eval(leftNode);
    const right = this.eval(rightNode);

    switch (op) {
      case '+': {
        // Numeric add when BOTH numeric; otherwise string concat.
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        return toStr(left) + toStr(right);
      }
      case '-':
        return toNum(left) - toNum(right);
      case '*':
        return toNum(left) * toNum(right);
      case '/': {
        const d = toNum(right);
        if (d === 0) throw new FormulaError('Division by zero');
        return toNum(left) / d;
      }
      case '%': {
        const d = toNum(right);
        if (d === 0) throw new FormulaError('Modulo by zero');
        return toNum(left) % d;
      }
      case '==':
        return this.equals(left, right);
      case '!=':
        return !this.equals(left, right);
      case '>':
        return this.compare(left, right) > 0;
      case '>=':
        return this.compare(left, right) >= 0;
      case '<':
        return this.compare(left, right) < 0;
      case '<=':
        return this.compare(left, right) <= 0;
      default:
        throw new FormulaError(`Unknown operator '${op}'`);
    }
  }

  private equals(a: FormulaValue, b: FormulaValue): boolean {
    if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
    if (typeof a === 'number' || typeof b === 'number') {
      // Numeric comparison when either side is a number and the other coerces.
      try {
        return toNum(a) === toNum(b);
      } catch {
        return false;
      }
    }
    if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
    return toStr(a) === toStr(b);
  }

  private compare(a: FormulaValue, b: FormulaValue): number {
    if (isDate(a) && isDate(b)) return a.getTime() - b.getTime();
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    const an = toNum(a);
    const bn = toNum(b);
    return an - bn;
  }

  private args(nodes: Ast[]): FormulaValue[] {
    return nodes.map((n) => this.eval(n));
  }

  private evalCall(rawName: string, argNodes: Ast[]): FormulaValue {
    const name = rawName.toLowerCase();

    // Lazy-evaluated functions (don't eval all args up front).
    if (name === 'if') {
      if (argNodes.length !== 3) throw new FormulaError('if() takes exactly 3 arguments');
      return truthy(this.eval(argNodes[0]!)) ? this.eval(argNodes[1]!) : this.eval(argNodes[2]!);
    }
    if (name === 'and') {
      for (const node of argNodes) if (!truthy(this.eval(node))) return false;
      return true;
    }
    if (name === 'or') {
      for (const node of argNodes) if (truthy(this.eval(node))) return true;
      return false;
    }
    if (name === 'prop') {
      if (argNodes.length !== 1) throw new FormulaError('prop() takes exactly 1 argument');
      const nameVal = this.eval(argNodes[0]!);
      if (typeof nameVal !== 'string') throw new FormulaError('prop() argument must be a string');
      return this.ctx.resolveProp(nameVal);
    }

    const a = this.args(argNodes);

    switch (name) {
      case 'concat':
        return a.map(toStr).join('');
      case 'join': {
        if (a.length === 0) throw new FormulaError('join() needs a separator');
        const [sep, ...rest] = a;
        return rest.map(toStr).join(toStr(sep!));
      }
      case 'length': {
        const v = this.expect1(a, 'length');
        return toStr(v).length;
      }
      case 'round': {
        const x = toNum(a[0] ?? null);
        const digits = a.length > 1 ? Math.trunc(toNum(a[1]!)) : 0;
        const f = 10 ** digits;
        return Math.round(x * f) / f;
      }
      case 'floor':
        return Math.floor(toNum(this.expect1(a, 'floor')));
      case 'ceil':
        return Math.ceil(toNum(this.expect1(a, 'ceil')));
      case 'abs':
        return Math.abs(toNum(this.expect1(a, 'abs')));
      case 'min':
        if (a.length === 0) throw new FormulaError('min() needs at least 1 argument');
        return Math.min(...a.map(toNum));
      case 'max':
        if (a.length === 0) throw new FormulaError('max() needs at least 1 argument');
        return Math.max(...a.map(toNum));
      case 'sum':
        return a.map(toNum).reduce((x, y) => x + y, 0);
      case 'contains': {
        const [s, sub] = [a[0] ?? null, a[1] ?? null];
        return toStr(s).includes(toStr(sub));
      }
      case 'lower':
        return toStr(this.expect1(a, 'lower')).toLowerCase();
      case 'upper':
        return toStr(this.expect1(a, 'upper')).toUpperCase();
      case 'trim':
        return toStr(this.expect1(a, 'trim')).trim();
      case 'replace': {
        if (a.length !== 3) throw new FormulaError('replace() takes 3 arguments');
        const s = toStr(a[0]!);
        const find = toStr(a[1]!);
        const repl = toStr(a[2]!);
        if (find === '') return s;
        return s.replace(new RegExp(escapeRegExp(find), 'g'), repl);
      }
      case 'slice': {
        const s = toStr(a[0] ?? null);
        const start = a.length > 1 ? Math.trunc(toNum(a[1]!)) : 0;
        const end = a.length > 2 ? Math.trunc(toNum(a[2]!)) : undefined;
        return end === undefined ? s.slice(start) : s.slice(start, end);
      }
      case 'format':
        return toStr(this.expect1(a, 'format'));
      case 'number':
        return toNum(this.expect1(a, 'number'));
      case 'empty':
        return isEmpty(this.expect1(a, 'empty'));
      case 'notempty':
        return !isEmpty(this.expect1(a, 'notEmpty'));
      case 'not':
        return !truthy(this.expect1(a, 'not'));
      case 'now':
        return this.nowFn();
      case 'today': {
        const d = this.nowFn();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
      }
      case 'datebetween': {
        if (a.length !== 3) throw new FormulaError('dateBetween() takes 3 arguments');
        return this.dateBetween(toDate(a[0]!), toDate(a[1]!), toStr(a[2]!));
      }
      case 'dateadd': {
        if (a.length !== 3) throw new FormulaError('dateAdd() takes 3 arguments');
        return this.dateAdd(toDate(a[0]!), Math.trunc(toNum(a[1]!)), toStr(a[2]!));
      }
      case 'year':
        return toDate(this.expect1(a, 'year')).getFullYear();
      case 'month':
        return toDate(this.expect1(a, 'month')).getMonth() + 1;
      case 'day':
        return toDate(this.expect1(a, 'day')).getDate();
      case 'test': {
        if (a.length !== 2) throw new FormulaError('test() takes 2 arguments');
        const s = toStr(a[0]!);
        const pattern = toStr(a[1]!);
        if (pattern.length > MAX_REGEX_LEN) throw new FormulaError('Regex pattern too long');
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          throw new FormulaError('Invalid regular expression');
        }
        return re.test(s);
      }
      default:
        throw new FormulaError(`Unknown function '${rawName}'`);
    }
  }

  private expect1(a: FormulaValue[], fn: string): FormulaValue {
    if (a.length !== 1) throw new FormulaError(`${fn}() takes exactly 1 argument`);
    return a[0]!;
  }

  private dateBetween(a: Date, b: Date, unit: string): number {
    const u = unit.toLowerCase();
    if (u === 'days' || u === 'day') {
      return Math.trunc((a.getTime() - b.getTime()) / DAY_MS);
    }
    if (u === 'years' || u === 'year') {
      let years = a.getFullYear() - b.getFullYear();
      const m = a.getMonth() - b.getMonth();
      if (m < 0 || (m === 0 && a.getDate() < b.getDate())) years--;
      return years;
    }
    if (u === 'months' || u === 'month') {
      let months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
      if (a.getDate() < b.getDate()) months--;
      return months;
    }
    throw new FormulaError(`Unknown date unit '${unit}' (use days|months|years)`);
  }

  private dateAdd(d: Date, n: number, unit: string): Date {
    const u = unit.toLowerCase();
    const out = new Date(d.getTime());
    if (u === 'days' || u === 'day') {
      out.setDate(out.getDate() + n);
      return out;
    }
    if (u === 'months' || u === 'month') {
      out.setMonth(out.getMonth() + n);
      return out;
    }
    if (u === 'years' || u === 'year') {
      out.setFullYear(out.getFullYear() + n);
      return out;
    }
    throw new FormulaError(`Unknown date unit '${unit}' (use days|months|years)`);
  }
}

/**
 * Evaluate a parsed AST against a context. Throws `FormulaError` on any runtime
 * problem. Use `safeEvaluate` for the sentinel-returning variant.
 */
export function evaluateFormula(ast: Ast, ctx: FormulaContext): FormulaValue {
  return new Evaluator(ctx).eval(ast);
}

/**
 * Convenience: parse + evaluate, returning either a `FormulaValue` or the
 * `{ __error }` sentinel. Never throws. This is what the row query uses so a
 * single bad formula can never crash the page read.
 */
export function safeEvaluate(expr: string, ctx: FormulaContext): FormulaValue | FormulaErrorResult {
  try {
    const ast = parseFormula(expr);
    return evaluateFormula(ast, ctx);
  } catch (err) {
    if (err instanceof FormulaError) return { __error: err.message };
    return { __error: err instanceof Error ? err.message : 'Formula error' };
  }
}
