export type SyntaxTokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "tag" | "heading";

export type SyntaxToken = {
  kind: SyntaxTokenKind;
  value: string;
};

type SyntaxLanguage = "javascript" | "python" | "shell" | "markup" | "markdown" | "generic" | "plain";

const javascriptExtensions = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "json"]);
const pythonExtensions = new Set(["py", "pyi", "rb"]);
const shellExtensions = new Set(["sh", "bash", "zsh", "fish", "yaml", "yml", "toml"]);
const markupExtensions = new Set(["html", "htm", "xml", "svg", "vue", "svelte"]);
const markdownExtensions = new Set(["md", "mdx"]);
const genericCodeExtensions = new Set([
  "css", "scss", "less", "java", "kt", "kts", "go", "rs", "c", "h", "cc", "cpp", "cs", "php", "swift", "sql"
]);

const patterns: Record<Exclude<SyntaxLanguage, "plain">, RegExp> = {
  javascript:
    /(?<comment>\/\/.*|\/\*.*?\*\/)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<number>\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|(?<keyword>\b(?:as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|null|of|private|protected|public|return|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b)/gi,
  python:
    /(?<comment>#.*)|(?<string>""".*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield|end|module|require)\b)/g,
  shell:
    /(?<comment>#.*)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|set|then|while|true|false|null)\b)/g,
  markup:
    /(?<comment><!--.*?-->)|(?<tag><\/?[A-Za-z][^>]*>)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<number>\b\d+(?:\.\d+)?\b)/g,
  markdown:
    /(?<heading>^#{1,6}\s+|^>\s+|^\s*[-*+]\s+)|(?<string>`+[^`]+`+)|(?<tag>!?\[[^\]]*\]\([^)]*\))|(?<comment><!--.*?-->)/g,
  generic:
    /(?<comment>\/\/.*|\/\*.*?\*\/|--\s.*)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<number>\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|(?<keyword>\b(?:break|case|class|const|continue|default|delete|do|else|enum|false|finally|fn|for|func|function|if|import|interface|let|match|new|null|package|private|protected|public|return|select|static|struct|switch|this|throw|trait|true|try|type|var|void|where|while)\b)/gi
};

function extension(path: string): string {
  const fileName = path.split("/").at(-1) ?? path;
  const separator = fileName.lastIndexOf(".");
  return separator >= 0 ? fileName.slice(separator + 1).toLowerCase() : fileName.toLowerCase();
}

export function syntaxLanguageForPath(path: string): SyntaxLanguage {
  const ext = extension(path);
  if (javascriptExtensions.has(ext)) return "javascript";
  if (pythonExtensions.has(ext)) return "python";
  if (shellExtensions.has(ext) || ["dockerfile", "makefile"].includes(ext)) return "shell";
  if (markupExtensions.has(ext)) return "markup";
  if (markdownExtensions.has(ext)) return "markdown";
  if (genericCodeExtensions.has(ext)) return "generic";
  return "plain";
}

function tokenKind(match: RegExpMatchArray): SyntaxTokenKind {
  const groups = match.groups ?? {};
  if (groups.comment !== undefined) return "comment";
  if (groups.string !== undefined) return "string";
  if (groups.number !== undefined) return "number";
  if (groups.keyword !== undefined) return "keyword";
  if (groups.tag !== undefined) return "tag";
  if (groups.heading !== undefined) return "heading";
  return "plain";
}

export function highlightDiffSyntax(path: string, content: string): SyntaxToken[] {
  const language = syntaxLanguageForPath(path);
  if (language === "plain" || !content) {
    return [{ kind: "plain", value: content }];
  }

  const tokens: SyntaxToken[] = [];
  let offset = 0;
  for (const match of content.matchAll(patterns[language])) {
    const index = match.index ?? offset;
    if (index > offset) {
      tokens.push({ kind: "plain", value: content.slice(offset, index) });
    }
    tokens.push({ kind: tokenKind(match), value: match[0] });
    offset = index + match[0].length;
  }
  if (offset < content.length) {
    tokens.push({ kind: "plain", value: content.slice(offset) });
  }
  return tokens.length ? tokens : [{ kind: "plain", value: content }];
}
