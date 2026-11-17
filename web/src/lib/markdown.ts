import DOMPurify from "dompurify";
import { marked } from "marked";

export interface LinkResolver {
  /** An in-app URL for a repository-relative link, like "docs/setup.md". */
  link: (path: string) => string;
  /** A raw-file URL for a repository-relative image. */
  image: (path: string) => string;
}

const EXTERNAL = /^[a-z][a-z\d+.-]*:|^\/\//i;

/** Resolves `target` against the README's directory. A leading "/" means the repository root, as on GitHub. */
export function resolvePath(dir: string, target: string): string {
  const parts = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function decode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function splitSuffix(target: string): [string, string] {
  const index = target.search(/[?#]/);
  return index === -1
    ? [target, ""]
    : [target.slice(0, index), target.slice(index)];
}

/**
 * Markdown from a repository is untrusted. marked renders it, DOMPurify keeps only inert HTML,
 * and relative links and images are pointed at this site's routes.
 */
export function renderMarkdown(
  source: string,
  dir: string,
  resolve: LinkResolver,
): string {
  const purify = DOMPurify();
  if (!purify.isSupported) return `<pre>${escapeHtml(source)}</pre>`;
  const html = marked.parse(source, { async: false, gfm: true });
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const target = node.getAttribute("href") ?? "";
      if (EXTERNAL.test(target)) {
        node.setAttribute("rel", "noopener noreferrer nofollow");
        node.setAttribute("target", "_blank");
      } else if (target && !target.startsWith("#")) {
        const [path, suffix] = splitSuffix(target);
        node.setAttribute(
          "href",
          resolve.link(resolvePath(dir, decode(path))) +
            suffix.replace(/^\?[^#]*/, ""),
        );
      }
    }
    if (node.tagName === "INPUT") {
      if (node.getAttribute("type") !== "checkbox") node.remove();
      else node.setAttribute("disabled", "");
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (src && !EXTERNAL.test(src))
        node.setAttribute(
          "src",
          resolve.image(resolvePath(dir, decode(splitSuffix(src)[0]))),
        );
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
  });
  return purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "iframe"],
    FORBID_ATTR: ["style"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|#|[^:]*$)/i,
  });
}
