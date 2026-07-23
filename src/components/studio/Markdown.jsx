/**
 * Minimal dependency-free markdown renderer for Studio draft previews.
 * Handles: h1–h4, bold, italic, links, inline code, ul/ol, tables,
 * blockquotes, hr, paragraphs. Enough for pipeline output — not a general
 * markdown engine.
 */

function renderInline(text, keyBase) {
  const parts = [];
  let rest = text;
  let key = 0;
  // Tokenize links, bold, italic, inline code in one pass.
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/;
  while (rest.length > 0) {
    const m = rest.match(re);
    if (!m) {
      parts.push(rest);
      break;
    }
    if (m.index > 0) parts.push(rest.slice(0, m.index));
    const k = `${keyBase}-${key++}`;
    if (m[1] !== undefined) {
      parts.push(
        <a
          key={k}
          href={m[2]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--info)", textDecoration: "underline" }}
        >
          {m[1]}
        </a>
      );
    } else if (m[3] !== undefined) {
      parts.push(<strong key={k}>{m[3]}</strong>);
    } else if (m[4] !== undefined) {
      parts.push(<em key={k}>{m[4]}</em>);
    } else if (m[5] !== undefined) {
      parts.push(
        <code
          key={k}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.9em",
            background: "var(--bg-2)",
            padding: "1px 5px",
            borderRadius: "3px",
          }}
        >
          {m[5]}
        </code>
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return parts;
}

const cellStyle = {
  border: "1px solid var(--border-1)",
  padding: "8px 12px",
  fontSize: "13px",
  textAlign: "left",
  verticalAlign: "top",
};

export function Markdown({ children }) {
  const src = String(children || "");
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const sizes = { 1: "22px", 2: "17px", 3: "15px", 4: "13px" };
      const Tag = `h${level}`;
      blocks.push(
        <Tag
          key={key++}
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: sizes[level],
            fontWeight: 600,
            color: "var(--text-1)",
            marginTop: level === 1 ? "0" : "var(--space-6)",
            marginBottom: "var(--space-3)",
            letterSpacing: "-0.01em",
          }}
        >
          {renderInline(h[2], `h${key}`)}
        </Tag>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(
        <hr key={key++} style={{ border: "none", borderTop: "1px solid var(--border-1)", margin: "var(--space-5) 0" }} />
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          style={{
            borderLeft: "3px solid var(--accent)",
            padding: "var(--space-2) var(--space-4)",
            margin: "var(--space-3) 0",
            color: "var(--text-2)",
            fontStyle: "italic",
            fontSize: "13px",
          }}
        >
          {renderInline(quote.join(" "), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const parseRow = (l) =>
        l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} style={{ overflowX: "auto", margin: "var(--space-4) 0" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} style={{ ...cellStyle, background: "var(--bg-2)", fontWeight: 600, color: "var(--text-1)" }}>
                    {renderInline(c, `th${key}-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={{ ...cellStyle, color: "var(--text-2)" }}>
                      {renderInline(c, `td${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Lists
    const isUl = /^\s*[-*]\s+/.test(line);
    const isOl = /^\s*\d+[.)]\s+/.test(line);
    if (isUl || isOl) {
      const items = [];
      const pattern = isUl ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(lines[i].replace(pattern, ""));
        i++;
      }
      const ListTag = isUl ? "ul" : "ol";
      blocks.push(
        <ListTag
          key={key++}
          style={{
            margin: "var(--space-3) 0",
            paddingLeft: "22px",
            listStyle: isUl ? "disc" : "decimal",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          {items.map((it, ii) => (
            <li key={ii} style={{ fontSize: "13px", color: "var(--text-2)", lineHeight: 1.6 }}>
              {renderInline(it, `li${key}-${ii}`)}
            </li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Paragraph — swallow consecutive non-empty, non-special lines
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !(lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && lines[i + 1].includes("|"))
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) {
      blocks.push(
        <p key={key++} style={{ fontSize: "13px", color: "var(--text-2)", lineHeight: 1.7, margin: "var(--space-3) 0" }}>
          {renderInline(para.join(" "), `p${key}`)}
        </p>
      );
    } else {
      i++;
    }
  }

  return <div>{blocks}</div>;
}
