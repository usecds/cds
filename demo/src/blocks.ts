import { CDSClient, CollectionItem, MediaInfo, ResolvedBlock, ResolvedPage, ResolvedLink } from "@cds/client";
import { Point } from "@cds/imaging";
import { ImageContract, PageImages } from "./images.js";
import { escapeHtml } from "./paths.js";

// Everything a block renderer needs; the generator mode decides how links and assets are written
export interface RenderContext {
  client: CDSClient;
  locale: string;
  routePath: string;
  releaseId: string;
  contract: ImageContract;
  images: PageImages;
  href: (sitePath: string) => string; // site path (+#anchor) or external URL -> link for this page
  picture: (info: MediaInfo, preset: string, imgClass: string, page: PageImages, crop?: { focalPoint?: Point; zoom?: number }) => Promise<string>;
}

type BlockRenderer = (block: ResolvedBlock, ctx: RenderContext) => Promise<string>;

const t = (item: CollectionItem, locale: string) => item.translations[locale] ?? {};

const sectionHeader = (block: ResolvedBlock, wide = false) =>
  block.texts.title || block.texts.intro
    ? `<div class="text-center mb-12">
                ${block.texts.title ? `<h2 class="text-3xl font-bold text-white mb-4">${block.texts.title}</h2>` : ""}
                ${block.texts.intro ? `<p class="text-slate-400 ${wide ? "max-w-3xl" : "max-w-2xl"} mx-auto leading-relaxed">${block.texts.intro}</p>` : ""}
            </div>`
    : "";

const section = (block: ResolvedBlock, inner: string, tone = "bg-slate-950") =>
  `<section id="${block.key}" class="py-20 ${tone} border-b border-slate-900"><div class="max-w-6xl mx-auto px-6">${inner}</div></section>`;

const links = (block: ResolvedBlock, ctx: RenderContext): (ResolvedLink & { href: string })[] =>
  block.links
    .map((id) => ctx.client.resolveLink(id, ctx.locale))
    .filter((l): l is ResolvedLink & { href: string } => !!l?.href)
    .map((l) => ({ ...l, href: ctx.href(l.href) }));

const renderers: Record<string, BlockRenderer> = {
  // Hero: texts from the referenced settings item, image and call-to-action links from the block
  async hero(block, ctx) {
    const settings = block.items[0] ? t(block.items[0].item, ctx.locale) : {};
    const image = block.media[0] ? ctx.client.getMediaInfo(block.media[0], ctx.locale) : null;
    const picture = image ? await ctx.picture(image, (block.settings.preset as string) ?? "hero", "w-full h-auto rounded-2xl border border-slate-800", ctx.images) : "";
    const [primary, ...others] = links(block, ctx);
    const button = (l: { href: string; label: string; external: boolean }, style: string) =>
      `<a href="${l.href}"${l.external ? ' target="_blank" rel="noopener"' : ""} class="w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold transition-all text-center ${style}">${l.label}</a>`;
    return `<section id="${block.key}" class="relative overflow-hidden py-24 lg:py-32 border-b border-slate-900 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-teal-950/20 via-slate-950 to-slate-950">
        <div class="max-w-4xl mx-auto text-center px-6 relative z-10">
            <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-teal-500/10 text-teal-400 border border-teal-500/20 mb-6">${block.texts.badge ?? ""}: ${ctx.releaseId}</span>
            <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight text-white mb-6 leading-tight">${settings.heroTitle ?? ""}</h1>
            <p class="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">${settings.heroSubtitle ?? ""}</p>
            ${picture ? `<figure class="mb-10">${picture}</figure>` : ""}
            <div class="flex flex-col sm:flex-row justify-center items-center gap-4">
                ${primary ? button(primary, "bg-gradient-to-r from-teal-500 to-blue-600 hover:from-teal-400 hover:to-blue-500 text-slate-950 shadow-lg shadow-teal-500/20") : ""}
                ${others.map((l) => button(l, "bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 hover:border-slate-700")).join("")}
            </div>
        </div>
    </section>`;
  },

  async "page-header"(block) {
    return `<section id="${block.key}" class="py-20 border-b border-slate-900 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-teal-950/20 via-slate-950 to-slate-950">
        <div class="max-w-4xl mx-auto text-center px-6">
            <h1 class="text-4xl sm:text-5xl font-extrabold tracking-tight text-white mb-6">${block.texts.title ?? ""}</h1>
            <p class="text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">${block.texts.intro ?? ""}</p>
        </div>
    </section>`;
  },

  // Steps of a process, from a collection with icon, title, text and an optional badge
  async steps(block, ctx) {
    const steps = block.items.map(({ item }) => {
      const s = t(item, ctx.locale);
      const highlighted = !!s.badge;
      return `<div class="${highlighted ? "bg-gradient-to-b from-teal-950/40 to-blue-950/40 border-teal-500/30 relative" : "bg-slate-900 border-slate-800"} p-6 rounded-2xl border text-center">
                    ${highlighted ? `<div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-teal-500 text-slate-950 text-[10px] uppercase font-bold px-2 py-0.5 rounded">${s.badge}</div>` : ""}
                    <span class="text-3xl">${item.icon ?? ""}</span>
                    <h3 class="font-bold ${highlighted ? "text-teal-400" : "text-white"} mt-3 mb-1">${s.title ?? ""}</h3>
                    <p class="text-xs ${highlighted ? "text-slate-300" : "text-slate-400"}">${s.text ?? ""}</p>
                </div>`;
    });
    const arrow = `<div class="text-center text-teal-500 font-bold rotate-90 md:rotate-0" aria-hidden="true">➔</div>`;
    return section(block, `${sectionHeader(block)}
            <div class="grid grid-cols-1 md:grid-cols-${steps.length * 2 - 1} gap-4 items-center bg-slate-900/40 p-8 rounded-3xl border border-slate-800">${steps.join(arrow)}</div>`);
  },

  // One image (language-specific media works through translations[locale].media)
  async image(block, ctx) {
    const info = block.media[0] ? ctx.client.getMediaInfo(block.media[0], ctx.locale) : null;
    if (!info) return "";
    const picture = await ctx.picture(info, (block.settings.preset as string) ?? "content", "w-full h-auto rounded-2xl border border-slate-800 bg-white", ctx.images);
    const caption = block.settings.caption === "description" ? info.description : undefined;
    return section(block, `${sectionHeader(block)}
            <figure>${picture}${caption ? `<figcaption class="text-sm text-slate-500 mt-3 text-center">${caption}</figcaption>` : ""}</figure>`, "bg-slate-950/50");
  },

  async "card-grid"(block, ctx) {
    const cards = block.items.map(({ item }) => {
      const s = t(item, ctx.locale);
      return `<div class="p-8 rounded-2xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-colors">
                    <h3 class="text-xl font-bold text-teal-400 mb-3">${s.title ?? ""}</h3>
                    <p class="text-slate-400 leading-relaxed text-sm">${s.description ?? ""}</p>
                </div>`;
    });
    return section(block, `${sectionHeader(block)}<div class="grid grid-cols-1 md:grid-cols-2 gap-8">${cards.join("")}</div>`, "bg-slate-950/50");
  },

  async "icon-list"(block, ctx) {
    const entries = block.items.map(({ item }) => {
      const s = t(item, ctx.locale);
      return `<div class="p-6 rounded-2xl bg-slate-900 border border-slate-800/60 flex flex-col items-center text-center">
                    <span class="text-4xl mb-4">${s.icon || "🎯"}</span>
                    <h3 class="font-semibold text-white text-base leading-snug">${s.title ?? ""}</h3>
                </div>`;
    });
    return section(block, `${sectionHeader(block)}<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">${entries.join("")}</div>`);
  },

  async quotes(block, ctx) {
    const quotes = block.items.map(({ item }) => {
      const s = t(item, ctx.locale);
      return `<div class="p-8 rounded-2xl bg-slate-900/30 border border-slate-800/80 italic flex flex-col justify-between">
                    <p class="text-slate-300 text-lg mb-6 leading-relaxed">"${s.quote ?? ""}"</p>
                    <div class="flex items-center space-x-3 not-italic">
                        <div class="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center font-bold text-teal-400" aria-hidden="true">${(s.author ?? "?")[0]}</div>
                        <div>
                            <div class="font-bold text-white text-sm">${s.author ?? ""}</div>
                            <div class="text-xs text-slate-500">${s.role ?? ""}</div>
                        </div>
                    </div>
                </div>`;
    });
    return section(block, `${sectionHeader(block)}<div class="grid grid-cols-1 md:grid-cols-2 gap-8">${quotes.join("")}</div>`, "bg-slate-950/50");
  },

  async note(block) {
    return `<section id="${block.key}" class="pt-16 bg-slate-950"><div class="max-w-3xl mx-auto px-6">
            <div class="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm leading-relaxed">
                <span class="inline-block text-[10px] uppercase font-bold tracking-wide text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-0.5 mb-2">${block.texts.badge ?? ""}</span>
                <p class="text-slate-300">${block.texts.text ?? ""}</p>
            </div>
        </div></section>`;
  },

  // One stored image in several crops; settings.crops: [{ preset, focus (named focal point), zoom }]
  async "image-crops"(block, ctx) {
    const info = block.media[0] ? ctx.client.getMediaInfo(block.media[0], ctx.locale) : null;
    const crops = (block.settings.crops as { preset: string; focus: string; zoom?: number }[] | undefined) ?? [];
    if (!info?.focalPoints || crops.length === 0) return "";
    const spans = ["md:col-span-5", "md:col-span-3", "md:col-span-2"];
    const figures: string[] = [];
    for (const [i, crop] of crops.entries()) {
      const picture = await ctx.picture(info, crop.preset, "w-full h-auto rounded-2xl border border-slate-800", ctx.images, {
        focalPoint: info.focalPoints[crop.focus],
        zoom: crop.zoom
      });
      const aspect = ctx.contract.presets?.[crop.preset]?.aspect ?? "";
      figures.push(`<figure class="${spans[i] ?? "md:col-span-5"}">${picture}
                    <figcaption class="text-xs code-font text-slate-500 mt-2">${crop.preset} ${aspect} · focus: ${crop.focus} · zoom ${crop.zoom ?? 1}</figcaption>
                </figure>`);
    }
    return section(block, `${sectionHeader(block)}<div class="grid grid-cols-1 md:grid-cols-5 gap-6 items-start">${figures.join("")}</div>`);
  },

  // Generator block: costs of the images rendered on this page (rendered after the other blocks)
  async "image-report"(block, ctx) {
    const reports = ctx.images.reports;
    const labels = (block.texts.labels ?? {}) as Record<string, string>;
    const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    const sum = (key: "variants" | "storedBytes" | "renderMs" | "originalBytes" | "desktopBytes" | "mobileBytes") =>
      reports.reduce((n, r) => n + r[key], 0);
    const num = "px-4 py-3 text-right whitespace-nowrap";
    const breakpoints = Object.keys(ctx.contract.breakpoints ?? {}).join(", ");
    const dpr = (ctx.contract.dpr ?? [1]).map((d) => `${d}x`).join(", ");
    return section(block, `${sectionHeader(block, true)}
            <p class="text-xs text-slate-500 text-center -mt-8 mb-8 code-font">breakpoints: ${breakpoints} · dpr: ${dpr}</p>
            <div class="overflow-x-auto rounded-2xl border border-slate-800">
                <table class="w-full text-sm text-left">
                    <thead class="bg-slate-900 text-slate-400 text-xs uppercase tracking-wide"><tr>
                        <th class="px-4 py-3">${labels.image ?? ""}</th><th class="px-4 py-3">${labels.preset ?? ""}</th>
                        <th class="${num}">${labels.variants ?? ""}</th><th class="px-4 py-3">${labels.formats ?? ""}</th>
                        <th class="${num}">${labels.stored ?? ""}</th><th class="${num}">${labels.renderTime ?? ""}</th>
                        <th class="${num}">${labels.original ?? ""}</th><th class="${num}">${labels.desktop ?? ""}</th><th class="${num}">${labels.mobile ?? ""}</th>
                    </tr></thead>
                    <tbody class="divide-y divide-slate-800 text-slate-300">${reports.map((r) => `<tr>
                        <td class="px-4 py-3 code-font text-xs">${escapeHtml(r.path)}</td><td class="px-4 py-3">${r.preset}</td>
                        <td class="${num}">${r.variants}</td><td class="px-4 py-3 code-font text-xs">${r.formats}</td>
                        <td class="${num}">${kb(r.storedBytes)}</td><td class="${num}">${r.renderMs} ms</td><td class="${num}">${kb(r.originalBytes)}</td>
                        <td class="${num} text-teal-400">${kb(r.desktopBytes)}</td><td class="${num} text-teal-400">${kb(r.mobileBytes)}</td>
                    </tr>`).join("")}</tbody>
                    <tfoot class="bg-slate-900 text-white font-semibold"><tr>
                        <td class="px-4 py-3" colspan="2">${block.texts.total ?? ""}</td><td class="${num}">${sum("variants")}</td><td class="px-4 py-3"></td>
                        <td class="${num}">${kb(sum("storedBytes"))}</td><td class="${num}">${sum("renderMs")} ms</td><td class="${num}">${kb(sum("originalBytes"))}</td>
                        <td class="${num} text-teal-400">${kb(sum("desktopBytes"))}</td><td class="${num} text-teal-400">${kb(sum("mobileBytes"))}</td>
                    </tr></tfoot>
                </table>
            </div>
            <p class="text-xs text-slate-500 mt-3">${block.texts.note ?? ""}</p>`, "bg-slate-950/50");
  },

  // Generator block: what the client has cached
  async "release-log"(block, ctx) {
    const log = JSON.stringify({
      activeReleaseId: ctx.releaseId,
      schemaVersion: 1,
      loadedCollections: ctx.client.getCollectionsList(),
      syncedLocales: ctx.client.getLocales()
    }, null, 2);
    return `<section id="${block.key}" class="py-20 bg-slate-950"><div class="max-w-4xl mx-auto px-6">
            <div class="bg-slate-900 rounded-3xl border border-slate-800 p-8 shadow-2xl">
                <span class="text-xs code-font text-slate-400">cds-client-logger --active-cache</span>
                <h2 class="text-lg font-bold text-white mt-4 mb-3">${block.texts.title ?? ""}</h2>
                <p class="text-slate-400 text-sm mb-6 leading-relaxed">${block.texts.intro ?? ""}</p>
                <pre class="bg-slate-950 p-4 rounded-xl text-xs code-font text-teal-400 overflow-x-auto border border-slate-800"><code>${escapeHtml(log)}</code></pre>
            </div>
        </div></section>`;
  }
};

// Blocks that summarize what other blocks rendered go last
const DEFERRED = new Set(["image-report"]);

/**
 * Renders a page's blocks in order. Unknown block types are skipped with a warning.
 */
export async function renderBlocks(page: ResolvedPage, ctx: RenderContext): Promise<string> {
  const html: string[] = new Array(page.blocks.length).fill("");
  const render = async (block: ResolvedBlock, i: number) => {
    const renderer = renderers[block.type];
    if (!renderer) {
      console.log(`⚠️  [Generator] No renderer for block type "${block.type}" (${block.id})`);
      return;
    }
    html[i] = await renderer(block, ctx);
  };
  for (const [i, block] of page.blocks.entries()) if (!DEFERRED.has(block.type)) await render(block, i);
  for (const [i, block] of page.blocks.entries()) if (DEFERRED.has(block.type)) await render(block, i);
  return html.join("\n");
}
