/**
 * A Word equation (OMML) as LaTeX and MathML.
 *
 * An equation used to be the word [equation] and its content was lost. It is read into one small tree, and the LaTeX and the MathML are
 * both written from that tree, so the two cannot disagree. The original is kept as well (an allow-listed copy of Word's own XML, which
 * a printed Word file can carry as a real equation).
 *
 * What is read is what Word writes for the constructs a test uses: fractions, roots, scripts on either side, sums and integrals with
 * limits, brackets, functions, accents and bars, limits, matrices, arrays of equations, braces over and under, and the style of a run
 * (plain, bold, script and so on). An element that is none of these makes the whole equation unread, with the name of the element, and
 * the equation keeps its marker: a wrong equation that looks right is worse than a marker that says it was not read.
 */

import { allText, elements, first, parseXml, type XmlElement } from "./xml.ts";

export interface MathReading {
  latex: string;
  /** A whole `<math>` element in presentation MathML. */
  mathml: string;
  /** Word's own XML for the equation, from the supported elements only, with its namespace declared. */
  omml: string;
}

export type MathResult = { ok: true; math: MathReading } | { ok: false; reason: string };

/** Deeper than any equation is, and more elements than one should have: a file that has more is damaged or hostile. */
const MAX_DEPTH = 60;
const MAX_NODES = 5000;

class Unread extends Error {}
const refuse = (reason: string): never => {
  throw new Unread(reason);
};

type Variant = "normal" | "bold" | "bold-italic" | "script" | "fraktur" | "double-struck" | "sans-serif" | "monospace";

type Node =
  | { k: "row"; items: Node[] }
  | { k: "id"; v: string; variant?: Variant }
  | { k: "num"; v: string; variant?: Variant }
  | { k: "op"; v: string }
  | { k: "text"; v: string }
  | { k: "frac"; num: Node; den: Node; bar: boolean }
  | { k: "rad"; deg?: Node; e: Node }
  | { k: "script"; base: Node; sub?: Node; sup?: Node }
  | { k: "pre"; base: Node; sub?: Node; sup?: Node }
  | { k: "nary"; chr: string; sub?: Node; sup?: Node; e: Node; limits: boolean }
  | { k: "delim"; open: string; close: string; sep: string; items: Node[] }
  | { k: "func"; name: Node; e: Node }
  | { k: "accent"; chr: string; e: Node }
  | { k: "bar"; top: boolean; e: Node }
  | { k: "under" | "over"; e: Node; lim: Node }
  | { k: "matrix"; rows: Node[][] }
  | { k: "eqarr"; rows: Node[] }
  | { k: "group"; chr: string; top: boolean; e: Node }
  | { k: "phantom"; e: Node }
  | { k: "boxed"; e: Node };

// ---------------------------------------------------------------------------
// Reading Word's XML
// ---------------------------------------------------------------------------

/** The elements that hold properties and no content: they say how, and are read where they are used. */
const isProperties = (name: string): boolean => name.startsWith("m:") && (name.endsWith("Pr") || name === "m:ctrlPr");

/** The `m:val` of a child, or undefined when the child is not there. A child with no value is "on". */
function valueOf(parent: XmlElement | undefined, name: string): string | undefined {
  const c = parent ? first(parent, name) : undefined;
  return c === undefined ? undefined : (c.attrs["m:val"] ?? "1");
}

const truthy = (v: string | undefined): boolean => v !== undefined && v !== "0" && v !== "false" && v !== "off";

class Reader {
  private count = 0;

  private tick(depth: number): void {
    if (depth > MAX_DEPTH) refuse("it is nested more deeply than an equation is");
    if (++this.count > MAX_NODES) refuse("it has more parts than an equation has");
  }

  /** The children of an element, in order, as one row. */
  row(el: XmlElement | undefined, depth: number, inArray = false): Node {
    const items: Node[] = [];
    if (el) for (const c of el.children) this.into(c, items, depth, inArray);
    return items.length === 1 ? (items[0] as Node) : { k: "row", items };
  }

  /** One child of a row: an element read into nodes, a property element passed over, or a refusal. */
  private into(c: XmlElement | string, out: Node[], depth: number, inArray: boolean): void {
    if (typeof c === "string") {
      if (c.trim() !== "") refuse("it has loose text that is not in a run");
      return;
    }
    this.tick(depth);
    const name = c.name;
    if (isProperties(name)) return;
    switch (name) {
      case "m:r":
        out.push(...this.run(c, inArray));
        return;
      case "m:f":
        out.push({ k: "frac", num: this.row(first(c, "m:num"), depth + 1, inArray), den: this.row(first(c, "m:den"), depth + 1, inArray), bar: valueOf(first(c, "m:fPr"), "m:type") !== "noBar" });
        return;
      case "m:rad": {
        const hidden = truthy(valueOf(first(c, "m:radPr"), "m:degHide"));
        const deg = hidden ? undefined : this.row(first(c, "m:deg"), depth + 1, inArray);
        out.push({ k: "rad", ...(deg && !(deg.k === "row" && deg.items.length === 0) ? { deg } : {}), e: this.row(first(c, "m:e"), depth + 1, inArray) });
        return;
      }
      case "m:sSup":
        out.push({ k: "script", base: this.row(first(c, "m:e"), depth + 1, inArray), sup: this.row(first(c, "m:sup"), depth + 1, inArray) });
        return;
      case "m:sSub":
        out.push({ k: "script", base: this.row(first(c, "m:e"), depth + 1, inArray), sub: this.row(first(c, "m:sub"), depth + 1, inArray) });
        return;
      case "m:sSubSup":
        out.push({ k: "script", base: this.row(first(c, "m:e"), depth + 1, inArray), sub: this.row(first(c, "m:sub"), depth + 1, inArray), sup: this.row(first(c, "m:sup"), depth + 1, inArray) });
        return;
      case "m:sPre":
        out.push({ k: "pre", base: this.row(first(c, "m:e"), depth + 1, inArray), sub: this.row(first(c, "m:sub"), depth + 1, inArray), sup: this.row(first(c, "m:sup"), depth + 1, inArray) });
        return;
      case "m:nary": {
        const pr = first(c, "m:naryPr");
        // The sign defaults to the integral. Limits sit under and over a sum and beside an integral unless the equation says.
        const chr = pr && first(pr, "m:chr") ? (first(pr, "m:chr")?.attrs["m:val"] ?? "") : "∫";
        const placed = valueOf(pr, "m:limLoc");
        const limits = placed === undefined ? !["∫", "∬", "∭", "∮", "∯", "∰"].includes(chr) : placed === "undOvr";
        const sub = truthy(valueOf(pr, "m:subHide")) ? undefined : this.row(first(c, "m:sub"), depth + 1, inArray);
        const sup = truthy(valueOf(pr, "m:supHide")) ? undefined : this.row(first(c, "m:sup"), depth + 1, inArray);
        out.push({ k: "nary", chr, ...(sub ? { sub } : {}), ...(sup ? { sup } : {}), e: this.row(first(c, "m:e"), depth + 1, inArray), limits });
        return;
      }
      case "m:d": {
        const pr = first(c, "m:dPr");
        const ch = (n: string, fallback: string): string => (pr && first(pr, n) ? (first(pr, n)?.attrs["m:val"] ?? "") : fallback);
        out.push({ k: "delim", open: ch("m:begChr", "("), close: ch("m:endChr", ")"), sep: ch("m:sepChr", "|"), items: elements(c, "m:e").map((e) => this.row(e, depth + 1, inArray)) });
        return;
      }
      case "m:func":
        out.push({ k: "func", name: this.row(first(c, "m:fName"), depth + 1, inArray), e: this.row(first(c, "m:e"), depth + 1, inArray) });
        return;
      case "m:acc": {
        const pr = first(c, "m:accPr");
        out.push({ k: "accent", chr: pr && first(pr, "m:chr") ? (first(pr, "m:chr")?.attrs["m:val"] ?? "") : "̂", e: this.row(first(c, "m:e"), depth + 1, inArray) });
        return;
      }
      case "m:bar": {
        // Word always writes which side the line is on. One that does not say is not guessed at.
        const pos = valueOf(first(c, "m:barPr"), "m:pos");
        if (pos !== "top" && pos !== "bot") refuse("it has a bar that does not say whether it is over or under");
        out.push({ k: "bar", top: pos === "top", e: this.row(first(c, "m:e"), depth + 1, inArray) });
        return;
      }
      case "m:limLow":
        out.push({ k: "under", e: this.row(first(c, "m:e"), depth + 1, inArray), lim: this.row(first(c, "m:lim"), depth + 1, inArray) });
        return;
      case "m:limUpp":
        out.push({ k: "over", e: this.row(first(c, "m:e"), depth + 1, inArray), lim: this.row(first(c, "m:lim"), depth + 1, inArray) });
        return;
      case "m:m":
        out.push({ k: "matrix", rows: elements(c, "m:mr").map((r) => elements(r, "m:e").map((e) => this.row(e, depth + 2, inArray))) });
        return;
      case "m:eqArr":
        out.push({ k: "eqarr", rows: elements(c, "m:e").map((e) => this.row(e, depth + 1, true)) });
        return;
      case "m:groupChr": {
        const pr = first(c, "m:groupChrPr");
        out.push({ k: "group", chr: pr && first(pr, "m:chr") ? (first(pr, "m:chr")?.attrs["m:val"] ?? "") : "⏟", top: valueOf(pr, "m:pos") === "top", e: this.row(first(c, "m:e"), depth + 1, inArray) });
        return;
      }
      case "m:box":
        out.push(this.row(first(c, "m:e"), depth + 1, inArray));
        return;
      case "m:phant":
        out.push(valueOf(first(c, "m:phantPr"), "m:show") === "0" ? { k: "phantom", e: this.row(first(c, "m:e"), depth + 1, inArray) } : this.row(first(c, "m:e"), depth + 1, inArray));
        return;
      case "m:borderBox": {
        const pr = first(c, "m:borderBoxPr");
        // Struck-through and half-boxed equations are not boxes: they are not read.
        if (pr && elements(pr).some((p) => p.name.startsWith("m:strike") || p.name.startsWith("m:hide"))) refuse("it has a border box with a strike-through or a side left off");
        out.push({ k: "boxed", e: this.row(first(c, "m:e"), depth + 1, inArray) });
        return;
      }
      // Changes tracked inside an equation: what was inserted is read, what was deleted is not (the document is read with the changes accepted).
      case "w:ins":
      case "w:moveTo":
        for (const inner of c.children) this.into(inner, out, depth, inArray);
        return;
      case "w:del":
      case "w:moveFrom":
      case "w:bookmarkStart":
      case "w:bookmarkEnd":
      case "w:proofErr":
        return;
      default:
        refuse(`it holds ${name}, which is not a part of an equation this reads`);
    }
  }

  /** A run: its style, and its text as the tokens of an equation. */
  private run(r: XmlElement, inArray: boolean): Node[] {
    const pr = first(r, "m:rPr");
    const sty = valueOf(pr, "m:sty");
    const normal = pr !== undefined && first(pr, "m:nor") !== undefined && truthy(valueOf(pr, "m:nor"));
    const script = valueOf(pr, "m:scr");
    let text = "";
    for (const c of r.children) {
      if (typeof c === "string") {
        if (c.trim() !== "") refuse("it has loose text in a run");
        continue;
      }
      if (c.name === "m:t") text += allText(c);
      else if (c.name === "m:rPr" || c.name === "w:rPr" || c.name === "w:proofErr") continue;
      else refuse(`it holds ${c.name} in a run`);
    }
    if (normal) return text === "" ? [] : [{ k: "text", v: text }];
    let variant: Variant | undefined;
    if (script === "script") variant = "script";
    else if (script === "fraktur") variant = "fraktur";
    else if (script === "double-struck") variant = "double-struck";
    else if (script === "sans-serif") variant = "sans-serif";
    else if (script === "monospace") variant = "monospace";
    else if (sty === "b") variant = "bold";
    else if (sty === "bi") variant = "bold-italic";
    else if (sty === "p") variant = "normal";
    return tokens(text, variant, inArray);
  }
}

/** The text of a run as numbers, letters and signs. A word in a plain run (sin, cm) is one name. */
function tokens(text: string, variant: Variant | undefined, inArray: boolean): Node[] {
  const out: Node[] = [];
  const chars = [...text];
  let i = 0;
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);
  while (i < chars.length) {
    const c = chars[i] as string;
    if (/\s/u.test(c)) {
      i++;
    } else if (isDigit(c)) {
      let v = c;
      i++;
      while (i < chars.length && (isDigit(chars[i]) || ((chars[i] === "." || chars[i] === ",") && isDigit(chars[i + 1])))) v += chars[i++];
      out.push({ k: "num", v, ...(variant ? { variant } : {}) });
    } else if (isLetter(c)) {
      let v = c;
      i++;
      // A combining mark belongs to the letter before it.
      while (i < chars.length && /\p{M}/u.test(chars[i] as string)) v += chars[i++];
      if (variant === "normal") while (i < chars.length && isLetter(chars[i])) v += chars[i++];
      out.push({ k: "id", v, ...(variant ? { variant } : {}) });
    } else if (/\p{M}/u.test(c) && out.length > 0 && out[out.length - 1]?.k === "id") {
      (out[out.length - 1] as { v: string }).v += c;
      i++;
    } else {
      // "&" in an array of equations is where the lines line up.
      out.push({ k: "op", v: inArray && c === "&" ? "&align" : c });
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LaTeX
// ---------------------------------------------------------------------------

const GREEK: Record<string, string> = {
  "α": "\\alpha", "β": "\\beta", "γ": "\\gamma", "δ": "\\delta", "ε": "\\varepsilon", "ϵ": "\\epsilon", "ζ": "\\zeta",
  "η": "\\eta", "θ": "\\theta", "ϑ": "\\vartheta", "ι": "\\iota", "κ": "\\kappa", "λ": "\\lambda", "μ": "\\mu",
  "ν": "\\nu", "ξ": "\\xi", "π": "\\pi", "ϖ": "\\varpi", "ρ": "\\rho", "ϱ": "\\varrho", "σ": "\\sigma", "ς": "\\varsigma",
  "τ": "\\tau", "υ": "\\upsilon", "φ": "\\varphi", "ϕ": "\\phi", "χ": "\\chi", "ψ": "\\psi", "ω": "\\omega",
  "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda", "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Υ": "\\Upsilon",
  "Φ": "\\Phi", "Ψ": "\\Psi", "Ω": "\\Omega",
};

const SIGNS: Record<string, string> = {
  "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot", "∗": "\\ast", "∘": "\\circ",
  "∙": "\\bullet", "•": "\\bullet", "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim",
  "≅": "\\cong", "∝": "\\propto", "≪": "\\ll", "≫": "\\gg", "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "∈": "\\in",
  "∉": "\\notin", "⊂": "\\subset", "⊆": "\\subseteq", "⊃": "\\supset", "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap",
  "∅": "\\emptyset", "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\wedge", "∨": "\\vee", "→": "\\to",
  "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↑": "\\uparrow",
  "↓": "\\downarrow", "°": "^{\\circ}", "′": "'", "″": "''", "−": "-", "…": "\\ldots", "⋯": "\\cdots", "∴": "\\therefore",
  "∵": "\\because", "∠": "\\angle", "⊥": "\\perp", "∥": "\\parallel", "ℏ": "\\hbar", "ℓ": "\\ell", "ℵ": "\\aleph", "√": "\\surd",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", " ": "\\ ", "{": "\\{", "}": "\\}", "\\": "\\backslash", "$": "\\$", "%": "\\%", "&": "\\&", "#": "\\#",
  "_": "\\_", "^": "\\^{}", "~": "\\sim",
};

const NARY: Record<string, string> = {
  "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint", "∯": "\\oiint",
  "∰": "\\oiiint", "⋃": "\\bigcup", "⋂": "\\bigcap", "⋁": "\\bigvee", "⋀": "\\bigwedge", "⨁": "\\bigoplus", "⨂": "\\bigotimes",
};

const ACCENT: Record<string, string> = {
  "̂": "hat", "^": "hat", "̄": "bar", "̅": "overline", "¯": "bar", "→": "vec", "⃗": "vec", "̇": "dot", "̈": "ddot", "̃": "tilde",
  "~": "tilde", "́": "acute", "̀": "grave", "̆": "breve", "̌": "check", "ˇ": "check",
};

const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp", "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det", "dim", "gcd", "ker", "deg", "arg", "Pr", "hom"]);

const FENCE: Record<string, string> = { "": ".", "(": "(", ")": ")", "[": "[", "]": "]", "{": "\\{", "}": "\\}", "|": "|", "‖": "\\|", "⟨": "\\langle", "⟩": "\\rangle", "〈": "\\langle", "〉": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil" };

/** A bracket Word offers that is one plain character and is the same in LaTeX. Anything else it offers is in the table above. */
const PLAIN_FENCE = /^[<>/.]$/u;

/** The bracket for `\left` or `\right`. One that is neither in the table nor plain is not read: LaTeX with a made-up bracket does not mean what Word shows. */
function fence(v: string): string {
  const known = own(FENCE, v);
  if (known !== undefined) return known;
  if (PLAIN_FENCE.test(v)) return v;
  return refuse(`it has a bracket (${JSON.stringify(v)}) that this does not read`);
}

/** What stands between the parts of a bracket that holds several (Word's default is a bar). */
function separator(v: string): string {
  if (v === "") return " ";
  if (v === "|") return "\\mid";
  if (/^[,;:./]$/u.test(v)) return v;
  return refuse(`it has a separator (${JSON.stringify(v)}) that this does not read`);
}

const WRAP: Record<string, string> = { normal: "\\mathrm", bold: "\\mathbf", "bold-italic": "\\boldsymbol", script: "\\mathcal", fraktur: "\\mathfrak", "double-struck": "\\mathbb", "sans-serif": "\\mathsf", monospace: "\\mathtt" };

/** Letters that stand for a set of numbers, which are written as the letter in blackboard bold. */
const SETS: Record<string, string> = { "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}" };

/**
 * A table's entry for a key, and nothing the key might name on every object. The keys here come from a file: a run of the word
 * "constructor" must not come back as the function of that name.
 */
const own = (table: Record<string, string>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

function texText(s: string): string {
  return s.replace(/[\\{}$&#_%^~]/g, (c) => ({ "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", _: "\\_", "%": "\\%", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}" })[c] as string);
}

/** Pieces put together, with a space where a command that ends in a letter is followed by a letter. */
function join(parts: string[]): string {
  let out = "";
  for (const p of parts) {
    if (p === "") continue;
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(p)) out += " ";
    out += p;
  }
  return out;
}

/** An argument: braces round it unless it is one plain character. */
const arg = (s: string): string => (/^[A-Za-z0-9]$/.test(s) ? s : `{${s}}`);

function tex(n: Node): string {
  switch (n.k) {
    case "row":
      return join(n.items.map(tex));
    case "id": {
      const set = own(SETS, n.v);
      if (set) return set;
      const greek = own(GREEK, n.v);
      const wrap = n.variant ? own(WRAP, n.variant) : undefined;
      const word = [...n.v].length > 1 && !/\p{M}/u.test(n.v);
      const letter = greek ?? n.v;
      return wrap && (n.variant !== "normal" || word || !greek) ? `${wrap}{${letter}}` : letter;
    }
    case "num": {
      const wrap = n.variant && n.variant !== "normal" ? own(WRAP, n.variant) : undefined;
      return wrap ? `${wrap}{${n.v}}` : n.v;
    }
    case "op":
      return n.v === "&align" ? "&" : (own(SIGNS, n.v) ?? n.v);
    case "text":
      return `\\text{${texText(n.v)}}`;
    case "frac":
      return n.bar ? `\\frac{${tex(n.num)}}{${tex(n.den)}}` : `\\binom{${tex(n.num)}}{${tex(n.den)}}`;
    case "rad":
      return n.deg ? `\\sqrt[${tex(n.deg)}]{${tex(n.e)}}` : `\\sqrt{${tex(n.e)}}`;
    case "script":
      return `${arg(tex(n.base))}${n.sub ? `_{${tex(n.sub)}}` : ""}${n.sup ? `^{${tex(n.sup)}}` : ""}`;
    case "pre":
      return `{}${n.sub ? `_{${tex(n.sub)}}` : ""}${n.sup ? `^{${tex(n.sup)}}` : ""}${arg(tex(n.base))}`;
    case "nary": {
      const sign = own(NARY, n.chr) ?? (n.chr === "" ? "" : `\\operatorname{${texText(n.chr)}}`);
      return join([`${sign}${n.limits && sign !== "" ? "\\limits" : ""}${n.sub ? `_{${tex(n.sub)}}` : ""}${n.sup ? `^{${tex(n.sup)}}` : ""}`, tex(n.e)]);
    }
    case "delim": {
      const sep = separator(n.sep);
      return `\\left${fence(n.open)} ${n.items.map(tex).join(` ${sep} `)} \\right${fence(n.close)}`;
    }
    case "func": {
      const name = tex(n.name);
      const plain = n.name.k === "id" ? n.name.v : n.name.k === "row" ? n.name.items.map((i) => (i.k === "id" ? i.v : "")).join("") : "";
      const head = FUNCTIONS.has(plain) ? `\\${plain}` : name.replace(/^\\mathrm\{(.*)\}$/, "\\operatorname{$1}");
      return join([head, tex(n.e)]);
    }
    case "accent": {
      const cmd = own(ACCENT, n.chr);
      return cmd ? `\\${cmd}{${tex(n.e)}}` : `\\overset{${texText(n.chr)}}{${tex(n.e)}}`;
    }
    case "bar":
      return n.top ? `\\overline{${tex(n.e)}}` : `\\underline{${tex(n.e)}}`;
    case "under": {
      const head = n.e.k === "id" && FUNCTIONS.has(n.e.v) ? `\\${n.e.v}` : n.e.k === "row" && FUNCTIONS.has(n.e.items.map((i) => (i.k === "id" ? i.v : "")).join("")) ? `\\${n.e.items.map((i) => (i.k === "id" ? i.v : "")).join("")}` : undefined;
      return head ? `${head}_{${tex(n.lim)}}` : `\\underset{${tex(n.lim)}}{${tex(n.e)}}`;
    }
    case "over":
      return `\\overset{${tex(n.lim)}}{${tex(n.e)}}`;
    case "matrix":
      return `\\begin{matrix} ${n.rows.map((r) => r.map(tex).join(" & ")).join(" \\\\ ")} \\end{matrix}`;
    case "eqarr":
      return `\\begin{aligned} ${n.rows.map(tex).join(" \\\\ ")} \\end{aligned}`;
    case "group":
      // A brace is a brace only on the side it is drawn for (the one that opens down goes under); any other mark is set on the side given.
      return n.chr === "⏞" && n.top ? `\\overbrace{${tex(n.e)}}` : n.chr === "⏟" && !n.top ? `\\underbrace{${tex(n.e)}}` : n.top ? `\\overset{${texText(n.chr)}}{${tex(n.e)}}` : `\\underset{${texText(n.chr)}}{${tex(n.e)}}`;
    case "phantom":
      return `\\phantom{${tex(n.e)}}`;
    case "boxed":
      return `\\boxed{${tex(n.e)}}`;
  }
}

// ---------------------------------------------------------------------------
// MathML
// ---------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mrow = (items: string[]): string => (items.length === 1 ? (items[0] as string) : `<mrow>${items.join("")}</mrow>`);
const variantAttr = (v: Variant | undefined): string => (v ? ` mathvariant="${v}"` : "");

function ml(n: Node): string {
  switch (n.k) {
    case "row":
      return n.items.length === 0 ? "<mrow></mrow>" : mrow(n.items.map(ml));
    case "id":
      return `<mi${variantAttr(n.variant)}>${esc(n.v)}</mi>`;
    case "num":
      return `<mn${variantAttr(n.variant)}>${esc(n.v)}</mn>`;
    case "op":
      return n.v === "&align" ? "" : `<mo>${esc(n.v)}</mo>`;
    case "text":
      return `<mtext>${esc(n.v)}</mtext>`;
    case "frac":
      return `<mfrac${n.bar ? "" : ' linethickness="0"'}>${ml(n.num)}${ml(n.den)}</mfrac>`;
    case "rad":
      return n.deg ? `<mroot>${ml(n.e)}${ml(n.deg)}</mroot>` : `<msqrt>${ml(n.e)}</msqrt>`;
    case "script":
      return n.sub && n.sup ? `<msubsup>${ml(n.base)}${ml(n.sub)}${ml(n.sup)}</msubsup>` : n.sub ? `<msub>${ml(n.base)}${ml(n.sub)}</msub>` : n.sup ? `<msup>${ml(n.base)}${ml(n.sup)}</msup>` : ml(n.base);
    case "pre":
      return `<mmultiscripts>${ml(n.base)}<mprescripts/>${n.sub ? ml(n.sub) : "<none/>"}${n.sup ? ml(n.sup) : "<none/>"}</mmultiscripts>`;
    case "nary": {
      const sign = `<mo largeop="true">${esc(n.chr)}</mo>`;
      const op = n.sub && n.sup ? `<${n.limits ? "munderover" : "msubsup"}>${sign}${ml(n.sub)}${ml(n.sup)}</${n.limits ? "munderover" : "msubsup"}>` : n.sub ? `<${n.limits ? "munder" : "msub"}>${sign}${ml(n.sub)}</${n.limits ? "munder" : "msub"}>` : n.sup ? `<${n.limits ? "mover" : "msup"}>${sign}${ml(n.sup)}</${n.limits ? "mover" : "msup"}>` : sign;
      return `<mrow>${op}${ml(n.e)}</mrow>`;
    }
    case "delim": {
      const parts: string[] = [];
      n.items.forEach((item, i) => {
        if (i > 0 && n.sep !== "") parts.push(`<mo separator="true">${esc(n.sep)}</mo>`);
        parts.push(ml(item));
      });
      return `<mrow>${n.open === "" ? "" : `<mo fence="true">${esc(n.open)}</mo>`}${parts.join("")}${n.close === "" ? "" : `<mo fence="true">${esc(n.close)}</mo>`}</mrow>`;
    }
    case "func":
      return `<mrow>${ml(n.name)}<mo>&#x2061;</mo>${ml(n.e)}</mrow>`;
    case "accent":
      return `<mover accent="true">${ml(n.e)}<mo>${esc(n.chr)}</mo></mover>`;
    case "bar":
      return n.top ? `<mover>${ml(n.e)}<mo>‾</mo></mover>` : `<munder>${ml(n.e)}<mo>_</mo></munder>`;
    case "under":
      return `<munder>${ml(n.e)}${ml(n.lim)}</munder>`;
    case "over":
      return `<mover>${ml(n.e)}${ml(n.lim)}</mover>`;
    case "matrix":
      return `<mtable>${n.rows.map((r) => `<mtr>${r.map((c) => `<mtd>${ml(c)}</mtd>`).join("")}</mtr>`).join("")}</mtable>`;
    case "eqarr":
      return `<mtable>${n.rows.map((r) => `<mtr><mtd>${ml(r)}</mtd></mtr>`).join("")}</mtable>`;
    case "group":
      return n.top ? `<mover>${ml(n.e)}<mo>${esc(n.chr)}</mo></mover>` : `<munder>${ml(n.e)}<mo>${esc(n.chr)}</mo></munder>`;
    case "phantom":
      return `<mphantom>${ml(n.e)}</mphantom>`;
    case "boxed":
      return `<menclose notation="box">${ml(n.e)}</menclose>`;
  }
}

// ---------------------------------------------------------------------------
// Word's own XML, kept
// ---------------------------------------------------------------------------

/** The elements of an equation that are kept in the copy of Word's own XML: every one that the reader above understands. */
const KEPT = new Set([
  "m:oMath", "m:r", "m:t", "m:rPr", "m:sty", "m:nor", "m:scr", "m:lit", "m:aln", "m:f", "m:fPr", "m:type", "m:num", "m:den", "m:rad", "m:radPr", "m:degHide", "m:deg", "m:e",
  "m:sSup", "m:sSupPr", "m:sup", "m:sSub", "m:sSubPr", "m:sub", "m:sSubSup", "m:sSubSupPr", "m:alnScr", "m:sPre", "m:sPrePr", "m:nary", "m:naryPr", "m:chr", "m:limLoc",
  "m:grow", "m:subHide", "m:supHide", "m:d", "m:dPr", "m:begChr", "m:endChr", "m:sepChr", "m:shp", "m:func", "m:funcPr", "m:fName", "m:acc", "m:accPr", "m:bar", "m:barPr",
  "m:pos", "m:limLow", "m:limLowPr", "m:lim", "m:limUpp", "m:limUppPr", "m:m", "m:mPr", "m:mcs", "m:mc", "m:mcPr", "m:count", "m:mcJc", "m:mr", "m:baseJc", "m:plcHide",
  "m:rSp", "m:rSpRule", "m:cGpRule", "m:cGp", "m:cSp", "m:eqArr", "m:eqArrPr", "m:maxDist", "m:objDist", "m:groupChr", "m:groupChrPr", "m:vertJc", "m:box", "m:boxPr",
  "m:borderBox", "m:borderBoxPr", "m:phant", "m:phantPr", "m:show", "m:zeroWid", "m:zeroAsc", "m:zeroDesc", "m:transp", "m:opEmu", "m:diff", "m:noBreak",
]);

const NS_M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

function serialize(el: XmlElement, out: string[]): void {
  if (!KEPT.has(el.name)) return; // not kept; its content was read or refused above, so a kept copy never holds what the reader did not
  const val = el.attrs["m:val"];
  // Text in an equation keeps its spaces; without this Word trims the ones at its ends.
  out.push(`<${el.name}${val !== undefined ? ` m:val="${esc(val).replace(/"/g, "&quot;")}"` : ""}${el.name === "m:t" ? ' xml:space="preserve"' : ""}>`);
  for (const c of el.children) {
    if (typeof c === "string") out.push(el.name === "m:t" ? esc(c) : "");
    else serialize(c, out);
  }
  out.push(`</${el.name}>`);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** One `m:oMath` as LaTeX, MathML and the kept original, or the reason it was not read. */
export function readEquation(el: XmlElement): MathResult {
  try {
    const node = new Reader().row(el, 0);
    const latex = tex(node).replace(/\s+/g, " ").trim();
    if (latex === "") return { ok: false, reason: "it is empty" };
    const kept: string[] = [];
    serialize(el, kept);
    const omml = kept.join("").replace("<m:oMath>", `<m:oMath xmlns:m="${NS_M}">`);
    return { ok: true, math: { latex, mathml: `<math xmlns="http://www.w3.org/1998/Math/MathML">${ml(node)}</math>`, omml } };
  } catch (error) {
    if (error instanceof Unread) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The most XML a stored equation may be before it is not trusted: a real one is a few kilobytes. */
const MAX_STORED_OMML = 200_000;

/**
 * Word's own XML for an equation as it is kept in a bank, read again and written out again. A bank is a file a person can edit by
 * hand, so what it holds as an equation is not put into a printed Word file as it stands: it goes through the reader that made it,
 * which accepts only the parts of an equation it knows and writes only those. Undefined when it is not an equation this reads.
 */
export function cleanOmml(stored: string): string | undefined {
  if (stored.length > MAX_STORED_OMML) return undefined;
  let root: XmlElement;
  try {
    root = parseXml(stored);
  } catch {
    return undefined;
  }
  if (root.name !== "m:oMath") return undefined;
  const read = readEquation(root);
  return read.ok ? read.math.omml : undefined;
}
