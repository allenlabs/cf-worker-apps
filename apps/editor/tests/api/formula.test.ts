// Unit tests for the Phase 7 no-eval formula engine.
//
// Covers: literals, arithmetic precedence, string concat, comparison + logical
// operators, ternary + if(), property refs (both {{}} and prop() syntaxes) with
// various stored value types, a representative set of functions, error cases
// (unknown fn, bad syntax, div-by-zero), and the length/depth safety guards.

import { describe, it, expect } from 'vitest';
import {
  parseFormula,
  evaluateFormula,
  safeEvaluate,
  isFormulaError,
  FormulaError,
  MAX_EXPR_LEN,
  MAX_DEPTH,
  type FormulaContext,
  type FormulaValue,
} from '@api/handlers/formula';

/** Build a context whose `prop("X")` resolves from a plain {name: value} map. */
function ctxFrom(
  props: Record<string, FormulaValue>,
  now?: () => Date,
): FormulaContext {
  const lower = new Map(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    resolveProp: (name) => {
      const key = name.toLowerCase();
      if (!lower.has(key)) throw new FormulaError(`Unknown property "${name}"`);
      return lower.get(key)!;
    },
    now,
  };
}

/** Parse + evaluate against a (possibly empty) prop map. */
function evalExpr(expr: string, props: Record<string, FormulaValue> = {}, now?: () => Date): FormulaValue {
  return evaluateFormula(parseFormula(expr), ctxFrom(props, now));
}

describe('literals', () => {
  it('parses integers and decimals', () => {
    expect(evalExpr('42')).toBe(42);
    expect(evalExpr('3.14')).toBe(3.14);
    expect(evalExpr('.5')).toBe(0.5);
  });
  it('parses double- and single-quoted strings', () => {
    expect(evalExpr('"hello"')).toBe('hello');
    expect(evalExpr("'world'")).toBe('world');
  });
  it('handles string escapes', () => {
    expect(evalExpr('"a\\nb"')).toBe('a\nb');
    expect(evalExpr('"tab\\tend"')).toBe('tab\tend');
    expect(evalExpr('"quote\\"in"')).toBe('quote"in');
    expect(evalExpr("'\\''")).toBe("'");
  });
  it('parses booleans (case-insensitive)', () => {
    expect(evalExpr('true')).toBe(true);
    expect(evalExpr('false')).toBe(false);
    expect(evalExpr('TRUE')).toBe(true);
  });
});

describe('arithmetic + precedence', () => {
  it('respects * over +', () => {
    expect(evalExpr('1 + 2 * 3')).toBe(7);
    expect(evalExpr('(1 + 2) * 3')).toBe(9);
  });
  it('subtraction, division, modulo', () => {
    expect(evalExpr('10 - 3')).toBe(7);
    expect(evalExpr('10 / 4')).toBe(2.5);
    expect(evalExpr('10 % 3')).toBe(1);
  });
  it('unary minus', () => {
    expect(evalExpr('-5')).toBe(-5);
    expect(evalExpr('-(2 + 3)')).toBe(-5);
    expect(evalExpr('3 - -2')).toBe(5);
  });
  it('left-associates same-precedence ops', () => {
    expect(evalExpr('10 - 3 - 2')).toBe(5);
    expect(evalExpr('20 / 2 / 5')).toBe(2);
  });
});

describe('string concat via +', () => {
  it('concats when either side is a string', () => {
    expect(evalExpr('"a" + "b"')).toBe('ab');
    expect(evalExpr('"n=" + 5')).toBe('n=5');
    expect(evalExpr('5 + " items"')).toBe('5 items');
  });
  it('adds numerically when both sides are numbers', () => {
    expect(evalExpr('2 + 3')).toBe(5);
  });
});

describe('comparison + logical', () => {
  it('numeric comparisons', () => {
    expect(evalExpr('3 > 2')).toBe(true);
    expect(evalExpr('3 >= 3')).toBe(true);
    expect(evalExpr('2 < 1')).toBe(false);
    expect(evalExpr('2 <= 2')).toBe(true);
  });
  it('equality and inequality (== != <>)', () => {
    expect(evalExpr('1 == 1')).toBe(true);
    expect(evalExpr('1 != 2')).toBe(true);
    expect(evalExpr('1 <> 2')).toBe(true);
    expect(evalExpr('"x" == "x"')).toBe(true);
    expect(evalExpr('"1" == 1')).toBe(true); // numeric coercion
  });
  it('string ordering compares lexicographically', () => {
    expect(evalExpr('"apple" < "banana"')).toBe(true);
  });
  it('and / or with keyword and symbol forms, short-circuit', () => {
    expect(evalExpr('true and false')).toBe(false);
    expect(evalExpr('true or false')).toBe(true);
    expect(evalExpr('true && true')).toBe(true);
    expect(evalExpr('false || true')).toBe(true);
    // short-circuit: right side (div-by-zero) never runs.
    expect(evalExpr('false and (1 / 0)')).toBe(false);
    expect(evalExpr('true or (1 / 0)')).toBe(true);
  });
  it('not / ! unary', () => {
    expect(evalExpr('not true')).toBe(false);
    expect(evalExpr('!false')).toBe(true);
    expect(evalExpr('not (1 > 2)')).toBe(true);
  });
});

describe('ternary and if()', () => {
  it('C-style ternary', () => {
    expect(evalExpr('1 > 0 ? "yes" : "no"')).toBe('yes');
    expect(evalExpr('0 > 1 ? "yes" : "no"')).toBe('no');
  });
  it('if() function form, lazy branches', () => {
    expect(evalExpr('if(true, "a", "b")')).toBe('a');
    expect(evalExpr('if(false, "a", "b")')).toBe('b');
    // the not-taken branch is not evaluated (no div-by-zero error).
    expect(evalExpr('if(true, 5, 1 / 0)')).toBe(5);
  });
});

describe('property refs (both syntaxes + value types)', () => {
  const props: Record<string, FormulaValue> = {
    Price: 100,
    Quantity: 3,
    Title: 'Widget',
    Done: true,
    When: new Date('2024-01-15T00:00:00Z'),
  };
  it('{{Name}} resolves a number prop', () => {
    expect(evalExpr('{{Price}} * {{Quantity}}', props)).toBe(300);
  });
  it('prop("Name") resolves identically', () => {
    expect(evalExpr('prop("Price") + 1', props)).toBe(101);
  });
  it('is case-insensitive', () => {
    expect(evalExpr('{{price}} + {{QUANTITY}}', props)).toBe(103);
  });
  it('resolves string, boolean, and date props', () => {
    expect(evalExpr('{{Title}} + "!"', props)).toBe('Widget!');
    expect(evalExpr('if({{Done}}, "ok", "no")', props)).toBe('ok');
    expect(evalExpr('year({{When}})', props)).toBe(2024);
  });
  it('mixes both syntaxes in one expression', () => {
    expect(evalExpr('{{Price}} + prop("Quantity")', props)).toBe(103);
  });
});

describe('functions', () => {
  it('round with and without digits', () => {
    expect(evalExpr('round(3.14159)')).toBe(3);
    expect(evalExpr('round(3.14159, 2)')).toBe(3.14);
    expect(evalExpr('round(2.5)')).toBe(3);
  });
  it('floor / ceil / abs', () => {
    expect(evalExpr('floor(3.9)')).toBe(3);
    expect(evalExpr('ceil(3.1)')).toBe(4);
    expect(evalExpr('abs(-7)')).toBe(7);
  });
  it('min / max / sum', () => {
    expect(evalExpr('min(3, 1, 2)')).toBe(1);
    expect(evalExpr('max(3, 1, 2)')).toBe(3);
    expect(evalExpr('sum(1, 2, 3, 4)')).toBe(10);
  });
  it('concat / join', () => {
    expect(evalExpr('concat("a", "b", "c")')).toBe('abc');
    expect(evalExpr('concat("n=", 5)')).toBe('n=5');
    expect(evalExpr('join("-", "a", "b", "c")')).toBe('a-b-c');
  });
  it('length of string', () => {
    expect(evalExpr('length("hello")')).toBe(5);
  });
  it('contains substring', () => {
    expect(evalExpr('contains("hello world", "world")')).toBe(true);
    expect(evalExpr('contains("hello", "xyz")')).toBe(false);
  });
  it('lower / upper / trim', () => {
    expect(evalExpr('lower("ABC")')).toBe('abc');
    expect(evalExpr('upper("abc")')).toBe('ABC');
    expect(evalExpr('trim("  hi  ")')).toBe('hi');
  });
  it('replace replaces all occurrences (literal find)', () => {
    expect(evalExpr('replace("a.b.c", ".", "-")')).toBe('a-b-c');
    expect(evalExpr('replace("aaa", "a", "b")')).toBe('bbb');
  });
  it('slice', () => {
    expect(evalExpr('slice("hello", 1, 3)')).toBe('el');
    expect(evalExpr('slice("hello", 2)')).toBe('llo');
  });
  it('format / number', () => {
    expect(evalExpr('format(42)')).toBe('42');
    expect(evalExpr('format(true)')).toBe('true');
    expect(evalExpr('number("3.5") + 1')).toBe(4.5);
  });
  it('empty / notEmpty', () => {
    expect(evalExpr('empty("")')).toBe(true);
    expect(evalExpr('empty("x")')).toBe(false);
    expect(evalExpr('notEmpty("x")')).toBe(true);
    expect(evalExpr('empty({{Missing}})', { Missing: null })).toBe(true);
  });
  it('and / or / not function forms', () => {
    expect(evalExpr('and(true, true, 1 > 0)')).toBe(true);
    expect(evalExpr('and(true, false)')).toBe(false);
    expect(evalExpr('or(false, false, true)')).toBe(true);
    expect(evalExpr('not(false)')).toBe(true);
  });
  it('test() regex', () => {
    expect(evalExpr('test("abc123", "[0-9]+")')).toBe(true);
    expect(evalExpr('test("abc", "[0-9]+")')).toBe(false);
  });
});

describe('date functions', () => {
  const fixedNow = () => new Date('2024-06-15T12:00:00Z');
  it('now() / today()', () => {
    const now = evalExpr('now()', {}, fixedNow);
    expect(now).toBeInstanceOf(Date);
    const today = evalExpr('today()', {}, fixedNow) as Date;
    expect(today).toBeInstanceOf(Date);
    expect(today.getHours()).toBe(0);
  });
  it('year / month / day from a date string', () => {
    expect(evalExpr('year("2024-03-09")')).toBe(2024);
    expect(evalExpr('month("2024-03-09")')).toBe(3);
    expect(evalExpr('day("2024-03-09")')).toBe(9);
  });
  it('dateBetween in days, months, years', () => {
    expect(evalExpr('dateBetween("2024-01-11", "2024-01-01", "days")')).toBe(10);
    expect(evalExpr('dateBetween("2024-04-01", "2024-01-01", "months")')).toBe(3);
    expect(evalExpr('dateBetween("2024-06-15", "2020-06-15", "years")')).toBe(4);
  });
  it('dateAdd days/months/years', () => {
    expect(evalExpr('day(dateAdd("2024-01-01", 5, "days"))')).toBe(6);
    expect(evalExpr('month(dateAdd("2024-01-01", 2, "months"))')).toBe(3);
    expect(evalExpr('year(dateAdd("2024-01-01", 1, "years"))')).toBe(2025);
  });
});

describe('error cases', () => {
  it('unknown function → FormulaError', () => {
    expect(() => evalExpr('bogus(1)')).toThrow(FormulaError);
  });
  it('bare unknown identifier → FormulaError', () => {
    expect(() => evalExpr('foobar')).toThrow(/Unknown identifier/);
  });
  it('bad syntax → FormulaError', () => {
    expect(() => parseFormula('1 +')).toThrow(FormulaError);
    expect(() => parseFormula('(1 + 2')).toThrow(FormulaError);
    expect(() => parseFormula('1 2 3')).toThrow(FormulaError);
  });
  it('unterminated string / prop ref', () => {
    expect(() => parseFormula('"abc')).toThrow(/Unterminated string/);
    expect(() => parseFormula('{{Name')).toThrow(/Unterminated/);
  });
  it('unexpected character', () => {
    expect(() => parseFormula('1 @ 2')).toThrow(/Unexpected character/);
  });
  it('division / modulo by zero → FormulaError', () => {
    expect(() => evalExpr('1 / 0')).toThrow(/Division by zero/);
    expect(() => evalExpr('1 % 0')).toThrow(/Modulo by zero/);
  });
  it('wrong arity → FormulaError', () => {
    expect(() => evalExpr('if(true)')).toThrow(/exactly 3/);
    expect(() => evalExpr('round()')).toThrow();
    expect(() => evalExpr('abs(1, 2)')).toThrow(/exactly 1/);
  });
  it('non-numeric coercion → FormulaError', () => {
    expect(() => evalExpr('"abc" * 2')).toThrow(/convert/);
    expect(() => evalExpr('number("nope")')).toThrow(/convert/);
  });
  it('unknown property → FormulaError', () => {
    expect(() => evalExpr('{{Nope}}', {})).toThrow(/Unknown property/);
  });
  it('unknown date unit → FormulaError', () => {
    expect(() => evalExpr('dateAdd("2024-01-01", 1, "weeks")')).toThrow(/date unit/);
  });
});

describe('safety guards', () => {
  it('rejects over-length expressions', () => {
    const long = '1 + '.repeat(MAX_EXPR_LEN) + '1';
    expect(() => parseFormula(long)).toThrow(/too long/);
  });
  it('rejects over-deep nesting at parse time', () => {
    const deep = '('.repeat(MAX_DEPTH + 5) + '1' + ')'.repeat(MAX_DEPTH + 5);
    expect(() => parseFormula(deep)).toThrow(/too deep/);
  });
  it('caps regex pattern length', () => {
    const pattern = 'a'.repeat(300);
    expect(() => evalExpr(`test("x", "${pattern}")`)).toThrow(/too long/);
  });
});

describe('safeEvaluate sentinel', () => {
  it('returns a value on success', () => {
    expect(safeEvaluate('1 + 1', ctxFrom({}))).toBe(2);
  });
  it('returns { __error } instead of throwing on failure', () => {
    const r = safeEvaluate('1 / 0', ctxFrom({}));
    expect(isFormulaError(r)).toBe(true);
    if (isFormulaError(r)) expect(r.__error).toMatch(/Division by zero/);
  });
  it('returns { __error } on parse failure', () => {
    const r = safeEvaluate('1 +', ctxFrom({}));
    expect(isFormulaError(r)).toBe(true);
  });
  it('isFormulaError rejects non-sentinels', () => {
    expect(isFormulaError(5)).toBe(false);
    expect(isFormulaError(null)).toBe(false);
    expect(isFormulaError({ value: 1 })).toBe(false);
  });
});

describe('integration: realistic formulas', () => {
  const props: Record<string, FormulaValue> = {
    Price: 19.99,
    Qty: 4,
    Status: 'Done',
    Done: true,
    Start: new Date('2024-01-01T00:00:00Z'),
  };
  it('total with tax, rounded', () => {
    expect(evalExpr('round({{Price}} * {{Qty}} * 1.1, 2)', props)).toBe(87.96);
  });
  it('conditional label', () => {
    expect(evalExpr('if({{Status}} == "Done", "✓ " + {{Status}}, "pending")', props)).toBe('✓ Done');
  });
  it('nested functions', () => {
    expect(evalExpr('upper(concat("item-", {{Qty}}))', props)).toBe('ITEM-4');
  });
});
