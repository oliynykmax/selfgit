import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { blobUrl, rawUrl } from "./selfgit";

const EXTERNAL = /^[a-z][a-z\d+.-]*:|^\/\//i;

function resolvePath(dir: string, target: string): string {
  const parts = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function splitSuffix(target: string): [string, string] {
  const index = target.search(/[?#]/);
  return index === -1
    ? [target, ""]
    : [target.slice(0, index), target.slice(index)];
}

function decode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function renderMarkdown(
  source: string,
  repo: string,
  oid: string,
  filePath: string,
): string {
  const dir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";
  const html = marked.parse(source, { async: false, gfm: true });
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "input",
      "details",
      "summary",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel", "title"],
      img: [
        "src",
        "alt",
        "title",
        "width",
        "height",
        "loading",
        "referrerpolicy",
      ],
      input: ["type", "checked", "disabled"],
      code: ["class"],
      span: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? "";
        if (EXTERNAL.test(href))
          return {
            tagName,
            attribs: {
              ...attribs,
              rel: "noopener noreferrer nofollow",
              target: "_blank",
            },
          };
        if (!href || href.startsWith("#")) return { tagName, attribs };
        const [path, suffix] = splitSuffix(href);
        return {
          tagName,
          attribs: {
            ...attribs,
            href:
              blobUrl(repo, oid, resolvePath(dir, decode(path))) +
              suffix.replace(/^\?[^#]*/, ""),
          },
        };
      },
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        const [path] = splitSuffix(src);
        return {
          tagName,
          attribs: {
            ...attribs,
            src:
              src && !EXTERNAL.test(src)
                ? rawUrl(repo, oid, resolvePath(dir, decode(path)))
                : src,
            loading: "lazy",
            referrerpolicy: "no-referrer",
          },
        };
      },
      input: (tagName, attribs) => {
        if (attribs.type !== "checkbox")
          return { tagName: "span", attribs: {} };
        const next: Record<string, string> = {
          type: "checkbox",
          disabled: "disabled",
        };
        if (attribs.checked) next.checked = attribs.checked;
        return { tagName, attribs: next };
      },
    },
  });
}
