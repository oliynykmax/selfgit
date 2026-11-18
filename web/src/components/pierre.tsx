import { processPatch } from "@pierre/diffs";
import { File, FileDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import type { FileDiff as ApiFileDiff } from "../../../src/api-types";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DiffStyle = "unified" | "split";

function useThemeType(): "light" | "dark" {
  const getTheme = () =>
    document.documentElement.classList.contains("dark") ? "dark" : "light";
  const [theme, setTheme] = useState<"light" | "dark">(getTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

function useCodeOptions(wrap: boolean) {
  const themeType = useThemeType();
  return useMemo(
    () => ({
      disableFileHeader: true,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      themeType,
      unsafeCSS: `
        :host {
          --diffs-font-family: "JetBrains Mono Variable", ui-monospace, monospace;
          --diffs-font-size: 12px;
          --diffs-line-height: 20px;
        }
      `,
    }),
    [themeType, wrap],
  );
}

export function CodeFile({
  name,
  contents,
  cacheKey,
}: {
  name: string;
  contents: string;
  cacheKey: string;
}) {
  const [wrap, setWrap] = useState(false);
  const options = useCodeOptions(wrap);
  const file = useMemo(
    () => ({ name, contents, cacheKey }),
    [cacheKey, contents, name],
  );
  return (
    <>
      <div className="flex justify-end border-b bg-muted/20 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setWrap((current) => !current)}
          aria-pressed={wrap}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {wrap ? "Unwrap lines" : "Wrap lines"}
        </button>
      </div>
      <File file={file} options={options} className="block" />
    </>
  );
}

function patchFor(file: ApiFileDiff): string {
  const oldPath = file.status === "added" ? "/dev/null" : `a/${file.path}`;
  const newPath = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
  const lines = file.hunks.flatMap((hunk) => [
    hunk.header,
    ...hunk.lines.map(
      (line) =>
        `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`,
    ),
  ]);
  return [
    `diff --git a/${file.path} b/${file.path}`,
    ...(file.status === "added" ? ["new file mode 100644"] : []),
    ...(file.status === "deleted" ? ["deleted file mode 100644"] : []),
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...lines,
    "",
  ].join("\n");
}

export function CommitDiff({
  file,
  cacheKey,
  style,
  wrap,
}: {
  file: ApiFileDiff;
  cacheKey: string;
  style: DiffStyle;
  wrap: boolean;
}) {
  const codeOptions = useCodeOptions(wrap);
  const fileDiff = useMemo(() => {
    const parsed = processPatch(patchFor(file), { throwOnError: true })
      .files[0];
    if (!parsed) throw new Error(`Could not parse diff for ${file.path}`);
    parsed.cacheKey = cacheKey;
    return parsed;
  }, [cacheKey, file]);
  const options = useMemo(
    () => ({
      ...codeOptions,
      diffStyle: style,
      hunkSeparators: "line-info-basic" as const,
      lineDiffType: "word-alt" as const,
    }),
    [codeOptions, style],
  );
  return <FileDiff fileDiff={fileDiff} options={options} className="block" />;
}

export function DiffDisplayControls({
  style,
  wrap,
  onStyleChange,
  onWrapChange,
}: {
  style: DiffStyle;
  wrap: boolean;
  onStyleChange: (style: DiffStyle) => void;
  onWrapChange: (wrap: boolean) => void;
}) {
  return (
    <div className="ml-auto flex items-center gap-1" aria-label="Diff display">
      <div
        className="flex rounded-md border p-0.5"
        role="group"
        aria-label="Diff layout"
      >
        {(["unified", "split"] as const).map((next) => (
          <button
            key={next}
            type="button"
            aria-pressed={style === next}
            onClick={() => onStyleChange(next)}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "h-7 px-2 text-xs capitalize",
              style === next && "bg-muted",
            )}
          >
            {next}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={wrap}
        onClick={() => onWrapChange(!wrap)}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "h-7 px-2 text-xs",
          wrap && "bg-muted",
        )}
      >
        Wrap
      </button>
    </div>
  );
}
