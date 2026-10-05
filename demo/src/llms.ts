import { MediaInfo } from "@usecds/client";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { LANGUAGE_NAMES } from "./site.js";

const IMAGE_DESCRIPTION: Record<string, string> = { en: "Image description", de: "Bildbeschreibung" };

export interface LlmsPage {
  locale: string;
  path: string; // route path
  title: string;
  html: string;
  images: Map<string, MediaInfo>; // output file (from the root) -> media shown
}

/**
 * Builds llms.txt (llmstxt.org): site name and summary, then one section per page and language,
 * converted from the rendered HTML to Markdown. Navigation is left out; each image is followed by
 * its description from the _media collection, which the HTML itself doesn't contain.
 */
export function renderLlmsTxt(pages: LlmsPage[], site: { title: string; summary: string }, releaseId: string): string {
  const sections = pages.map((page) => {
    const body = page.html
      .replace(/^[\s\S]*?<main[^>]*>/, "")
      .replace(/<\/main>[\s\S]*$/, ""); // only the page content: no head, menu, switcher or footer
    const converted = NodeHtmlMarkdown.translate(body)
      // Nest the page's headings below the page heading
      .replace(/^(#{1,4}) /gm, "##$1 ");
    // Add each source image's description once, unless the page already shows it (e.g. as a caption)
    const described = new Set<string>();
    const markdown = converted
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, _alt, src: string) => {
        const image = page.images.get(src.replace(/^(\.\.\/)+|^\//, ""));
        if (!image?.description || described.has(image.path) || converted.includes(image.description)) return match;
        described.add(image.path);
        const label = IMAGE_DESCRIPTION[page.locale] ?? IMAGE_DESCRIPTION.en;
        return `${match}\n\n*${label}: ${image.description}*\n`;
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return `## ${page.title} (${LANGUAGE_NAMES[page.locale] ?? page.locale}, ${page.path})\n\n${markdown}`;
  });

  const languages = [...new Set(pages.map((p) => LANGUAGE_NAMES[p.locale] ?? p.locale))].join(", ");
  return [
    `# ${site.title}`,
    `> ${site.summary}`,
    `Text of every page of this site for language models, with descriptions of all images. Languages: ${languages}. Generated from release ${releaseId}.`,
    ...sections
  ].join("\n\n") + "\n";
}
